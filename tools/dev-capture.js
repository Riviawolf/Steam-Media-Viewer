'use strict';
// Development helper: boots the real app, waits for the library to load, then
// screenshots a few states and reports any renderer console errors.
//
//   npx electron tools/dev-capture.js <outputDir>
//
// It requires src/main/main.js unchanged, so nothing here affects the shipped app.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow } = require('electron');

const outDir = process.argv.find((a, i) => i > 1 && !a.startsWith('-')) || path.join(__dirname, '..', 'shots');
fs.mkdirSync(outDir, { recursive: true });

require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const logs = [];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitForWindow() {
  for (let i = 0; i < 200; i++) {
    const [w] = BrowserWindow.getAllWindows();
    if (w && !w.isDestroyed() && !w.webContents.isLoading()) return w;
    await sleep(100);
  }
  throw new Error('no window appeared');
}

async function shoot(win, name) {
  const img = await win.capturePage();
  const file = path.join(outDir, `${name}.png`);
  fs.writeFileSync(file, img.toPNG());
  console.log('SHOT', file);
}

async function evaluate(win, code) {
  return win.webContents.executeJavaScript(code, true);
}

app.whenReady().then(async () => {
  try {
    const win = await waitForWindow();
    win.setSize(1440, 900);

    win.webContents.on('console-message', (event) => {
      const level = event.level !== undefined ? event.level : arguments[1];
      logs.push(`[${level}] ${event.message !== undefined ? event.message : ''}`);
    });
    win.webContents.on('preload-error', (_e, p, err) => logs.push(`PRELOAD ERROR ${p}: ${err}`));
    win.webContents.on('render-process-gone', (_e, d) => logs.push(`RENDER GONE ${JSON.stringify(d)}`));

    // Wait for the first scan to populate the sidebar.
    let games = 0;
    for (let i = 0; i < 400; i++) {
      games = await evaluate(win, 'document.querySelectorAll(".game-row").length');
      if (games > 0) break;
      await sleep(250);
    }
    console.log('games in sidebar:', games);
    await sleep(700);
    await shoot(win, '01-library');

    const summary = await evaluate(win, `(() => ({
      games: window.state ? window.state.games.length : document.querySelectorAll('.game-row').length,
      selected: document.querySelector('#gh-name') ? document.querySelector('#gh-name').textContent : null,
      recCount: document.querySelector('#tab-count-rec') ? document.querySelector('#tab-count-rec').textContent : null,
      shotCount: document.querySelector('#tab-count-shot') ? document.querySelector('#tab-count-shot').textContent : null,
      recCards: document.querySelectorAll('.rec-card').length,
      warn: document.querySelector('#warn-banner').classList.contains('hidden') ? null : document.querySelector('#warn-banner').textContent,
      counts: document.querySelector('#all-sub').textContent,
      placeholders: document.querySelectorAll('.game-row .art.placeholder').length,
      firstGames: [...document.querySelectorAll('.game-row .title')].slice(0, 8).map(e => e.textContent),
    }))()`);
    console.log('STATE', JSON.stringify(summary, null, 1));

    // Combined view across every game.
    await evaluate(win, `document.querySelector('#all-media').click()`);
    await sleep(2500);
    await shoot(win, '01b-all-media');
    console.log('ALL MEDIA', await evaluate(win, `JSON.stringify({
      cards: document.querySelectorAll('.rec-card').length,
      labelAboveThumb: (() => {
        const c = document.querySelector('.rec-card');
        if (!c) return null;
        return c.firstElementChild && c.firstElementChild.classList.contains('card-game');
      })(),
      firstGame: (document.querySelector('.cg-name') || {}).textContent || null,
      sub: document.querySelector('#gh-sub').textContent,
    })`));
    await evaluate(win, `document.querySelector('.game-row').click()`);
    await sleep(1200);

    // Screenshots tab of whatever is selected.
    await evaluate(win, `document.querySelector('.tab[data-tab="screenshots"]').click()`);
    await sleep(2500); // let on-demand thumbnails generate
    await shoot(win, '02-screenshots');
    const shotInfo = await evaluate(win, `(() => ({
      cards: document.querySelectorAll('.shot-card').length,
      loaded: document.querySelectorAll('.shot-card img.loaded').length,
      empty: !document.querySelector('#shot-empty').classList.contains('hidden'),
    }))()`);
    console.log('SHOTS', JSON.stringify(shotInfo));

    // Open the first screenshot.
    if (shotInfo.cards > 0) {
      await evaluate(win, `document.querySelector('.shot-card').click()`);
      await sleep(1800);
      await shoot(win, '03-screenshot-viewer');
      await evaluate(win, `document.querySelector('#sh-close').click()`);
    }

    // Pick a game that has recordings and play the first one.
    const picked = await evaluate(win, `(async () => {
      const rows = [...document.querySelectorAll('.game-row')];
      for (const row of rows) {
        const sub = row.querySelector('.sub').textContent;
        if (/clip/.test(sub)) { row.click(); return row.querySelector('.title').textContent; }
      }
      return null;
    })()`);
    console.log('picked game with clips:', picked);
    await sleep(1500);
    await evaluate(win, `document.querySelector('.tab[data-tab="recordings"]').click()`);
    await sleep(600);
    await shoot(win, '04-recordings');

    const recInfo = await evaluate(win, `(() => ({
      cards: document.querySelectorAll('.rec-card').length,
      thumbs: document.querySelectorAll('.rec-thumb img').length,
      firstLabel: document.querySelector('.rec-when') ? document.querySelector('.rec-when').textContent : null,
      firstDetail: document.querySelector('.rec-detail') ? document.querySelector('.rec-detail').textContent : null,
      badges: [...document.querySelectorAll('.rec-thumb .badge')].slice(0,3).map(e=>e.textContent),
    }))()`);
    console.log('RECORDINGS', JSON.stringify(recInfo));

    if (recInfo.cards > 0) {
      await evaluate(win, `document.querySelector('.rec-card:not(.unplayable)').click()`);
      await sleep(900);
      await shoot(win, '05-preparing');
      // Give the remux + first frames time.
      for (let i = 0; i < 60; i++) {
        const st = await evaluate(win, `(() => { const v=document.querySelector('#player'); return { t: v.currentTime, rs: v.readyState, err: v.error && v.error.code, prep: !document.querySelector('#pl-prep').classList.contains('hidden'), fail: !document.querySelector('#pl-error').classList.contains('hidden'), msg: document.querySelector('#pl-error-msg').textContent }; })()`);
        if (st.fail || st.t > 0.4) {
          console.log('PLAYBACK', JSON.stringify(st));
          break;
        }
        await sleep(500);
      }
      await sleep(400);
      await shoot(win, '06-playing');
      const final = await evaluate(win, `(() => { const v=document.querySelector('#player'); return { currentTime:v.currentTime, duration:v.duration, w:v.videoWidth, h:v.videoHeight, paused:v.paused, err:v.error&&v.error.code, failShown: !document.querySelector('#pl-error').classList.contains('hidden'), failMsg: document.querySelector('#pl-error-msg').textContent }; })()`);
      console.log('PLAYER FINAL', JSON.stringify(final));
      await evaluate(win, `document.querySelector('#pl-close').click()`);
    }

    // Settings sheet.
    await evaluate(win, `document.querySelector('#btn-settings').click()`);
    await sleep(900);
    await shoot(win, '07-settings');
    const text = (sel) => `(document.querySelector('${sel}') || {}).textContent || null`;
    const setInfo = await evaluate(win, `(() => ({
      recDetected: ${text('#rec-detected')},
      shotDetected: ${text('#shot-detected')},
      recFolders: [...document.querySelectorAll('#rec-paths input')].map(i => i.value),
      shotFolders: [...document.querySelectorAll('#shot-paths input')].map(i => i.value),
      ffmpeg: ${text('#ffmpeg-status')},
      cache: ${text('#cache-stats')},
    }))()`);
    console.log('SETTINGS', JSON.stringify(setInfo, null, 1));

    console.log('\n--- renderer console ---');
    for (const l of logs) console.log(l);
    if (!logs.length) console.log('(clean)');
  } catch (err) {
    console.error('CAPTURE FAILED:', err && err.stack ? err.stack : err);
    for (const l of logs) console.log(l);
    app.exit(1);
    return;
  }
  app.exit(0);
});
