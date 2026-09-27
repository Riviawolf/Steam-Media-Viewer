'use strict';
// Settings live in a small JSON file under the app's userData directory.
// Each media folder can either follow the Steam default (re-detected on every
// launch, so it tracks changes made in Steam) or use an explicit custom path.

const fs = require('fs');
const fsp = require('fs/promises');
const path = require('path');

const DEFAULTS = {
  version: 2,
  recordings: { mode: 'steam', customPaths: [] },
  screenshots: { mode: 'steam', customPaths: [] },
  ffmpegPath: '',
  allowNetwork: true,
  maxCacheGB: 12,
  // Wide enough to stay sharp at the larger preview sizes.
  thumbnailSize: 720,
  sortOrder: 'newest',
  // Index into the renderer's preview-size steps; 2 is the default size.
  cardScale: 2,
};

function coerce(raw) {
  const out = JSON.parse(JSON.stringify(DEFAULTS));
  if (!raw || typeof raw !== 'object') return out;

  for (const key of ['recordings', 'screenshots']) {
    const src = raw[key];
    if (!src || typeof src !== 'object') continue;
    out[key].mode = src.mode === 'custom' ? 'custom' : 'steam';

    // v1 stored a single customPath string; keep those settings working.
    const list = Array.isArray(src.customPaths)
      ? src.customPaths
      : typeof src.customPath === 'string'
        ? [src.customPath]
        : [];

    const seen = new Set();
    out[key].customPaths = list
      .filter((p) => typeof p === 'string')
      .map((p) => p.trim())
      .filter(Boolean)
      // Make hand-typed input unambiguous: forward slashes, no trailing
      // separator, and no drive-relative forms like "E:Games".
      .map((p) => {
        try {
          return path.resolve(p);
        } catch {
          return p;
        }
      })
      .filter((p) => {
        const norm = p.replace(/[\\/]+$/, '').toLowerCase();
        if (seen.has(norm)) return false;
        seen.add(norm);
        return true;
      });

    // "Custom" with nothing in it already behaves as the Steam default, so say
    // so rather than leaving the radio claiming otherwise.
    if (out[key].mode === 'custom' && out[key].customPaths.length === 0) out[key].mode = 'steam';
  }
  if (typeof raw.ffmpegPath === 'string') out.ffmpegPath = raw.ffmpegPath;
  if (typeof raw.allowNetwork === 'boolean') out.allowNetwork = raw.allowNetwork;
  if (Number.isFinite(raw.maxCacheGB)) out.maxCacheGB = Math.max(1, Math.min(500, raw.maxCacheGB));
  if (Number.isFinite(raw.thumbnailSize)) out.thumbnailSize = Math.max(160, Math.min(1280, raw.thumbnailSize));
  if (raw.sortOrder === 'oldest' || raw.sortOrder === 'newest') out.sortOrder = raw.sortOrder;
  if (Number.isInteger(raw.cardScale)) out.cardScale = Math.max(0, Math.min(4, raw.cardScale));
  return out;
}

class Settings {
  constructor(userDataDir) {
    this.file = path.join(userDataDir, 'settings.json');
    this.values = JSON.parse(JSON.stringify(DEFAULTS));
    // Saves can overlap (a view preference while an explicit Save is still in
    // flight), so they are queued.
    this.writeQueue = Promise.resolve();
    this.writeSeq = 0;
  }

  load() {
    try {
      this.values = coerce(JSON.parse(fs.readFileSync(this.file, 'utf8')));
    } catch {
      // Missing or unreadable - start from defaults rather than failing to boot.
      this.values = JSON.parse(JSON.stringify(DEFAULTS));
    }
    return this.values;
  }

  async save(patch) {
    if (patch) this.values = coerce({ ...this.values, ...patch });

    // Each write gets its own temp file, or a concurrent save would rename the
    // file out from under this one.
    const tmp = `${this.file}.${process.pid}.${++this.writeSeq}.tmp`;
    const snapshot = JSON.stringify(this.values, null, 2);

    this.writeQueue = this.writeQueue.then(async () => {
      try {
        await fsp.writeFile(tmp, snapshot);
        await fsp.rename(tmp, this.file);
      } catch (err) {
        await fsp.rm(tmp, { force: true }).catch(() => {});
        throw err;
      }
    });

    await this.writeQueue;
    return this.values;
  }

  /**
   * Resolves the configured folders against the detected Steam defaults.
   * @param {{recordingsRoot: string|null, screenshotRoots: string[]}} detected
   */
  effectivePaths(detected) {
    const v = this.values;
    const pick = (cfg, fallback) =>
      cfg.mode === 'custom' && cfg.customPaths.length ? cfg.customPaths.slice() : fallback;

    return {
      recordings: pick(v.recordings, detected.recordingsRoot ? [detected.recordingsRoot] : []),
      screenshots: pick(v.screenshots, detected.screenshotRoots || []),
    };
  }
}

module.exports = { Settings, DEFAULTS };
