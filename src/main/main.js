'use strict';
// Electron main process: owns all filesystem and ffmpeg work and hands the
// renderer plain data plus file:// URLs. The window is loaded from disk, so
// media can be referenced directly as file:// - there is no local HTTP server.

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = require('fs/promises');
const { pathToFileURL } = require('url');

const { Settings } = require('./settings');
const { SteamCatalog, detectSteamDefaults } = require('./steam');
const { scanRecordings, scanScreenshots } = require('./scanner');
const { MediaPipeline } = require('./media');
const { checkForUpdates, parseRepo } = require('./updater');

const pkg = require('../../package.json');

// Windows ships HEVC decoding through Media Foundation; Steam records HEVC, so
// ask Chromium for the platform decoder explicitly.
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');

// Pin the identity before anything reads app.getPath('userData'), so settings
// and cache live in the same place whether run from source or installed.
app.setName('Steam Media Viewer');
if (process.platform === 'win32') app.setAppUserModelId('com.steammediaviewer.app');

/** Sentinel appId for the combined "All media" view. */
const ALL_GAMES = '__all__';

/** Must match --titlebar-h in the renderer's CSS. */
const TITLEBAR_HEIGHT = 40;

/**
 * The app's own version. app.getVersion() reports Electron's version when a
 * script is run directly rather than through the package, so read the manifest
 * and fall back only if that is missing.
 */
function appVersion() {
  return (pkg && pkg.version) || app.getVersion();
}

let win = null;
let settings = null;
let catalog = null;
let media = null;
let detected = { recordingsRoot: null, screenshotRoots: [] };

/** Cached scan results, so switching games doesn't re-walk the disk. */
const library = {
  recordings: [],
  screenshots: [],
  games: [],
  errors: [],
  scannedAt: 0,
};

function toFileUrl(p) {
  if (!p) return null;
  try {
    return pathToFileURL(p).href;
  } catch {
    return null;
  }
}

function fmtRelease() {
  return { electron: process.versions.electron, chrome: process.versions.chrome, node: process.versions.node };
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload);
}

/** Shapes one recording for the renderer: no absolute paths it can't use. */
function publicRecording(item) {
  return {
    kind: 'recording',
    id: item.id,
    appId: item.appId,
    name: item.name,
    recordedAt: item.recordedAt,
    duration: item.duration,
    width: item.width,
    height: item.height,
    videoCodec: item.videoCodec,
    hasAudio: item.hasAudio,
    playable: item.playable,
    unplayableReason: item.unplayableReason,
    sessionCount: item.sessions.length,
    thumbnailUrl: toFileUrl(item.thumbnail),
    dir: item.dir,
    root: item.root,
    drive: item.drive,
  };
}

function publicScreenshot(item) {
  return {
    kind: 'screenshot',
    id: item.id,
    appId: item.appId,
    name: item.name,
    recordedAt: item.recordedAt,
    size: item.size,
    file: item.file,
    root: item.root,
    drive: item.drive,
    fullUrl: toFileUrl(item.file),
    // Steam's own layout ships thumbnails; flat folders get one generated on demand.
    thumbnailUrl: toFileUrl(item.thumbnail),
    needsThumb: !item.thumbnail,
  };
}

/** Groups both media types by app id and attaches the resolved game metadata. */
async function buildGames({ onProgress } = {}) {
  const byApp = new Map();
  const touch = (appId) => {
    if (!byApp.has(appId)) {
      // byDrive lets the sidebar narrow the game list to one drive.
      byApp.set(appId, { appId, recordings: 0, screenshots: 0, latest: 0, totalDuration: 0, byDrive: {} });
    }
    return byApp.get(appId);
  };
  const bumpDrive = (game, drive, field) => {
    const key = drive || '?';
    if (!game.byDrive[key]) game.byDrive[key] = { recordings: 0, screenshots: 0 };
    game.byDrive[key][field] += 1;
  };

  for (const r of library.recordings) {
    const g = touch(r.appId);
    g.recordings += 1;
    g.totalDuration += r.duration || 0;
    g.latest = Math.max(g.latest, r.recordedAt || 0);
    bumpDrive(g, r.drive, 'recordings');
  }
  for (const s of library.screenshots) {
    const g = touch(s.appId);
    g.screenshots += 1;
    g.latest = Math.max(g.latest, s.recordedAt || 0);
    bumpDrive(g, s.drive, 'screenshots');
  }

  const resolved = await catalog.resolveAll([...byApp.keys()], { onProgress });

  library.games = [...byApp.values()]
    .map((g) => {
      const meta = resolved.get(g.appId) || {};
      return {
        ...g,
        name: meta.name || `App ${g.appId}`,
        type: meta.type || 'unknown',
        artUrl: toFileUrl(meta.art),
        metaSource: meta.source || 'unknown',
      };
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));

  return library.games;
}

