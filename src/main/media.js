'use strict';
// Turns Steam's DASH clip folders into single playable MP4s, and makes small
// thumbnails for screenshots. Everything lands in the app cache directory;
// the source folders are opened read-only and never written to.
//
// A clip is stored as separate video and audio fMP4 segment streams. Rather
// than concatenating to temp files first (which costs an extra full read and
// write of the video), the video segments stream straight into ffmpeg's
// stdin and stream-copy. The audio track is tiny, so that one does go to a
// small temp file - ffmpeg can only take one piped input.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');
const { spawn, execFile } = require('child_process');

const READ_CHUNK = 1 << 22; // 4 MiB reads keep the pipe saturated

function which(cmd) {
  return new Promise((resolve) => {
    execFile(process.platform === 'win32' ? 'where' : 'which', [cmd], { windowsHide: true }, (err, stdout) => {
      if (err) return resolve(null);
      const first = String(stdout).split(/\r?\n/).find((l) => l.trim());
      resolve(first ? first.trim() : null);
    });
  });
}

/**
 * Where a bundled ffmpeg lives: next to the packaged app's resources, or in
 * vendor/ when running from source.
 */
function bundledDirs() {
  const dirs = [];
  if (process.resourcesPath) dirs.push(path.join(process.resourcesPath, 'ffmpeg'));
  dirs.push(path.join(__dirname, '..', '..', 'vendor', 'ffmpeg'));
  return dirs;
}

/** True when this path is the copy shipped with the app. */
function isBundled(ffmpegPath) {
  if (!ffmpegPath) return false;
  const resolved = path.resolve(ffmpegPath).toLowerCase();
  return bundledDirs().some((dir) => resolved.startsWith(path.resolve(dir).toLowerCase()));
}

/** Locates ffmpeg/ffprobe: explicit override, then bundled, then PATH. */
async function locateFfmpeg(override) {
  const check = async (p) => {
    if (!p) return null;
    try {
      await fsp.access(p, fs.constants.X_OK);
      return p;
    } catch {
      return null;
    }
  };

  const exe = process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg';

  if (override) {
    const direct = await check(override);
    if (direct) return direct;
    const inDir = await check(path.join(override, exe));
    if (inDir) return inDir;
  }

  // The copy shipped with the app wins over whatever is on PATH, so a packaged
  // build behaves the same on every machine.
  for (const dir of bundledDirs()) {
    const bundled = await check(path.join(dir, exe));
    if (bundled) return bundled;
  }

  const onPath = await which('ffmpeg');
  if (onPath) return onPath;

  const guesses = [];
  const local = process.env.LOCALAPPDATA;
  if (local) {
    // winget keeps a versioned folder name, so glob for it.
    const wingetRoot = path.join(local, 'Microsoft', 'WinGet', 'Packages');
    try {
      for (const d of fs.readdirSync(wingetRoot)) {
        if (!/ffmpeg/i.test(d)) continue;
        const pkg = path.join(wingetRoot, d);
        for (const inner of fs.readdirSync(pkg)) {
          guesses.push(path.join(pkg, inner, 'bin', 'ffmpeg.exe'));
        }
        guesses.push(path.join(pkg, 'ffmpeg.exe'));
      }
    } catch {
      /* winget not used */
    }
  }
  guesses.push(
    'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
    'C:\\ffmpeg\\bin\\ffmpeg.exe',
    '/usr/bin/ffmpeg',
    '/usr/local/bin/ffmpeg',
    '/opt/homebrew/bin/ffmpeg',
  );

  for (const g of guesses) {
    const hit = await check(g);
    if (hit) return hit;
  }
  return null;
}

function siblingFfprobe(ffmpegPath) {
  if (!ffmpegPath) return null;
  const dir = path.dirname(ffmpegPath);
  const name = process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe';
  const candidate = path.join(dir, name);
  return fs.existsSync(candidate) ? candidate : null;
}

function shortHash(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 16);
}

class MediaPipeline {
  /**
   * @param {string} cacheDir writable cache root
   * @param {{ffmpegPath?: string, maxCacheBytes?: number}} opts
   */
  constructor(cacheDir, opts = {}) {
    this.cacheDir = cacheDir;
    this.clipDir = path.join(cacheDir, 'clips');
    this.thumbDir = path.join(cacheDir, 'thumbs');
    this.tmpDir = path.join(cacheDir, 'tmp');
    this.ffmpegOverride = opts.ffmpegPath || null;
    this.maxCacheBytes = opts.maxCacheBytes || 12 * 1024 * 1024 * 1024;
    this.ffmpeg = null;
    this.ffprobe = null;
    this.jobs = new Map(); // clip id -> in-flight promise
    this.cancelled = new Set();
  }

