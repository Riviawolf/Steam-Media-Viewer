'use strict';
// Checks that settings survive quitting and relaunching, by running as two
// separate app launches:
//
//   npx electron tools/dev-persist.js write <folder>   - set a custom screenshots folder, quit
//   npx electron tools/dev-persist.js read  <folder>   - relaunch and confirm it stuck
//   npx electron tools/dev-persist.js reset            - back to the Steam default

const path = require('path');
const { app, BrowserWindow } = require('electron');

require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const mode = process.argv[2];
const folder = process.argv[3] || '';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForWindow() {
  for (let i = 0; i < 200; i++) {
    const [w] = BrowserWindow.getAllWindows();
    if (w && !w.isDestroyed() && !w.webContents.isLoading()) return w;
    await sleep(100);
  }
  throw new Error('no window');
}

app.whenReady().then(async () => {
  const win = await waitForWindow();
  const ev = (code) => win.webContents.executeJavaScript(code, true);

  for (let i = 0; i < 400; i++) {
    if (await ev('document.querySelectorAll(".game-row").length')) break;
    await sleep(250);
  }

  if (mode === 'write') {
    await ev(`(async () => await window.api.setSettings({
      screenshots: { mode: 'custom', customPaths: [${JSON.stringify(folder)}] }
    }))()`);
    await sleep(3000);
    const now = await ev(`(async () => await window.api.getSettings())()`);
    console.log('WROTE  mode=%s path=%s', now.screenshots.mode, (now.screenshots.customPaths || [])[0]);
  } else if (mode === 'reset') {
    await ev(`(async () => await window.api.setSettings({
      screenshots: { mode: 'steam', customPaths: [] }
    }))()`);
    await sleep(3000);
    const now = await ev(`(async () => await window.api.getSettings())()`);
    console.log('RESET  mode=%s', now.screenshots.mode);
  } else {
    const now = await ev(`(async () => await window.api.getSettings())()`);
    const lib = await ev(`(async () => (await window.api.bootstrap()).library)()`);
    const shown = await ev(`document.querySelector('#all-sub').textContent`);
    const ok = now.screenshots.mode === 'custom' && (now.screenshots.customPaths || [])[0] === folder;
    console.log('READ   mode=%s path=%s', now.screenshots.mode, (now.screenshots.customPaths || [])[0]);
    console.log('       scanning: %s', JSON.stringify(lib.paths.screenshots));
    console.log('       counts:   %s', shown);
    console.log(ok ? 'PASS  setting survived restart' : 'FAIL  setting did not survive restart');
    app.exit(ok ? 0 : 1);
    return;
  }
  app.exit(0);
});