async function rescan({ full = false } = {}) {
  // Re-read Steam's own config every time. The user can change where Steam
  // records while the app is running, and Refresh should pick that up.
  detected = detectSteamDefaults(catalog.steamPath);

  const paths = settings.effectivePaths(detected);
  library.errors = [];

  send('scan:status', { phase: 'scanning', message: 'Reading folders…' });

  const [rec, shots] = await Promise.all([
    paths.recordings.length
      ? scanRecordings(paths.recordings)
      : Promise.resolve({ dirs: [], items: [], errors: [] }),
    paths.screenshots.length
      ? scanScreenshots(paths.screenshots)
      : Promise.resolve({ dirs: [], items: [], errors: [] }),
  ]);

  library.recordings = rec.items;
  library.screenshots = shots.items;
  library.errors = [...rec.errors, ...shots.errors];
  library.recordingsDirs = rec.dirs;
  library.screenshotDirs = shots.dirs;
  // Detecting a folder's layout means reading it, so keep the answer from the
  // scan rather than recomputing it for every summary.
  library.screenshotLayouts = shots.layouts || [];
  library.duplicateScreenshots = shots.duplicates || 0;

  if (!paths.recordings.length) library.errors.push('No recordings folder found. Set one in Settings.');
  if (!paths.screenshots.length) library.errors.push('No screenshots folder found. Set one in Settings.');

  if (full) await catalog.clearCache();

  send('scan:status', { phase: 'metadata', message: 'Resolving game names…', done: 0, total: 0 });
  await buildGames({
    onProgress: (done, total) => send('scan:status', { phase: 'metadata', message: 'Resolving game names…', done, total }),
  });

  library.scannedAt = Date.now();
  send('scan:status', { phase: 'done', message: '' });
  const summary = librarySummary();
  // The first scan finishes after the renderer has already booted, so push the
  // result rather than making it poll.
  send('library:updated', summary);
  return summary;
}

/** Per-drive tallies, so the UI can offer a drive filter and show what's where. */
function driveBreakdown() {
  const drives = new Map();
  const bump = (item, field) => {
    const key = item.drive || '?';
    if (!drives.has(key)) drives.set(key, { drive: key, recordings: 0, screenshots: 0, roots: new Set() });
    const entry = drives.get(key);
    entry[field] += 1;
    if (item.root) entry.roots.add(item.root);
  };
  for (const r of library.recordings) bump(r, 'recordings');
  for (const s of library.screenshots) bump(s, 'screenshots');

  return [...drives.values()]
    .map((d) => ({ ...d, roots: [...d.roots].sort() }))
    .sort((a, b) => a.drive.localeCompare(b.drive));
}

function librarySummary() {
  const paths = settings.effectivePaths(detected);
  return {
    games: library.games,
    counts: { recordings: library.recordings.length, screenshots: library.screenshots.length },
    drives: driveBreakdown(),
    errors: library.errors,
    scannedAt: library.scannedAt,
    paths: {
      recordings: library.recordingsDirs || [],
      screenshots: library.screenshotDirs || [],
      recordingsConfigured: paths.recordings,
      screenshotsLayout: library.screenshotLayouts || [],
    },
    duplicateScreenshots: library.duplicateScreenshots || 0,
    detected,
    ffmpeg: media.ffmpeg,
    hasFfmpeg: media.hasFfmpeg,
    versions: fmtRelease(),
  };
}