  async init() {
    await Promise.all([
      fsp.mkdir(this.clipDir, { recursive: true }),
      fsp.mkdir(this.thumbDir, { recursive: true }),
      fsp.mkdir(this.tmpDir, { recursive: true }),
    ]);
    // Clear anything a previous run died partway through.
    try {
      for (const f of await fsp.readdir(this.tmpDir)) {
        await fsp.rm(path.join(this.tmpDir, f), { recursive: true, force: true });
      }
    } catch {
      /* nothing to clean */
    }
    await this.refreshFfmpeg();
  }

  async refreshFfmpeg(override) {
    if (override !== undefined) this.ffmpegOverride = override || null;
    this.ffmpeg = await locateFfmpeg(this.ffmpegOverride);
    this.ffprobe = siblingFfprobe(this.ffmpeg);
    return this.ffmpeg;
  }

  get hasFfmpeg() {
    return Boolean(this.ffmpeg);
  }

  /** Where the ffmpeg in use came from, for the settings screen. */
  get ffmpegSource() {
    if (!this.ffmpeg) return 'missing';
    if (this.ffmpegOverride) return 'custom';
    return isBundled(this.ffmpeg) ? 'bundled' : 'system';
  }

  runFfmpeg(args, { onProgress, totalDuration, stdinFeeder } = {}) {
    return new Promise((resolve, reject) => {
      if (!this.ffmpeg) return reject(new Error('ffmpeg not found'));

      const proc = spawn(this.ffmpeg, ['-hide_banner', '-nostdin', ...args], {
        stdio: [stdinFeeder ? 'pipe' : 'ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let stderr = '';
      let killed = false;

      proc.stderr.on('data', (d) => {
        stderr += d.toString();
        if (stderr.length > 64000) stderr = stderr.slice(-32000);
      });

      if (onProgress) {
        let buf = '';
        proc.stdout.on('data', (d) => {
          buf += d.toString();
          const lines = buf.split('\n');
          buf = lines.pop() || '';
          for (const line of lines) {
            const m = /^out_time_us=(\d+)/.exec(line.trim());
            if (m && totalDuration > 0) {
              onProgress(Math.min(0.999, Number(m[1]) / 1e6 / totalDuration));
            }
          }
        });
      } else {
        proc.stdout.resume();
      }

      proc.on('error', reject);
      proc.on('close', (code) => {
        if (killed) return reject(Object.assign(new Error('cancelled'), { cancelled: true }));
        if (code === 0) return resolve();
        reject(new Error(`ffmpeg exited ${code}: ${stderr.trim().split('\n').slice(-6).join('\n')}`));
      });

      proc.cancel = () => {
        killed = true;
        try {
          proc.kill();
        } catch {
          /* already gone */
        }
      };

      if (stdinFeeder) {
        // EPIPE is expected if ffmpeg bails out early; the close handler reports
        // the real reason, so swallow it here.
        proc.stdin.on('error', () => {});
        stdinFeeder(proc.stdin).then(
          () => proc.stdin.end(),
          (err) => {
            try {
              proc.stdin.destroy();
            } catch {
              /* ignore */
            }
            if (!killed) reject(err);
          },
        );
      }

    });
  }

  /** Streams an ordered list of segment files into a writable stream, in order. */
  feedSegments(dir, names) {
    return (writable) =>
      (async () => {
        for (const name of names) {
          await new Promise((resolve, reject) => {
            const rs = fs.createReadStream(path.join(dir, name), { highWaterMark: READ_CHUNK });
            rs.on('error', reject);
            rs.on('end', resolve);
            rs.pipe(writable, { end: false });
          });
        }
      })();
  }

  /** Remuxes one capture session's segments into a normal MP4. */
  async remuxSession(session, destFile, { onProgress, duration } = {}) {
    const args = ['-v', 'error'];
    if (onProgress) args.push('-progress', 'pipe:1', '-nostats');

    let audioTemp = null;
    const hasAudio = Boolean(session.audioInit && session.audioChunks.length);

    if (hasAudio) {
      // Small enough to assemble in memory; ffmpeg only accepts one pipe input.
      audioTemp = path.join(this.tmpDir, `${shortHash(session.dir)}-a.mp4`);
      const parts = [session.audioInit, ...session.audioChunks];
      const chunks = [];
      for (const p of parts) chunks.push(await fsp.readFile(path.join(session.dir, p)));
      await fsp.writeFile(audioTemp, Buffer.concat(chunks));
    }

    args.push('-i', 'pipe:0');
    if (audioTemp) args.push('-i', audioTemp);
    args.push('-map', '0:v:0');
    if (audioTemp) args.push('-map', '1:a:0');
    // Stream copy only, never re-encoded, so this stays I/O bound.
    args.push('-c', 'copy', '-avoid_negative_ts', 'make_zero', '-movflags', '+faststart', '-y', destFile);

    try {
      await this.runFfmpeg(args, {
        onProgress,
        totalDuration: duration,
        stdinFeeder: this.feedSegments(session.dir, [session.videoInit, ...session.videoChunks]),
      });
    } finally {
      if (audioTemp) await fsp.rm(audioTemp, { force: true }).catch(() => {});
    }
  }

  /** Joins already-remuxed parts (a clip that spans several capture sessions). */
  async concatParts(parts, destFile) {
    const listFile = path.join(this.tmpDir, `${shortHash(parts.join('|'))}-list.txt`);
    // The concat demuxer wants forward slashes and single-quote escaping.
    const body = parts.map((p) => `file '${p.split(path.sep).join('/').replace(/'/g, "'\\''")}'`).join('\n');
    await fsp.writeFile(listFile, `${body}\n`);
    try {
      await this.runFfmpeg([
        '-v', 'error',
        '-f', 'concat',
        '-safe', '0',
        '-i', listFile,
        '-c', 'copy',
        '-movflags', '+faststart',
        '-y', destFile,
      ]);
    } finally {
      await fsp.rm(listFile, { force: true }).catch(() => {});
    }
  }

  cachedClipPath(clipId) {
    return path.join(this.clipDir, `${clipId}.mp4`);
  }

  async cachedClipIfReady(clipId) {
    const p = this.cachedClipPath(clipId);
    try {
      const st = await fsp.stat(p);
      if (st.size > 0) {
        // Touch so the LRU sweep keeps recently watched clips.
        await fsp.utimes(p, new Date(), st.mtime).catch(() => {});
        return p;
      }
    } catch {
      /* not cached */
    }
    return null;
  }

  /**
   * Produces a playable MP4 for a clip, reusing the cache when possible.
   * @param {object} clip a recording item from the scanner
   * @param {(fraction: number, stage: string) => void} [onProgress]
   */
  async prepareClip(clip, onProgress) {
    const ready = await this.cachedClipIfReady(clip.id);
    if (ready) return ready;

    if (this.jobs.has(clip.id)) return this.jobs.get(clip.id);
    if (!clip.sessions || clip.sessions.length === 0) {
      throw new Error(clip.unplayableReason || 'This clip has no video segments');
    }
    if (!this.ffmpeg) {
      throw Object.assign(new Error('ffmpeg was not found. Set its location in Settings.'), { code: 'NO_FFMPEG' });
    }

    const work = (async () => {
      const dest = this.cachedClipPath(clip.id);
      const staging = path.join(this.tmpDir, `${clip.id}.mp4`);
      const parts = [];

      try {
        if (clip.sessions.length === 1) {
          await this.remuxSession(clip.sessions[0], staging, {
            duration: clip.duration,
            onProgress: onProgress ? (f) => onProgress(f, 'remux') : undefined,
          });
        } else {
          // Weight each session's progress by its share of the total duration.
          const totals = clip.sessions.map((s) => (s.manifest && s.manifest.duration) || 1);
          const grand = totals.reduce((a, b) => a + b, 0);
          let elapsed = 0;

          for (let i = 0; i < clip.sessions.length; i++) {
            const part = path.join(this.tmpDir, `${clip.id}-part${i}.mp4`);
            const share = totals[i] / grand;
            const base = elapsed;
            await this.remuxSession(clip.sessions[i], part, {
              duration: totals[i],
              onProgress: onProgress ? (f) => onProgress(base + f * share, 'remux') : undefined,
            });
            parts.push(part);
            elapsed += share;
          }
          if (onProgress) onProgress(0.98, 'join');
          await this.concatParts(parts, staging);
        }

        await fsp.rename(staging, dest);
        if (onProgress) onProgress(1, 'done');
        this.sweepCache().catch(() => {});
        return dest;
      } catch (err) {
        await fsp.rm(staging, { force: true }).catch(() => {});
        throw err;
      } finally {
        for (const p of parts) await fsp.rm(p, { force: true }).catch(() => {});
      }
    })();

    this.jobs.set(clip.id, work);
    try {
      return await work;
    } finally {
      this.jobs.delete(clip.id);
    }
  }

  /**
   * Small JPEG preview for a screenshot. Steam already ships thumbnails for its
   * own folder layout; this covers custom (flat) folders, where full-size PNGs
   * can be 17 MB each and would make a grid unusable.
   */
  async screenshotThumb(file, { width = 480 } = {}) {
    let st;
    try {
      st = await fsp.stat(file);
    } catch {
      return null;
    }
    const key = shortHash(`${file}|${st.size}|${st.mtimeMs}|${width}`);
    const dest = path.join(this.thumbDir, `${key}.jpg`);
    try {
      if ((await fsp.stat(dest)).size > 0) return dest;
    } catch {
      /* generate below */
    }
    if (!this.ffmpeg) return null;

    const staging = path.join(this.tmpDir, `${key}.jpg`);
    try {
      await this.runFfmpeg([
        '-v', 'error',
        '-i', file,
        '-vf', `scale=${width}:-2:flags=bilinear`,
        '-frames:v', '1',
        '-q:v', '4',
        '-y', staging,
      ]);
      await fsp.rename(staging, dest);
      return dest;
    } catch {
      await fsp.rm(staging, { force: true }).catch(() => {});
      return null; // renderer falls back to the full-size image
    }
  }

  /**
   * Full-size PNG copy of an image, for formats the clipboard cannot take
   * directly. Returns null when no conversion is possible.
   */
  async asPng(file) {
    if (!this.ffmpeg) return null;
    const dest = path.join(this.tmpDir, `clip-copy-${shortHash(file)}.png`);
    const staging = `${dest}.part.png`;
    try {
      await this.runFfmpeg(['-v', 'error', '-i', file, '-frames:v', '1', '-y', staging]);
      await fsp.rename(staging, dest);
      return dest;
    } catch {
      await fsp.rm(staging, { force: true }).catch(() => {});
      return null;
    }
  }

  /** Extracts a still from a prepared clip, for clips with no thumbnail.jpg. */
  async clipPoster(clipId, mp4Path, atSeconds = 1) {
    const dest = path.join(this.thumbDir, `clip-${shortHash(clipId)}.jpg`);
    try {
      if ((await fsp.stat(dest)).size > 0) return dest;
    } catch {
      /* generate below */
    }
    if (!this.ffmpeg) return null;
    const staging = path.join(this.tmpDir, `poster-${shortHash(clipId)}.jpg`);
    try {
      await this.runFfmpeg([
        '-v', 'error',
        '-ss', String(atSeconds),
        '-i', mp4Path,
        '-vf', 'scale=480:-2',
        '-frames:v', '1',
        '-q:v', '4',
        '-y', staging,
      ]);
      await fsp.rename(staging, dest);
      return dest;
    } catch {
      await fsp.rm(staging, { force: true }).catch(() => {});
      return null;
    }
  }

  async cacheStats() {
    const stat = async (dir) => {
      let bytes = 0;
      let count = 0;
      try {
        for (const f of await fsp.readdir(dir)) {
          try {
            const st = await fsp.stat(path.join(dir, f));
            if (st.isFile()) {
              bytes += st.size;
              count += 1;
            }
          } catch {
            /* vanished mid-scan */
          }
        }
      } catch {
        /* missing dir */
      }
      return { bytes, count };
    };
    const [clips, thumbs] = await Promise.all([stat(this.clipDir), stat(this.thumbDir)]);
    return { clips, thumbs, totalBytes: clips.bytes + thumbs.bytes, limitBytes: this.maxCacheBytes };
  }

  /** Evicts least-recently-used prepared clips until we're back under the cap. */
  async sweepCache() {
    let files;
    try {
      files = await fsp.readdir(this.clipDir);
    } catch {
      return;
    }
    const entries = [];
    let total = 0;
    for (const f of files) {
      const full = path.join(this.clipDir, f);
      try {
        const st = await fsp.stat(full);
        if (!st.isFile()) continue;
        entries.push({ full, size: st.size, atime: st.atimeMs || st.mtimeMs });
        total += st.size;
      } catch {
        /* ignore */
      }
    }
    if (total <= this.maxCacheBytes) return;

    entries.sort((a, b) => a.atime - b.atime); // oldest touched first
    for (const e of entries) {
      if (total <= this.maxCacheBytes) break;
      try {
        await fsp.rm(e.full, { force: true });
        total -= e.size;
      } catch {
        /* in use - skip */
      }
    }
  }

  async clearCache({ clips = true, thumbs = true } = {}) {
    const wipe = async (dir) => {
      try {
        for (const f of await fsp.readdir(dir)) {
          await fsp.rm(path.join(dir, f), { force: true, recursive: true }).catch(() => {});
        }
      } catch {
        /* nothing there */
      }
    };
    if (clips) await wipe(this.clipDir);
    if (thumbs) await wipe(this.thumbDir);
  }
}

module.exports = { MediaPipeline, locateFfmpeg, isBundled };
