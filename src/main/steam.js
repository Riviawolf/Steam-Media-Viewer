'use strict';
// Everything about turning a bare Steam app id into a name and a piece of art.
//
// Sources are tried cheapest-first and the answer is cached on disk, so a given
// app id is only ever resolved once unless the user hits Refresh:
//   name: appinfo.vdf  ->  appmanifest_<id>.acf  ->  store web API
//   art:  librarycache ->  Steam CDN
//
// Nothing here writes to the user's Steam install or media folders.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');
const os = require('os');
const { execFile } = require('child_process');

const { parseAppInfo } = require('./appinfo');
const { parseTextVdf, vdfGet } = require('./vdf');

const ART_FILES = ['library_header.jpg', 'header.jpg', 'library_capsule.jpg', 'library_600x900.jpg', 'logo.png'];

const CDN_BASES = [
  (id) => `https://shared.cloudflare.steamstatic.com/store_item_assets/steam/apps/${id}/header.jpg`,
  (id) => `https://cdn.cloudflare.steamstatic.com/steam/apps/${id}/header.jpg`,
  (id) => `https://cdn.akamai.steamstatic.com/steam/apps/${id}/header.jpg`,
];

// Steam app ids are 32-bit. Non-Steam shortcuts get a synthetic 64-bit id, and
// no Steam source will ever know anything about them.
function isRealAppId(appId) {
  const n = Number(appId);
  return Number.isInteger(n) && n > 0 && n <= 0xffffffff;
}

function findSteamPath() {
  const candidates = [];

  // The registry is authoritative when it is readable.
  for (const [hive, key, value] of [
    ['HKCU', 'Software\\Valve\\Steam', 'SteamPath'],
    ['HKLM', 'SOFTWARE\\WOW6432Node\\Valve\\Steam', 'InstallPath'],
  ]) {
    try {
      const { execFileSync } = require('child_process');
      const out = execFileSync('reg', ['query', `${hive}\\${key}`, '/v', value], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        windowsHide: true,
      });
      const m = out.match(/REG_SZ\s+(.+)/);
      if (m) candidates.push(m[1].trim());
    } catch {
      // Not fatal - fall through to the well-known locations.
    }
  }

  candidates.push(
    path.join(process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)', 'Steam'),
    path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Steam'),
    path.join(os.homedir(), '.steam', 'steam'),
    path.join(os.homedir(), '.local', 'share', 'Steam'),
  );

  for (const c of candidates) {
    const resolved = path.normalize(c);
    try {
      if (!fs.statSync(resolved).isDirectory()) continue;
      // The registry stores the path lower-cased with forward slashes. realpath
      // gives back the real on-disk casing, so the shown path matches Explorer.
      try {
        return fs.realpathSync.native(resolved);
      } catch {
        return resolved.replace(/^([a-z]):/, (_, d) => `${d.toUpperCase()}:`);
      }
    } catch {
      /* keep looking */
    }
  }
  return null;
}

// Reads each Steam user's localconfig.vdf so "use the Steam default" can mean
// something concrete: where clips are recorded, and where screenshots land.
//
// Screenshots can live in two places at once. Steam always keeps a managed JPEG
// copy under userdata/<id>/760/remote; if "save an uncompressed copy" is on, it
// also writes a PNG/AVIF original to a folder the user picked.
//
// "Steam default" means only the managed folder - the folder Steam itself owns.
// The uncompressed folder is reported separately as `uncompressedRoot` so the
// UI can offer it as a one-click custom path rather than silently adopting it.
function detectSteamDefaults(steamPath) {
  const out = { recordingsRoot: null, screenshotRoots: [], uncompressedRoot: null };
  if (!steamPath) return out;

  const userdata = path.join(steamPath, 'userdata');
  let users = [];
  try {
    users = fs.readdirSync(userdata).filter((d) => /^\d+$/.test(d));
  } catch {
    return out;
  }

  const managed = [];
  for (const user of users) {
    let cfg = null;
    try {
      cfg = parseTextVdf(fs.readFileSync(path.join(userdata, user, 'config', 'localconfig.vdf'), 'utf8'));
    } catch {
      /* this user has no local config */
    }

    if (cfg) {
      if (!out.recordingsRoot) {
        const p = vdfGet(cfg, 'UserLocalConfigStore', 'GameRecording', 'BackgroundRecordPath');
        if (p) out.recordingsRoot = path.normalize(p);
      }
      if (!out.uncompressedRoot) {
        const system = vdfGet(cfg, 'UserLocalConfigStore', 'system') || {};
        const enabled = vdfGet(system, 'InGameOverlayScreenshotSaveUncompressed');
        const p = vdfGet(system, 'InGameOverlayScreenshotSaveUncompressedPath');
        if (p && String(enabled) !== '0') {
          const resolved = path.normalize(p);
          try {
            if (fs.statSync(resolved).isDirectory()) out.uncompressedRoot = resolved;
          } catch {
            /* configured but missing - ignore it */
          }
        }
      }
    }

    const remote = path.join(userdata, user, '760', 'remote');
    try {
      if (fs.readdirSync(remote).length > 0) managed.push(remote);
    } catch {
      /* no screenshots for this user */
    }
  }

  out.screenshotRoots = managed;
  return out;
}