function registerIpc() {
  ipcMain.handle('app:bootstrap', async () => ({
    settings: settings.values,
    library: librarySummary(),
  }));

  ipcMain.handle('library:rescan', async (_e, opts) => rescan({ full: Boolean(opts && opts.full) }));

  // `appId` of ALL_GAMES returns every item, each tagged with its game so the
  // combined view can label cards without a second lookup.
  ipcMain.handle('library:mediaFor', async (_e, appId) => {
    const id = String(appId);
    const all = id === ALL_GAMES;
    const byApp = new Map(library.games.map((g) => [g.appId, g]));

    const label = (item, shaped) => {
      if (!all) return shaped;
      const game = byApp.get(item.appId);
      return {
        ...shaped,
        gameName: game ? game.name : `App ${item.appId}`,
        gameArtUrl: game ? game.artUrl : null,
      };
    };

    return {
      recordings: library.recordings
        .filter((r) => all || r.appId === id)
        .map((r) => label(r, publicRecording(r))),
      screenshots: library.screenshots
        .filter((s) => all || s.appId === id)
        .map((s) => label(s, publicScreenshot(s))),
    };
  });

  // Prepares (remuxes) a clip and reports progress on a per-request channel.
  ipcMain.handle('clip:prepare', async (_e, clipId) => {
    const clip = library.recordings.find((r) => r.id === clipId);
    if (!clip) throw new Error('Clip not found. Try Refresh.');

    const cached = await media.cachedClipIfReady(clip.id);
    if (cached) return { url: toFileUrl(cached), path: cached, cached: true };

    let lastSent = 0;
    const file = await media.prepareClip(clip, (fraction, stage) => {
      const now = Date.now();
      if (now - lastSent < 80 && fraction < 1) return; // don't flood the renderer
      lastSent = now;
      send('clip:progress', { clipId, fraction, stage });
    });

    return { url: toFileUrl(file), path: file, cached: false };
  });

  ipcMain.handle('screenshot:thumb', async (_e, file) => {
    const known = library.screenshots.find((s) => s.file === file);
    if (!known) return null; // only ever touch files we scanned
    const thumb = await media.screenshotThumb(file, { width: settings.values.thumbnailSize });
    return toFileUrl(thumb);
  });

  ipcMain.handle('settings:get', async () => settings.values);

  ipcMain.handle('settings:set', async (_e, patch) => {
    const before = settings.effectivePaths(detected);
    const beforeFfmpeg = settings.values.ffmpegPath;
    const beforeNetwork = settings.values.allowNetwork;

    await settings.save(patch);

    media.maxCacheBytes = settings.values.maxCacheGB * 1024 * 1024 * 1024;
    catalog.allowNetwork = settings.values.allowNetwork;
    if (settings.values.ffmpegPath !== beforeFfmpeg) await media.refreshFfmpeg(settings.values.ffmpegPath);

    // Steam's config may have changed as well, so compare against a fresh read.
    detected = detectSteamDefaults(catalog.steamPath);
    const after = settings.effectivePaths(detected);
    const pathsChanged =
      before.recordings.join('|') !== after.recordings.join('|') ||
      before.screenshots.join('|') !== after.screenshots.join('|');
    // Turning the network on lets previously-unresolved names be retried.
    const networkOpened = !beforeNetwork && settings.values.allowNetwork;

    if (pathsChanged || networkOpened) await rescan();
    return { settings: settings.values, library: librarySummary() };
  });

  ipcMain.handle('settings:pickFolder', async (_e, { current, title } = {}) => {
    const res = await dialog.showOpenDialog(win, {
      title: title || 'Choose a folder',
      defaultPath: current && fs.existsSync(current) ? current : undefined,
      properties: ['openDirectory'],
    });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  });

  ipcMain.handle('settings:pickFfmpeg', async () => {
    const res = await dialog.showOpenDialog(win, {
      title: 'Locate ffmpeg',
      properties: ['openFile'],
      filters: process.platform === 'win32' ? [{ name: 'Executable', extensions: ['exe'] }] : [],
    });
    return res.canceled || !res.filePaths.length ? null : res.filePaths[0];
  });

  ipcMain.handle('app:version', async () => ({
    version: appVersion(),
    packaged: app.isPackaged,
    repository: pkg.repository && pkg.repository.url,
  }));

  ipcMain.handle('updates:check', async () =>
    checkForUpdates({
      currentVersion: appVersion(),
      repository: pkg.repository,
      allowNetwork: settings.values.allowNetwork,
    }),
  );

  ipcMain.handle('cache:stats', async () => media.cacheStats());

  ipcMain.handle('cache:clear', async (_e, what) => {
    await media.clearCache(what || { clips: true, thumbs: true });
    return media.cacheStats();
  });

  // "Show in Explorer", restricted to paths from the current scan.
  ipcMain.handle('shell:reveal', async (_e, target) => {
    const known =
      library.recordings.some((r) => r.dir === target) ||
      library.screenshots.some((s) => s.file === target) ||
      (library.recordingsDirs || []).includes(target);
    if (!known) return false;
    shell.showItemInFolder(target);
    return true;
  });

  // Only opens links to the two places this app ever points at: a game's Steam
  // store page, and this project's own GitHub repository.
  ipcMain.handle('shell:openExternal', async (_e, url) => {
    const target = String(url);
    const repo = parseRepo(pkg.repository);
    const allowed = [
      /^https:\/\/store\.steampowered\.com\/app\/\d+\/?$/,
      repo && new RegExp(`^https://github\\.com/${repo.owner}/${repo.name}(/[\\w./-]*)?$`, 'i'),
    ].filter(Boolean);

    if (!allowed.some((re) => re.test(target))) return false;
    await shell.openExternal(target);
    return true;
  });

  // Saves a prepared clip somewhere the user chooses. Copies - never moves the source.
  ipcMain.handle('clip:export', async (_e, clipId) => {
    const clip = library.recordings.find((r) => r.id === clipId);
    if (!clip) throw new Error('Clip not found');
    const src = await media.prepareClip(clip, (fraction, stage) =>
      send('clip:progress', { clipId, fraction, stage }),
    );
    const res = await dialog.showSaveDialog(win, {
      title: 'Save clip as MP4',
      defaultPath: `${clip.id}.mp4`,
      filters: [{ name: 'MP4 video', extensions: ['mp4'] }],
    });
    if (res.canceled || !res.filePath) return { saved: false };
    await fsp.copyFile(src, res.filePath);
    return { saved: true, path: res.filePath };
  });

  ipcMain.handle('screenshot:export', async (_e, file) => {
    const known = library.screenshots.find((s) => s.file === file);
    if (!known) throw new Error('Screenshot not found');
    const res = await dialog.showSaveDialog(win, {
      title: 'Save screenshot as',
      defaultPath: known.name,
    });
    if (res.canceled || !res.filePath) return { saved: false };
    await fsp.copyFile(file, res.filePath);
    return { saved: true, path: res.filePath };
  });
}

