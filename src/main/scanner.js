'use strict';
// Read-only scanners for the two media trees.
//
// Recordings (Steam "clips"):
//   <root>/clips/clip_<appid>_<YYYYMMDD>_<HHMMSS>/
//     thumbnail.jpg
//     clip.pb                       (unused; the folder name has everything)
//     video/bg_<appid>_<ts>/        one or more capture sessions
//       session.mpd                 DASH manifest: duration + codecs
//       init-stream0.m4s            video init segment
//       chunk-stream0-00001.m4s ... video media segments
//       init-stream1.m4s            audio init segment
//       chunk-stream1-00001.m4s ... audio media segments
//
// Screenshots, in either of two layouts:
//   flat:  <root>/<appid>_<YYYYMMDDHHMMSS>_<n>.png|jpg|avif
//   steam: <root>/<appid>/screenshots/<file>  (+ thumbnails/<same name>)

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const crypto = require('crypto');

/** "E:\Steam Game Recordings\clips" -> "E:" (or the filesystem root elsewhere). */
function driveOf(p) {
  const root = path.parse(path.resolve(p)).root;
  const m = /^([A-Za-z]):/.exec(root);
  return m ? `${m[1].toUpperCase()}:` : root || '';
}

/** Short, filesystem-safe discriminator so the same clip name on two drives
 *  gets two distinct ids (the id doubles as the cache filename). */
function shortHash(text) {
  return crypto.createHash('sha1').update(text).digest('hex').slice(0, 8);
}

const CLIP_DIR = /^clip_(\d+)_(\d{8})_(\d{6})$/;
const SHOT_FLAT = /^(\d+)_(\d{14})_(\d+)\.(png|jpe?g|avif|webp)$/i;
const SHOT_EXT = /\.(png|jpe?g|avif|webp)$/i;

/** "20260927" + "010929" -> local Date. Steam writes these in local time. */
function parseStamp(datePart, timePart) {
  const y = +datePart.slice(0, 4);
  const mo = +datePart.slice(4, 6) - 1;
  const d = +datePart.slice(6, 8);
  const h = +timePart.slice(0, 2);
  const mi = +timePart.slice(2, 4);
  const s = +timePart.slice(4, 6);
  const dt = new Date(y, mo, d, h, mi, s);
  return Number.isNaN(dt.getTime()) ? null : dt;
}

/** ISO-8601 duration as used by DASH: PT1M0.0S, PT53.233S, PT2H0M0.0S */
function parseIsoDuration(text) {
  if (!text) return null;
  const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(text.trim());
  if (!m) return null;
  const secs = (+m[1] || 0) * 3600 + (+m[2] || 0) * 60 + (+m[3] || 0);
  return Number.isFinite(secs) ? secs : null;
}

// We only need three facts out of the manifest, so a couple of regexes beat
// pulling in an XML parser.
function readManifest(mpdPath) {
  let xml;
  try {
    xml = fs.readFileSync(mpdPath, 'utf8');
  } catch {
    return null;
  }
  const attr = (name) => {
    const m = new RegExp(`${name}="([^"]*)"`).exec(xml);
    return m ? m[1] : null;
  };
  const codecs = [...xml.matchAll(/codecs="([^"]*)"/g)].map((m) => m[1]);
  const width = attr('maxWidth') || attr('width');
  const height = attr('maxHeight') || attr('height');
  return {
    duration: parseIsoDuration(attr('mediaPresentationDuration')),
    width: width ? +width : null,
    height: height ? +height : null,
    videoCodec: codecs[0] || null,
    audioCodec: codecs[1] || null,
    hasAudio: codecs.length > 1,
  };
}

/**
 * Describes one capture session inside a clip: the ordered segment lists ffmpeg
 * needs, plus the details from the manifest.
 */
function readSession(sessionDir) {
  let entries;
  try {
    entries = fs.readdirSync(sessionDir);
  } catch {
    return null;
  }

  const bucket = (streamIndex) =>
    entries
      .filter((f) => f.startsWith(`chunk-stream${streamIndex}-`) && f.endsWith('.m4s'))
      .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));

  const videoInit = entries.includes('init-stream0.m4s') ? 'init-stream0.m4s' : null;
  const audioInit = entries.includes('init-stream1.m4s') ? 'init-stream1.m4s' : null;
  const videoChunks = bucket(0);
  const audioChunks = bucket(1);

  if (!videoInit || videoChunks.length === 0) return null;

  const manifest = entries.includes('session.mpd') ? readManifest(path.join(sessionDir, 'session.mpd')) : null;

  return {
    dir: sessionDir,
    name: path.basename(sessionDir),
    videoInit,
    videoChunks,
    audioInit: audioChunks.length > 0 ? audioInit : null,
    audioChunks,
    manifest,
  };
}

