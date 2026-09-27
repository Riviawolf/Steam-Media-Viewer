'use strict';
// The only bridge between the renderer and the main process. The renderer gets
// a fixed set of calls and no direct filesystem, Node or ipcRenderer access.

const { contextBridge, ipcRenderer } = require('electron');

const listeners = {
  'scan:status': new Set(),
  'clip:progress': new Set(),
  'library:updated': new Set(),
  'update:progress': new Set(),
};

for (const channel of Object.keys(listeners)) {
  ipcRenderer.on(channel, (_event, payload) => {
    for (const fn of listeners[channel]) {
      try {
        fn(payload);
      } catch {
        // A broken subscriber must not take the others down.
      }
    }
  });
}

function subscribe(channel, fn) {
  const set = listeners[channel];
  if (!set) throw new Error(`Unknown channel: ${channel}`);
  set.add(fn);
  return () => set.delete(fn);
}

contextBridge.exposeInMainWorld('api', {
  bootstrap: () => ipcRenderer.invoke('app:bootstrap'),
  rescan: (opts) => ipcRenderer.invoke('library:rescan', opts),
  mediaFor: (appId) => ipcRenderer.invoke('library:mediaFor', appId),

  prepareClip: (clipId) => ipcRenderer.invoke('clip:prepare', clipId),
  exportClip: (clipId) => ipcRenderer.invoke('clip:export', clipId),
  screenshotThumb: (file) => ipcRenderer.invoke('screenshot:thumb', file),
  exportScreenshot: (file) => ipcRenderer.invoke('screenshot:export', file),

  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  pickFolder: (opts) => ipcRenderer.invoke('settings:pickFolder', opts),
  pickFfmpeg: () => ipcRenderer.invoke('settings:pickFfmpeg'),

  appVersion: () => ipcRenderer.invoke('app:version'),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  downloadUpdate: () => ipcRenderer.invoke('updates:download'),
  installUpdate: (file) => ipcRenderer.invoke('updates:install', file),
  openRepo: (path) => ipcRenderer.invoke('shell:openExternal', path),

  cacheStats: () => ipcRenderer.invoke('cache:stats'),
  clearCache: (what) => ipcRenderer.invoke('cache:clear', what),

  reveal: (target) => ipcRenderer.invoke('shell:reveal', target),
  openStorePage: (appId) =>
    ipcRenderer.invoke('shell:openExternal', `https://store.steampowered.com/app/${encodeURIComponent(appId)}/`),

  onScanStatus: (fn) => subscribe('scan:status', fn),
  onClipProgress: (fn) => subscribe('clip:progress', fn),
  onLibraryUpdated: (fn) => subscribe('library:updated', fn),
  onUpdateProgress: (fn) => subscribe('update:progress', fn),
});