class SteamCatalog {
  /**
   * @param {string} cacheDir writable directory for the metadata and art cache
   * @param {{allowNetwork: boolean}} opts
   */
  constructor(cacheDir, opts = {}) {
    this.steamPath = findSteamPath();
    this.cacheDir = cacheDir;
    this.artDir = path.join(cacheDir, 'art');
    this.metaFile = path.join(cacheDir, 'apps.json');
    this.allowNetwork = opts.allowNetwork !== false;

    this.meta = new Map(); // appId -> { name, type, art, source, resolvedAt, failed }
    this.appInfo = null; // lazily parsed appinfo.vdf
    this.inFlight = new Map();
    this.writeSeq = 0;
  }

  async init() {
    await fsp.mkdir(this.artDir, { recursive: true });
    try {
      const raw = JSON.parse(await fsp.readFile(this.metaFile, 'utf8'));
      for (const [id, entry] of Object.entries(raw.apps || {})) this.meta.set(id, entry);
    } catch {
      // First run, or a corrupt cache that is simply rebuilt.
    }
  }

  async save() {
    const apps = {};
    for (const [id, entry] of this.meta) apps[id] = entry;
    // Unique temp name: two scans can overlap and would otherwise fight over it.
    const tmp = `${this.metaFile}.${process.pid}.${++this.writeSeq}.tmp`;
    try {
      await fsp.writeFile(tmp, JSON.stringify({ version: 1, apps }, null, 1));
      await fsp.rename(tmp, this.metaFile);
    } catch (err) {
      await fsp.rm(tmp, { force: true }).catch(() => {});
      throw err;
    }
  }

  /** Drops cached names/art so the next resolve re-reads Steam and the network. */
  async clearCache() {
    this.meta.clear();
    this.appInfo = null;
    try {
      const files = await fsp.readdir(this.artDir);
      await Promise.all(files.map((f) => fsp.rm(path.join(this.artDir, f), { force: true })));
    } catch {
      /* nothing cached yet */
    }
    await this.save();
  }

  getAppInfo() {
    if (this.appInfo) return this.appInfo;
    this.appInfo = new Map();
    if (!this.steamPath) return this.appInfo;
    try {
      this.appInfo = parseAppInfo(path.join(this.steamPath, 'appcache', 'appinfo.vdf'));
    } catch {
      // A missing or newly-reformatted appinfo.vdf falls through to the
      // other sources.
    }
    return this.appInfo;
  }

  nameFromAppInfo(appId) {
    const hit = this.getAppInfo().get(String(appId));
    return hit && hit.name ? { name: hit.name, type: hit.type } : null;
  }

  nameFromManifest(appId) {
    if (!this.steamPath) return null;
    // Installed games are listed in every library folder, not just the main one.
    const roots = [path.join(this.steamPath, 'steamapps')];
    try {
      const lf = parseTextVdf(fs.readFileSync(path.join(this.steamPath, 'steamapps', 'libraryfolders.vdf'), 'utf8'));
      const folders = vdfGet(lf, 'libraryfolders') || {};
      for (const key of Object.keys(folders)) {
        const p = vdfGet(folders, key, 'path');
        if (p) roots.push(path.join(path.normalize(p), 'steamapps'));
      }
    } catch {
      /* single-library install */
    }
    for (const root of roots) {
      try {
        const acf = parseTextVdf(fs.readFileSync(path.join(root, `appmanifest_${appId}.acf`), 'utf8'));
        const name = vdfGet(acf, 'AppState', 'name');
        if (name) return { name, type: 'game' };
      } catch {
        /* not in this library */
      }
    }
    return null;
  }

  /** Newer Steam nests art under librarycache/<appid>/<sha1>/; older is flat. */
  artFromLibraryCache(appId) {
    if (!this.steamPath) return null;
    const lc = path.join(this.steamPath, 'appcache', 'librarycache');

    const nested = path.join(lc, String(appId));
    let subdirs = [];
    try {
      subdirs = fs.readdirSync(nested, { withFileTypes: true });
    } catch {
      subdirs = [];
    }
    for (const want of ART_FILES) {
      for (const d of subdirs) {
        const candidate = d.isDirectory() ? path.join(nested, d.name, want) : path.join(nested, d.name);
        if (d.isDirectory()) {
          try {
            if (fs.statSync(candidate).isFile()) return candidate;
          } catch {
            /* next */
          }
        } else if (d.name === want) {
          return candidate;
        }
      }
    }

    // Flat legacy layout: librarycache/<appid>_header.jpg
    for (const want of ['header.jpg', 'library_600x900.jpg', 'logo.png']) {
      const flat = path.join(lc, `${appId}_${want}`);
      try {
        if (fs.statSync(flat).isFile()) return flat;
      } catch {
        /* next */
      }
    }
    return null;
  }