/** Recordings live under <root>/clips, but accept being pointed straight at it. */
function resolveClipsDir(root) {
  if (!root) return null;
  const nested = path.join(root, 'clips');
  try {
    if (fs.statSync(nested).isDirectory()) return nested;
  } catch {
    /* maybe root *is* the clips dir */
  }
  try {
    if (fs.statSync(root).isDirectory()) return root;
  } catch {
    return null;
  }
  return root;
}

async function scanRecordingRoot(configuredRoot, result) {
  const clipsDir = resolveClipsDir(configuredRoot);
  if (!clipsDir) return;
  result.dirs.push(clipsDir);

  const drive = driveOf(clipsDir);

  let dirents;
  try {
    dirents = await fsp.readdir(clipsDir, { withFileTypes: true });
  } catch (err) {
    result.errors.push(`Cannot read ${clipsDir}: ${err.code || err.message}`);
    return;
  }

  for (const dirent of dirents) {
    if (!dirent.isDirectory()) continue;
    const m = CLIP_DIR.exec(dirent.name);
    if (!m) continue;

    const [, appId, datePart, timePart] = m;
    const clipDir = path.join(clipsDir, dirent.name);

    // A clip can span more than one capture session; order matters.
    let sessions = [];
    try {
      sessions = (await fsp.readdir(path.join(clipDir, 'video'), { withFileTypes: true }))
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
        .sort((a, b) => a.localeCompare(b, 'en', { numeric: true }))
        .map((name) => readSession(path.join(clipDir, 'video', name)))
        .filter(Boolean);
    } catch {
      // No video/ at all - Steam sometimes leaves a metadata-only husk behind.
    }

    const thumb = path.join(clipDir, 'thumbnail.jpg');
    const durations = sessions.map((s) => (s.manifest && s.manifest.duration) || 0);
    const firstManifest = sessions.find((s) => s.manifest) || null;
    const recordedAt = parseStamp(datePart, timePart);

    result.items.push({
      kind: 'recording',
      // Folder names repeat across drives, so the id carries the location too.
      id: `${dirent.name}-${shortHash(clipDir)}`,
      appId,
      dir: clipDir,
      root: clipsDir,
      drive,
      name: dirent.name,
      recordedAt: recordedAt ? recordedAt.getTime() : null,
      thumbnail: fs.existsSync(thumb) ? thumb : null,
      sessions,
      playable: sessions.length > 0,
      unplayableReason: sessions.length === 0 ? 'No video segments in this clip folder' : null,
      duration: durations.reduce((a, b) => a + b, 0) || null,
      width: firstManifest && firstManifest.manifest ? firstManifest.manifest.width : null,
      height: firstManifest && firstManifest.manifest ? firstManifest.manifest.height : null,
      videoCodec: firstManifest && firstManifest.manifest ? firstManifest.manifest.videoCodec : null,
      hasAudio: sessions.some((s) => s.audioChunks.length > 0),
    });
  }
}

async function scanRecordings(roots) {
  const list = (Array.isArray(roots) ? roots : [roots]).filter(Boolean);
  const result = { dirs: [], items: [], errors: [] };

  if (!list.length) {
    result.errors.push('No recordings folder configured.');
    return result;
  }

  for (const root of list) await scanRecordingRoot(root, result);

  result.items.sort((a, b) => (b.recordedAt || 0) - (a.recordedAt || 0));
  return result;
}

