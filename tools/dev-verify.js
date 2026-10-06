'use strict';
// Boots the real app and drives the interaction paths that are easy to break:
// refresh, settings round-trip, clip navigation, multi-session clips and the
// unplayable-clip case. Prints PASS/FAIL per check and exits non-zero on any
// failure.
//
//   npx electron tools/dev-verify.js

const path = require('path');
const { app, BrowserWindow, clipboard } = require('electron');

require(path.join(__dirname, '..', 'src', 'main', 'main.js'));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const results = [];

// Never leave an Electron process behind if a step wedges.
const WATCHDOG_MS = 12 * 60 * 1000;
setTimeout(() => {
  console.error(`\nFAIL  watchdog: still running after ${WATCHDOG_MS / 60000} minutes, exiting`);
  app.exit(1);
}, WATCHDOG_MS).unref();

function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  | ${detail}` : ''}`);
}

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
  win.setSize(1440, 900);
  const ev = (code) => win.webContents.executeJavaScript(code, true);

  const consoleErrors = [];
  win.webContents.on('console-message', (e) => {
    if (e.level === 'error' || e.level === 3) consoleErrors.push(e.message);
  });

  // Electron logs IPC handler rejections to stderr rather than failing the
  // call, so capture those too - that is how the settings.json race showed up.
  const mainErrors = [];
  const realStderr = process.stderr.write.bind(process.stderr);
  process.stderr.write = (chunk, ...rest) => {
    const text = String(chunk);
    if (/Error occurred in handler|UnhandledPromiseRejection/.test(text)) {
      mainErrors.push(text.split('\n')[0].trim());
    }
    return realStderr(chunk, ...rest);
  };

  // --- initial load ---
  let games = 0;
  for (let i = 0; i < 400; i++) {
    games = await ev('document.querySelectorAll(".game-row").length');
    if (games > 0) break;
    await sleep(250);
  }
  check('library loads', games > 0, `${games} games`);

  const counts = await ev(`document.querySelector('#all-sub').textContent`);
  check('counts shown', /\d[\d,]* clips/.test(counts), counts);

  // --- game filter ---
  await ev(`(() => { const f = document.querySelector('#game-filter'); f.value = 'zzzznomatch'; f.dispatchEvent(new Event('input')); })()`);
  await sleep(200);
  const noMatch = await ev('document.querySelectorAll(".game-row").length');
  await ev(`(() => { const f = document.querySelector('#game-filter'); f.value = ''; f.dispatchEvent(new Event('input')); })()`);
  await sleep(200);
  const restored = await ev('document.querySelectorAll(".game-row").length');
  check('filter narrows and restores', noMatch === 0 && restored === games, `${noMatch} then ${restored}`);

  // --- unplayable clip is listed but not clickable ---
  const unplayable = await ev(`(async () => {
    for (const row of document.querySelectorAll('.game-row')) {
      const title = row.querySelector('.title').textContent;
      if (!/Non-Steam|App 1037/.test(title)) continue;
      row.click();
      return title;
    }
    return null;
  })()`);
  if (unplayable) {
    await sleep(1200);
    await ev(`(() => { const t = document.querySelector('.tab[data-tab="recordings"]'); if (t) t.click(); })()`);
    await sleep(400);
    const info = await ev(`(() => ({
      cards: document.querySelectorAll('.rec-card').length,
      unplayable: document.querySelectorAll('.rec-card.unplayable').length,
      reason: document.querySelector('.rec-card.unplayable .rec-detail')
        ? document.querySelector('.rec-card.unplayable .rec-detail').textContent : null,
    }))()`);
    check('unplayable clips listed, not playable', info.unplayable > 0 && info.unplayable === info.cards, `${info.unplayable}/${info.cards}: ${info.reason}`);
  } else {
    check('unplayable clips listed, not playable', true, 'skipped - no such game');
  }

  // --- multi-session clip prepares and plays ---
  const multi = await ev(`(async () => {
    for (const row of document.querySelectorAll('.game-row')) {
      if (row.dataset.appId === '2054970') { row.click(); return row.querySelector('.title').textContent; }
    }
    return null;
  })()`);
  if (multi) {
    await sleep(1400);
    await ev(`document.querySelector('.tab[data-tab="recordings"]').click()`);
    await sleep(500);
    const clicked = await ev(`(() => {
      const cards = [...document.querySelectorAll('.rec-card')];
      const target = cards.find(c => /parts/.test(c.textContent));
      if (!target) return false;
      target.click();
      return true;
    })()`);
    if (clicked) {
      let st = null;
      for (let i = 0; i < 90; i++) {
        st = await ev(`(() => { const v = document.querySelector('#player');
          return { t: v.currentTime, d: v.duration, w: v.videoWidth,
                   fail: !document.querySelector('#pl-error').classList.contains('hidden'),
                   msg: document.querySelector('#pl-error-msg').textContent }; })()`);
        if (st.fail || st.t > 0.4) break;
        await sleep(500);
      }
      check('multi-session clip plays', !st.fail && st.t > 0.4, st.fail ? st.msg : `t=${st.t.toFixed(2)} dur=${Number(st.d).toFixed(1)}s ${st.w}px`);
      await ev(`document.querySelector('#pl-close').click()`);
      await sleep(300);
    } else {
      check('multi-session clip plays', true, 'skipped - not in this game');
    }
  } else {
    check('multi-session clip plays', true, 'skipped - game not found');
  }

  // --- clip navigation (next/prev) and cached replay ---
  await ev(`(() => {
    for (const row of document.querySelectorAll('.game-row')) {
      const sub = row.querySelector('.sub').textContent;
      const m = /(\\d+) clips/.exec(sub);
      if (m && Number(m[1]) >= 3) { row.click(); return; }
    }
  })()`);
  await sleep(1400);
  await ev(`document.querySelector('.tab[data-tab="recordings"]').click()`);
  await sleep(500);
  await ev(`document.querySelector('.rec-card:not(.unplayable)').click()`);

  let first = null;
  for (let i = 0; i < 90; i++) {
    first = await ev(`(() => { const v = document.querySelector('#player');
      return { t: v.currentTime, fail: !document.querySelector('#pl-error').classList.contains('hidden'),
               msg: document.querySelector('#pl-error-msg').textContent,
               title: document.querySelector('#pl-title').textContent }; })()`);
    if (first.fail || first.t > 0.4) break;
    await sleep(500);
  }
  check('clip plays', !first.fail && first.t > 0.4, first.fail ? first.msg : `t=${first.t.toFixed(2)}`);

  // Two clips can share a timestamp, so compare the "N of M" position instead.
  const beforeTitle = await ev(`document.querySelector('#pl-sub').textContent`);
  await ev(`document.querySelector('#pl-next').click()`);
  let second = null;
  for (let i = 0; i < 90; i++) {
    second = await ev(`(() => { const v = document.querySelector('#player');
      return { t: v.currentTime, fail: !document.querySelector('#pl-error').classList.contains('hidden'),
               msg: document.querySelector('#pl-error-msg').textContent,
               title: document.querySelector('#pl-sub').textContent }; })()`);
    if (second.fail || second.t > 0.4) break;
    await sleep(500);
  }
  check('next clip plays', !second.fail && second.t > 0.4 && second.title !== beforeTitle,
    second.fail ? second.msg : `"${beforeTitle}" -> "${second.title}"`);

  // Going back should hit the cache and be quick.
  const t0 = Date.now();
  await ev(`document.querySelector('#pl-prev').click()`);
  let back = null;
  for (let i = 0; i < 60; i++) {
    back = await ev(`(() => { const v = document.querySelector('#player'); return { t: v.currentTime,
      prep: !document.querySelector('#pl-prep').classList.contains('hidden') }; })()`);
    if (back.t > 0.3) break;
    await sleep(200);
  }
  check('cached replay is fast', back.t > 0.3 && Date.now() - t0 < 8000, `${Date.now() - t0}ms`);
  await ev(`document.querySelector('#pl-close').click()`);
  await sleep(300);

  const cleared = await ev(`(() => { const v = document.querySelector('#player'); return !v.getAttribute('src'); })()`);
  check('closing player releases the file', cleared);

  // --- settings round-trip ---
  await ev(`document.querySelector('#btn-settings').click()`);
  await sleep(600);
  const before = await ev(`document.querySelector('#cache-limit').value`);
  await ev(`(() => { document.querySelector('#cache-limit').value = '7'; })()`);
  await ev(`document.querySelector('#set-save').click()`);
  await sleep(2500);
  const saved = await ev(`(async () => (await window.api.getSettings()).maxCacheGB)()`);
  check('settings save', Number(saved) === 7, `maxCacheGB=${saved}`);

  // put it back
  await ev(`document.querySelector('#btn-settings').click()`);
  await sleep(500);
  await ev(`(() => { document.querySelector('#cache-limit').value = '${before}'; })()`);
  await ev(`document.querySelector('#set-save').click()`);
  await sleep(2500);
  const restoredSetting = await ev(`(async () => (await window.api.getSettings()).maxCacheGB)()`);
  check('settings restore', String(restoredSetting) === String(before), `back to ${restoredSetting}`);

  // --- All media view ---
  await ev(`document.querySelector('#all-media').click()`);
  await sleep(2500);
  const allView = await ev(`(() => ({
    cards: document.querySelectorAll('.rec-card').length,
    strips: document.querySelectorAll('.card-game').length,
    named: [...document.querySelectorAll('.cg-name')].filter(e => e.textContent.trim()).length,
    title: document.querySelector('#gh-name').textContent,
    storeHidden: document.querySelector('#btn-store').classList.contains('hidden'),
    gameCount: document.querySelector('#game-count').textContent,
    allSub: document.querySelector('#all-sub').textContent,
  }))()`);
  check(
    'All media lists every clip, each labelled with its game',
    allView.cards > 0 && allView.strips === allView.cards && allView.named === allView.cards,
    `${allView.cards} cards, ${allView.named} named, title "${allView.title}"`,
  );
  check('All media hides the store link', allView.storeHidden);
  check('games total is shown', /\d+ games?/.test(allView.gameCount), allView.gameCount);

  // --- screenshot thumbnails render in the combined view ---
  await ev(`document.querySelector('.tab[data-tab="screenshots"]').click()`);
  await sleep(4000);
  const shotThumbs = await ev(`(() => {
    const frameImgs = [...document.querySelectorAll('.shot-frame img')];
    const withSrc = frameImgs.filter(i => i.getAttribute('src'));
    return {
      cards: document.querySelectorAll('.shot-card').length,
      loaded: frameImgs.filter(i => i.classList.contains('loaded')).length,
      decoded: withSrc.filter(i => i.naturalWidth > 0).length,
      // The capsule in the header must keep its own image.
      capsuleIntact: [...document.querySelectorAll('.cg-art img')]
        .every(i => !/screenshots/i.test(i.getAttribute('src') || '')),
    };
  })()`);
  check(
    'screenshot thumbnails load in All media',
    shotThumbs.cards > 0 && shotThumbs.loaded > 0 && shotThumbs.decoded > 0 && shotThumbs.capsuleIntact,
    `${shotThumbs.loaded} loaded / ${shotThumbs.decoded} decoded of ${shotThumbs.cards} cards, capsules intact: ${shotThumbs.capsuleIntact}`,
  );
  await ev(`document.querySelector('.tab[data-tab="recordings"]').click()`);
  await sleep(600);

  // --- preview size slider ---
  const notches = await ev(`document.querySelectorAll('#size-notches option').length`);
  const recW = [];
  const shotW = [];
  for (let step = 0; step < notches; step++) {
    await ev(`(() => { const s = document.querySelector('#size-slider'); s.value = '${step}';
      s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); })()`);
    await sleep(500);
    recW.push(await ev(`(() => { const c = document.querySelector('#pane-recordings .rec-card');
      return c ? Math.round(c.getBoundingClientRect().width) : 0; })()`));
    await ev(`document.querySelector('.tab[data-tab="screenshots"]').click()`);
    await sleep(700);
    shotW.push(await ev(`(() => { const c = document.querySelector('#pane-screenshots .shot-card');
      return c ? Math.round(c.getBoundingClientRect().width) : 0; })()`));
    await ev(`document.querySelector('.tab[data-tab="recordings"]').click()`);
    await sleep(350);
  }

  // Every notch must be visibly bigger than the last, not merely different:
  // adjacent steps that land on the same column count look identical.
  const growsEnough = recW.every((w, i) => i === 0 || w >= recW[i - 1] * 1.12);
  check(
    'each size notch is a visibly different size',
    notches === 5 && growsEnough,
    `${recW.join('px, ')}px across ${notches} notches`,
  );
  check(
    'recordings and screenshots are the same size at every notch',
    recW.every((w, i) => w === shotW[i]),
    `recordings ${recW.join('/')} vs screenshots ${shotW.join('/')}`,
  );

  // Back to the default step, and confirm it was persisted.
  await ev(`(() => { const s = document.querySelector('#size-slider'); s.value = '2';
    s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); })()`);
  await sleep(900);
  const savedScale = await ev(`(async () => (await window.api.getSettings()).cardScale)()`);
  check('preview size persists', savedScale === 2, `cardScale=${savedScale}`);

  // --- right-click menus ---
  const openMenu = async (selector) => {
    await ev(`(() => {
      const c = document.querySelector('${selector}');
      if (!c) return false;
      const r = c.getBoundingClientRect();
      c.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, clientX: r.left + 40, clientY: r.top + 40 }));
      return true;
    })()`);
    await sleep(350);
    return ev(`[...document.querySelectorAll('#context-menu .cm-item')].map(b => b.textContent)`);
  };

  await ev(`document.querySelector('.tab[data-tab="recordings"]').click()`);
  await sleep(500);
  const clipMenu = await openMenu('#pane-recordings .rec-card');
  check(
    'right-clicking a clip offers Export Video',
    clipMenu.some((l) => /^Export Video/.test(l)),
    clipMenu.join(' | '),
  );

  // Dismissal has to work, or the menu would stick around over everything.
  await ev(`document.querySelector('#game-list').dispatchEvent(new MouseEvent('mousedown', { bubbles: true }))`);
  await sleep(250);
  const dismissed = await ev(`document.querySelector('#context-menu').classList.contains('hidden')`);
  check('the menu closes when you click elsewhere', dismissed);

  await ev(`document.querySelector('.tab[data-tab="screenshots"]').click()`);
  await sleep(2500);
  const shotMenu = await openMenu('#pane-screenshots .shot-card');
  check(
    'right-clicking a screenshot offers Copy to Clipboard and Save As',
    shotMenu.some((l) => /Copy to Clipboard/.test(l)) && shotMenu.some((l) => /^Save As/.test(l)),
    shotMenu.join(' | '),
  );
  await ev(`document.querySelector('#context-menu').classList.add('hidden')`);

  // Copying puts a real image on the clipboard, so keep whatever was there.
  const heldText = clipboard.readText();
  const copied = await ev(`(async () => {
    const m = await window.api.mediaFor('__all__');
    const shot = m.screenshots[0];
    if (!shot) return { ok: false, message: 'no screenshots' };
    return window.api.copyImage(shot.file);
  })()`);
  const onClipboard = clipboard.readImage();
  check(
    'Copy to Clipboard puts the image on the clipboard',
    copied.ok && !onClipboard.isEmpty() && onClipboard.getSize().width === copied.width,
    copied.ok ? `${copied.width}x${copied.height}` : copied.message,
  );
  clipboard.clear();
  if (heldText) clipboard.writeText(heldText);

  await ev(`document.querySelector('.tab[data-tab="recordings"]').click()`);
  await sleep(500);

  // --- sort by length ---
  const durations = async () =>
    ev(`[...document.querySelectorAll('#pane-recordings .rec-card .badge:not(.drive):not(.left)')]
        .map(e => e.textContent.trim())
        .map(t => { const p = t.split(':').map(Number); return p.length === 3 ? p[0]*3600 + p[1]*60 + p[2] : p[0]*60 + p[1]; })`);

  const setSort = async (value) => {
    await ev(`(() => { const s = document.querySelector('#sort-order'); s.value = '${value}'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(700);
  };

  await setSort('longest');
  const longest = await durations();
  await setSort('shortest');
  const shortest = await durations();
  await setSort('newest');
  await sleep(400);

  const descending = longest.every((d, i) => i === 0 || d <= longest[i - 1]);
  const ascending = shortest.every((d, i) => i === 0 || d >= shortest[i - 1]);
  check(
    'sort by length orders clips both ways',
    longest.length > 1 && descending && ascending && longest[0] >= shortest[0],
    `longest starts ${longest.slice(0, 3).join('s, ')}s; shortest starts ${shortest.slice(0, 3).join('s, ')}s`,
  );

  // Screenshots have no length, so that tab must not end up scrambled.
  await setSort('longest');
  await ev(`document.querySelector('.tab[data-tab="screenshots"]').click()`);
  await sleep(1500);
  const shotOrder = await ev(`[...document.querySelectorAll('#pane-screenshots .shot-card .cap')].slice(0, 12).map(e => e.textContent)`);
  const shotDates = shotOrder.map((t) => Date.parse(t)).filter((n) => !Number.isNaN(n));
  check(
    'screenshots stay in date order when sorting by length',
    shotDates.length > 1 && shotDates.every((d, i) => i === 0 || d <= shotDates[i - 1]),
    `${shotDates.length} captions checked`,
  );
  await ev(`document.querySelector('.tab[data-tab="recordings"]').click()`);
  await setSort('newest');

  // --- date filter ---
  const beforeDate = await ev(`document.querySelectorAll('.rec-card').length`);
  await ev(`(() => { const d = document.querySelector('#date-filter'); d.value = '30'; d.dispatchEvent(new Event('change')); })()`);
  await sleep(1200);
  const afterDate = await ev(`(() => ({
    cards: document.querySelectorAll('.rec-card').length,
    note: document.querySelector('#filter-note').textContent,
    noteShown: !document.querySelector('#filter-note').classList.contains('hidden'),
  }))()`);
  check(
    'date filter narrows the list and says so',
    afterDate.cards < beforeDate && afterDate.noteShown && /Showing/.test(afterDate.note),
    `${beforeDate} -> ${afterDate.cards}; "${afterDate.note}"`,
  );
  await ev(`(() => { const d = document.querySelector('#date-filter'); d.value = 'all'; d.dispatchEvent(new Event('change')); })()`);
  await sleep(900);
  const restoredCount = await ev(`document.querySelectorAll('.rec-card').length`);
  check('clearing the date filter restores the list', restoredCount === beforeDate, `${restoredCount}`);

  // --- drive filter, only meaningful across drives ---
  const driveInfo = await ev(`(async () => {
    const lib = (await window.api.bootstrap()).library;
    return {
      drives: (lib.drives || []).map(d => d.drive),
      visible: !document.querySelector('#drive-wrap').classList.contains('hidden'),
    };
  })()`);
  // Pick a drive that actually holds recordings, since that is the pane counted.
  const recordingDrives = await ev(`(async () => {
    const lib = (await window.api.bootstrap()).library;
    return (lib.drives || []).filter(d => d.recordings > 0).map(d => d.drive);
  })()`);

  if (driveInfo.drives.length > 1 && recordingDrives.length) {
    // Baseline before any drive filtering.
    const gamesAll = await ev(`document.querySelectorAll('.game-row').length`);

    const target = recordingDrives[0];
    await ev(`(() => { const s = document.querySelector('#drive-filter'); s.value = '${target}'; s.dispatchEvent(new Event('change')); })()`);
    await sleep(1200);
    // Scope to the visible pane: the hidden one keeps its own cards and badges.
    const filtered = await ev(`(() => ({
      cards: document.querySelectorAll('#pane-recordings .rec-card').length,
      drives: [...new Set([...document.querySelectorAll('#pane-recordings .badge.drive')].map(e => e.textContent))],
    }))()`);
    check(
      'drive filter shows only that drive',
      filtered.drives.length === 1 && filtered.drives[0] === target,
      `${target}: ${filtered.cards} cards, badges ${JSON.stringify(filtered.drives)}`,
    );
    const perDrive = {};
    for (const d of driveInfo.drives) {
      await ev(`(() => { const s = document.querySelector('#drive-filter'); s.value = '${d}'; s.dispatchEvent(new Event('change')); })()`);
      await sleep(900);
      perDrive[d] = await ev(`(() => ({
        games: document.querySelectorAll('.game-row').length,
        label: document.querySelector('#game-count').textContent,
        emptySubs: [...document.querySelectorAll('.game-row .sub')].filter(s => !s.textContent.trim()).length,
      }))()`);
    }
    check(
      'drive filter narrows the game list too',
      driveInfo.drives.every((d) => perDrive[d].games > 0 && perDrive[d].games <= gamesAll && perDrive[d].emptySubs === 0) &&
        driveInfo.drives.some((d) => perDrive[d].games < gamesAll),
      `all ${gamesAll}; ` + driveInfo.drives.map((d) => `${d} ${perDrive[d].games} ("${perDrive[d].label}")`).join(', '),
    );

    await ev(`(() => { const s = document.querySelector('#drive-filter'); s.value = ''; s.dispatchEvent(new Event('change')); })()`);
    await sleep(900);
    const restoredGames = await ev(`document.querySelectorAll('.game-row').length`);
    check('clearing the drive filter restores the game list', restoredGames === gamesAll, `${restoredGames}`);
  } else {
    check('drive filter hidden for a single drive', !driveInfo.visible, `drives: ${driveInfo.drives.join(',')}`);
  }

  // Back to a normal game before the settings checks.
  await ev(`document.querySelector('.game-row').click()`);
  await sleep(1200);

  // --- path box always reflects the folder actually in use ---
  await ev(`document.querySelector('#btn-settings').click()`);
  await sleep(600);
  const firstBox = () => `document.querySelector('#rec-paths input')`;
  const setMode = (value) => ev(`(() => {
    const r = document.querySelector('input[name="rec-mode"][value="${value}"]');
    r.checked = true;
    r.dispatchEvent(new Event('change'));
  })()`);

  const SENTINEL = 'Z:\\OnlyInCustomMode';

  // Seed a custom folder through the API: the list can legitimately be empty,
  // in which case there is no row to type into.
  const savedRecordings = await ev(`(async () => (await window.api.getSettings()).recordings)()`);
  await ev(`(async () => await window.api.setSettings({
    recordings: { mode: 'steam', customPaths: [${JSON.stringify(SENTINEL)}] }
  }))()`);
  await sleep(1200);
  await ev(`document.querySelector('#set-close').click()`);
  await sleep(200);
  await ev(`document.querySelector('#btn-settings').click()`);
  await sleep(700);

  await setMode('steam');
  await sleep(250);
  const defaultShown = await ev(`(() => { const b = ${firstBox()}; return b ? { value: b.value, disabled: b.disabled } : null; })()`);

  await setMode('custom');
  await sleep(250);
  const inCustom = await ev(`(() => { const b = ${firstBox()}; return b ? b.value : ''; })()`);

  await setMode('steam');
  await sleep(250);
  const afterSwitch = await ev(`(() => ({
    values: [...document.querySelectorAll('#rec-paths input')].map(i => i.value),
    disabled: [...document.querySelectorAll('#rec-paths input')].every(i => i.disabled),
  }))()`);

  await setMode('custom');
  await sleep(250);
  const backInCustom = await ev(`(() => { const b = ${firstBox()}; return b ? b.value : ''; })()`);

  check(
    '"Steam default" hides custom folders; switching back keeps them',
    afterSwitch.disabled &&
      !afterSwitch.values.includes(SENTINEL) &&
      afterSwitch.values[0] === defaultShown.value &&
      inCustom === SENTINEL &&
      backInCustom === SENTINEL,
    `default shows "${afterSwitch.values.join(', ')}", custom keeps "${backInCustom}"`,
  );

  // Recordings and screenshots must offer the same folder-list capability, so
  // put both into custom mode with a folder present before comparing.
  const savedScreenshots = await ev(`(async () => (await window.api.getSettings()).screenshots)()`);
  await ev(`(async () => await window.api.setSettings({
    recordings: { mode: 'steam', customPaths: [${JSON.stringify(SENTINEL)}] },
    screenshots: { mode: 'steam', customPaths: [${JSON.stringify(SENTINEL)}] }
  }))()`);
  await sleep(1200);
  await ev(`document.querySelector('#set-close').click()`);
  await sleep(200);
  await ev(`document.querySelector('#btn-settings').click()`);
  await sleep(700);
  for (const name of ['rec-mode', 'shot-mode']) {
    await ev(`(() => { const r = document.querySelector('input[name="${name}"][value="custom"]');
      r.checked = true; r.dispatchEvent(new Event('change')); })()`);
  }
  await sleep(300);

  const parity = await ev(`(() => {
    const rows = (id) => document.querySelectorAll('#' + id + ' .path-row').length;
    const addBtn = (id) => Boolean([...document.querySelectorAll('#' + id + ' button')]
      .find(b => /Add folder/.test(b.textContent)));
    const removeBtn = (id) => Boolean([...document.querySelectorAll('#' + id + ' button')]
      .find(b => /Remove/.test(b.textContent)));
    return {
      rec: { rows: rows('rec-paths'), add: addBtn('rec-paths'), remove: removeBtn('rec-paths') },
      shot: { rows: rows('shot-paths'), add: addBtn('shot-paths'), remove: removeBtn('shot-paths') },
    };
  })()`);
  check(
    'both folder lists support adding and removing folders',
    parity.rec.rows === 1 &&
      parity.shot.rows === 1 &&
      parity.rec.add &&
      parity.shot.add &&
      parity.rec.remove &&
      parity.shot.remove,
    `recordings ${JSON.stringify(parity.rec)}, screenshots ${JSON.stringify(parity.shot)}`,
  );

  // Emptying the custom folder list must put the mode back to Steam default,
  // rather than leaving the radio on Custom while behaving as default.
  await ev(`(async () => await window.api.setSettings({
    recordings: { mode: 'custom', customPaths: [${JSON.stringify(SENTINEL)}] }
  }))()`);
  await sleep(1200);
  const wentCustom = await ev(`(async () => (await window.api.getSettings()).recordings.mode)()`);
  await ev(`(async () => await window.api.setSettings({
    recordings: { mode: 'custom', customPaths: [] }
  }))()`);
  await sleep(1500);
  const afterEmptying = await ev(`(async () => (await window.api.getSettings()).recordings)()`);
  await ev(`document.querySelector('#set-close').click()`);
  await sleep(200);
  await ev(`document.querySelector('#btn-settings').click()`);
  await sleep(700);
  const radioShown = await ev(`document.querySelector('input[name="rec-mode"]:checked').value`);
  check(
    'removing every custom folder reverts to Steam default',
    wentCustom === 'custom' && afterEmptying.mode === 'steam' && radioShown === 'steam',
    `custom -> empty gives mode "${afterEmptying.mode}", radio "${radioShown}"`,
  );
  await ev(`document.querySelector('#set-close').click()`);
  await sleep(300);

  // Content must not sit under the Windows caption buttons, since the app
  // draws its own title bar.
  const caption = await ev(`(() => {
    const bar = document.querySelector('#titlebar').getBoundingClientRect();
    const actions = document.querySelector('.tb-actions').getBoundingClientRect();
    const drag = getComputedStyle(document.querySelector('#titlebar')).webkitAppRegion;
    return {
      gap: Math.round(innerWidth - actions.right),
      barTop: Math.round(bar.top),
      barHeight: Math.round(bar.height),
      draggable: drag,
      buttonsDraggable: getComputedStyle(document.querySelector('#btn-settings')).webkitAppRegion,
    };
  })()`);
  check(
    'title bar leaves room for the caption buttons and is draggable',
    caption.gap >= 140 &&
      caption.barTop === 0 &&
      caption.draggable === 'drag' &&
      caption.buttonsDraggable === 'no-drag',
    `${caption.gap}px clear, bar ${caption.barHeight}px at y=${caption.barTop}, drag=${caption.draggable}/${caption.buttonsDraggable}`,
  );

  // --- ffmpeg provenance ---
  const ffmpeg = await ev(`(async () => {
    const lib = (await window.api.bootstrap()).library;
    return { source: lib.ffmpegSource, path: lib.ffmpeg, has: lib.hasFfmpeg };
  })()`);
  check(
    'uses the bundled ffmpeg, not one from PATH',
    ffmpeg.has && ffmpeg.source === 'bundled' && /vendor[\\/]ffmpeg|resources[\\/]ffmpeg/i.test(ffmpeg.path),
    `${ffmpeg.source}: ${ffmpeg.path}`,
  );

  await ev(`document.querySelector('#btn-settings').click()`);
  await sleep(600);
  const ffmpegUi = await ev(`(() => ({
    status: document.querySelector('#ffmpeg-status').textContent,
    location: document.querySelector('#ffmpeg-location').textContent,
  }))()`);
  check(
    'settings says ffmpeg is bundled and where it is',
    /Bundled with the app/.test(ffmpegUi.status) && ffmpegUi.location.length > 0,
    `"${ffmpegUi.status}" | ${ffmpegUi.location}`,
  );
  await ev(`document.querySelector('#set-close').click()`);
  await sleep(300);

  // --- updates ---
  const build = await ev(`(async () => await window.api.appVersion())()`);
  check(
    'reports its own version, not Electron\'s',
    /^\d+\.\d+\.\d+$/.test(build.version) && build.version !== process.versions.electron,
    `version ${build.version}, repo ${build.repository}`,
  );

  await ev(`document.querySelector('#btn-settings').click()`);
  await sleep(600);
  await ev(`document.querySelector('#check-updates').click()`);
  await sleep(6000);
  const update = await ev(`(() => ({
    shown: document.querySelector('#app-version').textContent,
    status: document.querySelector('#update-status').textContent,
    buttonEnabled: !document.querySelector('#check-updates').disabled,
  }))()`);
  check(
    'update check reports a result',
    /^Version \d+\.\d+\.\d+$/.test(update.shown) &&
      update.status.length > 0 &&
      !/^Checking/.test(update.status) &&
      update.buttonEnabled,
    `"${update.shown}" | "${update.status}"`,
  );

  // External links are limited to the Steam store and this project's repo.
  const links = await ev(`(async () => ({
    repo: await window.api.openRepo('https://github.com/Riviawolf/Steam-Media-Viewer/releases'),
    elsewhere: await window.api.openRepo('https://example.com/'),
    lookalike: await window.api.openRepo('https://github.com/Riviawolf/Steam-Media-Viewer.attacker.net/x'),
  }))()`);
  check(
    'only opens links to the store and this repository',
    links.repo === true && links.elsewhere === false && links.lookalike === false,
    `repo=${links.repo} other=${links.elsewhere} lookalike=${links.lookalike}`,
  );
  await ev(`document.querySelector('#set-close').click()`);
  await sleep(300);

  // No em dashes in text this project authors. The DOM is not a safe place to
  // check: game names come from Steam and some legitimately contain one.
  const authored = ['src/renderer/index.html', 'src/renderer/app.js']
    .flatMap((file) => {
      const text = require('fs').readFileSync(require('path').join(__dirname, '..', file), 'utf8');
      return text
        .split(/\r?\n/)
        .map((line, i) => ({ file, line: i + 1, text: line }))
        .filter((l) => /[—–]/.test(l.text));
    });
  check(
    'no em dashes in text this project writes',
    authored.length === 0,
    authored.slice(0, 3).map((l) => `${l.file}:${l.line}`).join(', '),
  );

  // Restore the folder settings these checks seeded.
  await ev(`(async () => await window.api.setSettings({
    recordings: ${JSON.stringify(savedRecordings)},
    screenshots: ${JSON.stringify(savedScreenshots)}
  }))()`);
  await sleep(1200);
  await ev(`document.querySelector('#set-close').click()`);
  await sleep(300);

  // --- a changed Steam recording path is picked up by Refresh ---
  const detectedBefore = await ev(`(async () => (await window.api.bootstrap()).library.detected.recordingsRoot)()`);
  await ev(`document.querySelector('#btn-refresh').click()`);
  await sleep(2500);
  const detectedAfter = await ev(`(async () => (await window.api.bootstrap()).library.detected.recordingsRoot)()`);
  check('Refresh re-reads Steam config', detectedBefore === detectedAfter && Boolean(detectedAfter), String(detectedAfter));

  // --- refresh ---
  const t1 = Date.now();
  await ev(`document.querySelector('#btn-refresh').click()`);
  await sleep(500);
  let after = 0;
  for (let i = 0; i < 200; i++) {
    const busy = await ev(`document.querySelector('#btn-refresh').disabled`);
    after = await ev('document.querySelectorAll(".game-row").length');
    if (!busy && after > 0) break;
    await sleep(250);
  }
  check('refresh keeps the library', after === games, `${after} games in ${Date.now() - t1}ms`);

  // --- concurrent saves (view preferences persist as you click around) ---
  const concurrent = await ev(`(async () => {
    try {
      await Promise.all([...Array(12)].map((_, i) =>
        window.api.setSettings({ sortOrder: i % 2 ? 'oldest' : 'newest' })));
      return { ok: true };
    } catch (e) {
      return { ok: false, msg: String(e && e.message || e) };
    }
  })()`);
  check('concurrent settings saves do not race', concurrent.ok, concurrent.msg || '12 parallel writes');

  const leftovers = await ev(`(async () => (await window.api.getSettings()).sortOrder)()`);
  check('settings still readable after stress', typeof leftovers === 'string', String(leftovers));

  // Leave the preference as it was found rather than however the stress ended.
  await ev(`(async () => await window.api.setSettings({ sortOrder: 'newest' }))()`);
  await sleep(600);

  check('no main-process errors', mainErrors.length === 0, mainErrors.slice(0, 2).join(' | '));
  check('no renderer console errors', consoleErrors.length === 0, consoleErrors.slice(0, 3).join(' | '));

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
  app.exit(failed.length ? 1 : 0);
}).catch((err) => {
  // Without this the window would sit open forever on an unexpected throw.
  console.error('\nFAIL  harness error:', err && err.stack ? err.stack : err);
  app.exit(1);
});