  /**
   * Last resort for apps the appdetails API refuses (demos, playtests, some
   * regional or delisted entries) even though their store page loads fine.
   * The page title carries the name, wrapped in store furniture.
   */
  async nameFromStorePage(appId) {
    if (!this.allowNetwork || !isRealAppId(appId)) return null;
    try {
      const res = await fetch(`https://store.steampowered.com/app/${appId}/`, {
        headers: { 'Accept-Language': 'en-US,en' },
        redirect: 'follow',
        signal: AbortSignal.timeout(10000),
      });
      if (!res.ok) return null;
      const html = await res.text();
      const match =
        /<meta\s+property="og:title"\s+content="([^"]*)"/i.exec(html) || /<title>([^<]*)<\/title>/i.exec(html);
      if (!match) return null;

      const name = match[1]
        .trim()
        .replace(/\s+on Steam$/i, '')
        .replace(/^Save\s+\d+%\s+on\s+/i, '')
        .replace(/^Pre-Purchase\s+/i, '')
        .trim();

      // A redirect to the storefront or an error page yields nothing useful.
      if (!name || /^(Welcome to Steam|Steam Search)$/i.test(name)) return null;
      return { name, type: 'game' };
    } catch {
      return null;
    }
  }

  async nameFromWeb(appId) {
    if (!this.allowNetwork || !isRealAppId(appId)) return null;
    const url = `https://store.steampowered.com/api/appdetails?appids=${appId}&filters=basic`;
    try {
      const res = await fetch(url, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(8000),
      });
      if (!res.ok) return null;
      const body = await res.json();
      const entry = body && body[String(appId)];
      if (entry && entry.success && entry.data && entry.data.name) {
        return { name: entry.data.name, type: entry.data.type || 'game' };
      }
    } catch {
      // Offline, rate limited, or an unknown app - the caller falls back to
      // showing the raw id.
    }
    return null;
  }

  async artFromWeb(appId) {
    if (!this.allowNetwork || !isRealAppId(appId)) return null;
    const dest = path.join(this.artDir, `${appId}.jpg`);
    for (const build of CDN_BASES) {
      try {
        const res = await fetch(build(appId), { signal: AbortSignal.timeout(10000) });
        if (!res.ok) continue;
        const buf = Buffer.from(await res.arrayBuffer());
        if (buf.length < 512) continue; // an error page, not a capsule
        await fsp.writeFile(dest, buf);
        return dest;
      } catch {
        /* try the next mirror */
      }
    }
    return null;
  }

  /**
   * Resolves one app id, memoised in RAM and on disk.
   * Always succeeds - worst case the name is "App <id>" and art is null.
   */
  async resolve(appId) {
    const id = String(appId);
    const cached = this.meta.get(id);
    // Re-try a previous failure only if the network has since been enabled.
    if (cached && (!cached.failed || !this.allowNetwork)) {
      if (!cached.art || fs.existsSync(cached.art)) return cached;
    }
    if (this.inFlight.has(id)) return this.inFlight.get(id);

    const work = (async () => {
      let named = this.nameFromAppInfo(id) || this.nameFromManifest(id);
      let source = named ? 'local' : null;
      if (!named) {
        named = (await this.nameFromWeb(id)) || (await this.nameFromStorePage(id));
        if (named) source = 'web';
      }

      let art = this.artFromLibraryCache(id);
      if (art) {
        source = source || 'local';
      } else {
        const cachedArt = path.join(this.artDir, `${id}.jpg`);
        art = fs.existsSync(cachedArt) ? cachedArt : await this.artFromWeb(id);
      }

      const entry = {
        appId: id,
        name: named ? named.name : isRealAppId(id) ? `App ${id}` : 'Non-Steam app',
        type: named ? named.type : 'unknown',
        art: art || null,
        source: source || 'unknown',
        resolvedAt: Date.now(),
        failed: !named,
      };
      this.meta.set(id, entry);
      return entry;
    })();

    this.inFlight.set(id, work);
    try {
      return await work;
    } finally {
      this.inFlight.delete(id);
    }
  }

  /** Resolves many ids with bounded concurrency so we never flood the store API. */
  async resolveAll(appIds, { concurrency = 6, onProgress } = {}) {
    const ids = [...new Set(appIds.map(String))];
    const out = new Map();
    let done = 0;
    let cursor = 0;

    const worker = async () => {
      while (cursor < ids.length) {
        const id = ids[cursor++];
        try {
          out.set(id, await this.resolve(id));
        } catch {
          out.set(id, { appId: id, name: `App ${id}`, art: null, type: 'unknown', failed: true });
        }
        done += 1;
        if (onProgress) onProgress(done, ids.length);
      }
    };

    await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker));
    await this.save();
    return out;
  }
}

module.exports = { SteamCatalog, findSteamPath, detectSteamDefaults, isRealAppId };