/** In a packaged build the exe carries the icon; in dev we set it explicitly. */
function windowIcon() {
  const candidate = path.join(__dirname, '..', '..', 'build', process.platform === 'win32' ? 'icon.ico' : 'icon.png');
  return fs.existsSync(candidate) ? candidate : undefined;
}

async function createWindow() {
  win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 940,
    minHeight: 600,
    backgroundColor: '#0f1419',
    show: false,
    autoHideMenuBar: true,
    title: 'Steam Media Viewer',
    icon: windowIcon(),
    // No separate OS title bar: the app draws its own header and Windows
    // overlays just the caption buttons, which saves a full bar of height.
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0f1419', // matches --bg, so the caption strip blends in
      symbolColor: '#93a4b3',
      height: TITLEBAR_HEIGHT,
    },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  Menu.setApplicationMenu(null);
  win.once('ready-to-show', () => win.show());
  await win.loadFile(path.join(__dirname, '..', 'renderer', 'index.html'));
}

app.whenReady().then(async () => {
  const userData = app.getPath('userData');
  const cacheDir = path.join(userData, 'cache');
  await fsp.mkdir(cacheDir, { recursive: true });

  settings = new Settings(userData);
  settings.load();

  catalog = new SteamCatalog(path.join(cacheDir, 'meta'), { allowNetwork: settings.values.allowNetwork });
  await catalog.init();

  media = new MediaPipeline(cacheDir, {
    ffmpegPath: settings.values.ffmpegPath,
    maxCacheBytes: settings.values.maxCacheGB * 1024 * 1024 * 1024,
  });
  await media.init();

  detected = detectSteamDefaults(catalog.steamPath);

  registerIpc();
  await createWindow();

  // First scan happens after the window exists so the UI can show progress.
  rescan().catch((err) => send('scan:status', { phase: 'error', message: String(err.message || err) }));

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