/** Steam's own screenshot tree: <root>/<appid>/screenshots/ with sibling thumbnails/. */
async function scanSteamScreenshotRoot(root, out, errors) {
  let appDirs;
  try {
    appDirs = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    errors.push(`Cannot read ${root}: ${err.code || err.message}`);
    return;
  }

  for (const appDir of appDirs) {
    if (!appDir.isDirectory() || !/^\d+$/.test(appDir.name)) continue;
    const shotsDir = path.join(root, appDir.name, 'screenshots');
    let files;
    try {
      files = await fsp.readdir(shotsDir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const f of files) {
      if (!f.isFile() || !SHOT_EXT.test(f.name)) continue;
      const full = path.join(shotsDir, f.name);
      let stat;
      try {
        stat = await fsp.stat(full);
      } catch {
        continue;
      }
      // Steam names these <YYYYMMDDHHMMSS>_<n>.jpg inside the per-app folder.
      const stampMatch = /^(\d{8})(\d{6})_(\d+)\./.exec(f.name);
      const thumb = path.join(shotsDir, 'thumbnails', f.name);
      out.push({
        kind: 'screenshot',
        id: `${appDir.name}/${f.name}-${shortHash(full)}`,
        appId: appDir.name,
        file: full,
        root,
        drive: driveOf(root),
        name: f.name,
        size: stat.size,
        recordedAt: stampMatch
          ? (parseStamp(stampMatch[1], stampMatch[2]) || stat.mtime).getTime()
          : stat.mtime.getTime(),
        thumbnail: fs.existsSync(thumb) ? thumb : null,
        dedupeKey: stampMatch ? `${appDir.name}|${stampMatch[1]}${stampMatch[2]}|${stampMatch[3]}` : null,
      });
    }
  }
}

/** A flat folder of <appid>_<stamp>_<n>.<ext>, which is what Steam writes for a custom path. */
async function scanFlatScreenshotRoot(root, out, errors) {
  let files;
  try {
    files = await fsp.readdir(root, { withFileTypes: true });
  } catch (err) {
    errors.push(`Cannot read ${root}: ${err.code || err.message}`);
    return;
  }

  for (const f of files) {
    if (!f.isFile()) continue;
    const m = SHOT_FLAT.exec(f.name);
    if (!m) continue;
    const [, appId, stamp, index] = m;
    const full = path.join(root, f.name);
    let stat;
    try {
      stat = await fsp.stat(full);
    } catch {
      continue;
    }
    const when = parseStamp(stamp.slice(0, 8), stamp.slice(8, 14));
    const thumb = path.join(root, 'thumbnails', f.name);
    out.push({
      kind: 'screenshot',
      id: `${f.name}-${shortHash(full)}`,
      appId,
      file: full,
      root,
      drive: driveOf(root),
      name: f.name,
      size: stat.size,
      recordedAt: (when || stat.mtime).getTime(),
      thumbnail: fs.existsSync(thumb) ? thumb : null,
      dedupeKey: `${appId}|${stamp}|${index}`,
    });
  }
}

/** Looks one level in to decide which layout a screenshot root uses. */
function detectScreenshotLayout(root) {
  try {
    const entries = fs.readdirSync(root, { withFileTypes: true });
    const hasFlat = entries.some((e) => e.isFile() && SHOT_FLAT.test(e.name));
    if (hasFlat) return 'flat';
    const hasAppDirs = entries.some(
      (e) => e.isDirectory() && /^\d+$/.test(e.name) && fs.existsSync(path.join(root, e.name, 'screenshots')),
    );
    if (hasAppDirs) return 'steam';
    return hasFlat ? 'flat' : 'empty';
  } catch {
    return 'unreadable';
  }
}

async function scanScreenshots(roots) {
  const list = (Array.isArray(roots) ? roots : [roots]).filter(Boolean);
  const items = [];
  const errors = [];
  const layouts = [];

  for (const root of list) {
    const layout = detectScreenshotLayout(root);
    layouts.push({ path: root, layout });
    if (layout === 'steam') await scanSteamScreenshotRoot(root, items, errors);
    else if (layout === 'unreadable') errors.push(`Cannot read ${root}`);
    else await scanFlatScreenshotRoot(root, items, errors);
  }

  // When Steam is configured to keep an uncompressed original *and* its own
  // managed JPEG, the same shot turns up twice. Roots are scanned in priority
  // order, so keep the first copy of each and count the rest as duplicates.
  const seen = new Set();
  const unique = [];
  let duplicates = 0;
  for (const item of items) {
    if (item.dedupeKey) {
      if (seen.has(item.dedupeKey)) {
        duplicates += 1;
        continue;
      }
      seen.add(item.dedupeKey);
    }
    unique.push(item);
  }

  unique.sort((a, b) => (b.recordedAt || 0) - (a.recordedAt || 0));
  return { dirs: list, items: unique, errors, duplicates, layouts };
}

module.exports = {
  scanRecordings,
  scanScreenshots,
  resolveClipsDir,
  detectScreenshotLayout,
  parseIsoDuration,
  driveOf,
};
