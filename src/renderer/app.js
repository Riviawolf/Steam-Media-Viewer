'use strict';
// Renderer. Talks to the main process only through window.api (see preload.js).
// Holds no filesystem knowledge beyond the file:// URLs main hands it.

const $ = (id) => document.getElementById(id);

/** Matches ALL_GAMES in the main process. */
const ALL_GAMES = '__all__';

const state = {
  settings: null,
  library: null,
  games: [],
  filter: '',
  selectedAppId: null,
  tab: 'recordings',
  media: { recordings: [], screenshots: [] },
  // View filters, applied on top of whatever the sidebar selected.
  driveFilter: '',
  dateFilter: 'all',
  // Index of what the overlays are showing, for prev/next.
  playingIndex: -1,
  shotIndex: -1,
  preparing: null,
  // Last update-check result, so reopening settings does not re-query.
  update: null,
};

/* ---------------- formatting ---------------- */

function fmtDuration(seconds) {
  if (!seconds || seconds < 0) return '';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  const pad = (n) => String(n).padStart(2, '0');
  return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const n = bytes / 1024 ** i;
  return `${n >= 100 || i === 0 ? Math.round(n) : n.toFixed(1)} ${units[i]}`;
}

const DATE_FMT = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
});

// Clips recorded in the same minute would otherwise look identical in the
// player, so the precise form adds seconds.
const DATE_FMT_PRECISE = new Intl.DateTimeFormat(undefined, {
  year: 'numeric',
  month: 'short',
  day: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  second: '2-digit',
});

function fmtWhen(ms) {
  return ms ? DATE_FMT.format(new Date(ms)) : 'Unknown date';
}

function fmtWhenPrecise(ms) {
  return ms ? DATE_FMT_PRECISE.format(new Date(ms)) : 'Unknown date';
}

function fmtRelative(ms) {
  if (!ms) return '';
  const days = Math.floor((Date.now() - ms) / 86400000);
  if (days <= 0) return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30) return `${days}d ago`;
  if (days < 365) return `${Math.floor(days / 30)}mo ago`;
  return `${Math.floor(days / 365)}y ago`;
}

/** Windows paths differ only cosmetically in case and trailing slashes. */
function samePath(a, b) {
  const norm = (p) =>
    String(p || '')
      .replace(/[\\/]+$/, '')
      .replace(/\//g, '\\')
      .toLowerCase();
  return Boolean(a) && norm(a) === norm(b);
}

function initialsFor(name) {
  return String(name || '?')
    .replace(/[^A-Za-z0-9 ]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0].toUpperCase())
    .join('') || '?';
}

/* ---------------- preview size ---------------- */

// Multipliers on --card-base, which both grids share. Index 2 is the default,
// so the slider starts where the layout was designed.
//
// The grid fills whole columns, so card width jumps in steps rather than
// varying smoothly. These values are spaced far enough apart that every notch
// lands on a different column count at common window widths; closer spacing
// makes adjacent notches look identical.
const CARD_SCALES = [0.6, 0.78, 1, 1.4, 2.1];

function applyCardScale(index) {
  const i = Math.max(0, Math.min(CARD_SCALES.length - 1, Number(index)));
  // Set through CSSOM rather than a style attribute, which the CSP blocks.
  document.documentElement.style.setProperty('--card-scale', String(CARD_SCALES[i]));
  return i;
}

/* ---------------- sidebar ---------------- */

/** Counts for a game under the current drive filter. */
function gameCounts(game) {
  if (!state.driveFilter) return { recordings: game.recordings, screenshots: game.screenshots };
  const onDrive = (game.byDrive || {})[state.driveFilter];
  return onDrive ? { ...onDrive } : { recordings: 0, screenshots: 0 };
}

/** Games left after the drive filter: the sidebar should not list empty ones. */
function visibleGames() {
  if (!state.driveFilter) return state.games;
  return state.games.filter((g) => {
    const c = gameCounts(g);
    return c.recordings > 0 || c.screenshots > 0;
  });
}

function renderGameList() {
  const list = $('game-list');
  const needle = state.filter.trim().toLowerCase();
  const onDrive = visibleGames();
  const games = needle
    ? onDrive.filter((g) => g.name.toLowerCase().includes(needle) || g.appId.includes(needle))
    : onDrive;

  const total = state.games.length;
  $('game-count').textContent =
    games.length === total
      ? `${total} game${total === 1 ? '' : 's'}`
      : `${games.length} of ${total} games`;
  $('all-media').classList.toggle('active', state.selectedAppId === ALL_GAMES);

  list.textContent = '';

  if (!games.length) {
    const p = document.createElement('p');
    p.className = 'pane-empty small';
    p.textContent = state.games.length ? 'No games match that filter.' : 'No games found.';
    list.append(p);
    return;
  }

  const frag = document.createDocumentFragment();
  for (const g of games) {
    const row = document.createElement('button');
    row.className = `game-row${g.appId === state.selectedAppId ? ' active' : ''}`;
    row.setAttribute('role', 'option');
    row.setAttribute('aria-selected', String(g.appId === state.selectedAppId));
    row.dataset.appId = g.appId;

    const art = document.createElement('div');
    art.className = 'art';
    if (g.artUrl) {
      const img = document.createElement('img');
      img.src = g.artUrl;
      img.alt = '';
      img.loading = 'lazy';
      // If the cached art file has gone, fall back to the initials tile.
      img.addEventListener('error', () => {
        img.remove();
        art.classList.add('placeholder');
        art.dataset.initials = initialsFor(g.name);
      });
      art.append(img);
    } else {
      art.classList.add('placeholder');
      art.dataset.initials = initialsFor(g.name);
    }

    const info = document.createElement('div');
    info.className = 'info';
    const title = document.createElement('span');
    title.className = 'title';
    title.textContent = g.name;
    title.title = `${g.name} (app ${g.appId})`;
    const sub = document.createElement('span');
    sub.className = 'sub';
    const counts = gameCounts(g);
    const bits = [];
    if (counts.recordings) bits.push(`${counts.recordings} clip${counts.recordings === 1 ? '' : 's'}`);
    if (counts.screenshots) bits.push(`${counts.screenshots} shot${counts.screenshots === 1 ? '' : 's'}`);
    sub.textContent = bits.join(' · ');
    info.append(title, sub);

    row.append(art, info);
    row.addEventListener('click', () => selectGame(g.appId));
    frag.append(row);
  }
  list.append(frag);
}

/* ---------------- game view ---------------- */

async function selectGame(appId) {
  state.selectedAppId = appId;
  renderGameList();

  const isAll = appId === ALL_GAMES;
  const game = isAll ? null : state.games.find((g) => g.appId === appId);
  if (!isAll && !game) return;

  $('empty-state').classList.add('hidden');
  $('game-view').classList.remove('hidden');

  const img = $('gh-img');
  if (!isAll && game.artUrl) {
    img.src = game.artUrl;
    img.style.visibility = 'visible';
  } else {
    img.removeAttribute('src');
    img.style.visibility = 'hidden';
  }
  $('gh-art').classList.toggle('hidden', isAll);

  if (isAll) {
    const counts = state.library.counts;
    $('gh-name').textContent = 'All Media';
    const drives = state.library.drives || [];
    const sub = [
      `${state.games.length} games`,
      `${counts.recordings.toLocaleString()} recordings`,
      `${counts.screenshots.toLocaleString()} screenshots`,
    ];
    if (drives.length > 1) {
      sub.push(`across ${drives.length} drives (${drives.map((d) => d.drive).join(', ')})`);
    }
    $('gh-sub').textContent = sub.join(' · ');
  } else {
    $('gh-name').textContent = game.name;
    const sub = [];
    if (game.recordings) sub.push(`${game.recordings} recording${game.recordings === 1 ? '' : 's'}`);
    if (game.screenshots) sub.push(`${game.screenshots} screenshot${game.screenshots === 1 ? '' : 's'}`);
    if (game.totalDuration) sub.push(`${fmtDuration(game.totalDuration)} total`);
    sub.push(`app ${game.appId}`);
    $('gh-sub').textContent = sub.join(' · ');
  }

  // A store link means nothing for the combined view.
  $('btn-store').classList.toggle('hidden', isAll);
  $('btn-store').disabled = isAll || !/^\d{1,10}$/.test(game.appId);

  state.media = await window.api.mediaFor(appId);
  $('tab-count-rec').textContent = state.media.recordings.length;
  $('tab-count-shot').textContent = state.media.screenshots.length;

  // Land on a tab that actually has something in it.
  if (state.tab === 'recordings' && !state.media.recordings.length && state.media.screenshots.length) {
    setTab('screenshots');
  } else if (state.tab === 'screenshots' && !state.media.screenshots.length && state.media.recordings.length) {
    setTab('recordings');
  } else {
    renderCurrentTab();
  }

}

function setTab(tab) {
  state.tab = tab;
  for (const btn of document.querySelectorAll('.tab')) {
    const on = btn.dataset.tab === tab;
    btn.classList.toggle('active', on);
    btn.setAttribute('aria-selected', String(on));
  }
  $('pane-recordings').classList.toggle('hidden', tab !== 'recordings');
  $('pane-screenshots').classList.toggle('hidden', tab !== 'screenshots');
  renderCurrentTab();
}

/** Drive + date filters, then the chosen sort. One place, so every view agrees. */
function sorted(items) {
  const cutoff =
    state.dateFilter === 'all' ? null : Date.now() - Number(state.dateFilter) * 86400000;

  const copy = items.filter((item) => {
    if (state.driveFilter && item.drive !== state.driveFilter) return false;
    if (cutoff !== null && (item.recordedAt || 0) < cutoff) return false;
    return true;
  });

  copy.sort((a, b) =>
    state.settings.sortOrder === 'oldest'
      ? (a.recordedAt || 0) - (b.recordedAt || 0)
      : (b.recordedAt || 0) - (a.recordedAt || 0),
  );
  return copy;
}

/**
 * Empty-list wording that matches why it's empty: filters hiding everything
 * reads very differently from a game genuinely having none.
 */
function emptyMessage(kind, totalBeforeFilters) {
  const filtered = state.driveFilter || state.dateFilter !== 'all';
  if (totalBeforeFilters > 0 && filtered) return `No ${kind} match the current filters.`;
  if (state.selectedAppId === ALL_GAMES) return `No ${kind} found.`;
  return `No ${kind} for this game.`;
}

/** Says what the filters are hiding, so an empty-looking list is never a mystery. */
function updateFilterNote() {
  const note = $('filter-note');
  const total = state.media.recordings.length + state.media.screenshots.length;
  const shown = sorted(state.media.recordings).length + sorted(state.media.screenshots).length;

  if (shown === total) {
    note.classList.add('hidden');
    return;
  }
  const bits = [];
  if (state.driveFilter) bits.push(`drive ${state.driveFilter}`);
  if (state.dateFilter !== 'all') bits.push(`last ${state.dateFilter} days`);
  note.textContent = `Showing ${shown.toLocaleString()} of ${total.toLocaleString()} items, filtered by ${bits.join(' and ')}.`;
  note.classList.remove('hidden');
}

function renderCurrentTab() {
  if (state.tab === 'recordings') renderRecordings();
  else renderScreenshots();
  updateFilterNote();
}

/** True when the library spans more than one drive, so badges are worth showing. */
function multiDrive() {
  return Boolean(state.library && state.library.drives && state.library.drives.length > 1);
}

/** The "which game is this?" strip shown on cards in the All media view. */
function gameStrip(item) {
  if (state.selectedAppId !== ALL_GAMES) return null;
  const strip = document.createElement('div');
  strip.className = 'card-game';

  const art = document.createElement('span');
  art.className = 'cg-art';
  if (item.gameArtUrl) {
    const img = document.createElement('img');
    img.src = item.gameArtUrl;
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.remove());
    art.append(img);
  }

  const name = document.createElement('span');
  name.className = 'cg-name';
  name.textContent = item.gameName || `App ${item.appId}`;
  name.title = name.textContent;

  strip.append(art, name);
  return strip;
}

function renderRecordings() {
  const wrap = $('rec-list');
  wrap.textContent = '';
  const items = sorted(state.media.recordings);
  $('rec-empty').textContent = emptyMessage('recordings', state.media.recordings.length);
  $('rec-empty').classList.toggle('hidden', items.length > 0);

  const frag = document.createDocumentFragment();
  items.forEach((clip, index) => {
    const card = document.createElement('button');
    card.className = `rec-card${clip.playable ? '' : ' unplayable'}`;
    // Identical recordings can exist in two folders, so say which one this is.
    card.title = clip.dir;

    const thumb = document.createElement('div');
    thumb.className = 'rec-thumb';
    if (clip.thumbnailUrl) {
      const img = document.createElement('img');
      img.src = clip.thumbnailUrl;
      img.alt = '';
      img.loading = 'lazy';
      thumb.append(img);
    } else {
      thumb.classList.add('noimg');
      thumb.textContent = clip.playable ? 'No preview' : 'No video';
    }

    if (clip.duration) {
      const badge = document.createElement('span');
      badge.className = 'badge';
      badge.textContent = fmtDuration(clip.duration);
      thumb.append(badge);
    }
    if (clip.sessionCount > 1) {
      const badge = document.createElement('span');
      badge.className = 'badge left';
      badge.textContent = `${clip.sessionCount} parts`;
      thumb.append(badge);
    }
    if (multiDrive() && clip.drive) {
      const badge = document.createElement('span');
      badge.className = 'badge drive';
      badge.textContent = clip.drive;
      badge.title = clip.root || '';
      thumb.append(badge);
    }
    if (clip.playable) {
      const play = document.createElement('span');
      play.className = 'play';
      play.innerHTML = '<span><svg viewBox="0 0 24 24"><path d="M8 5v14l11-7z"/></svg></span>';
      thumb.append(play);
    }

    const body = document.createElement('div');
    body.className = 'rec-body';
    const when = document.createElement('div');
    when.className = 'rec-when';
    when.textContent = fmtWhen(clip.recordedAt);
    const detail = document.createElement('div');
    detail.className = 'rec-detail';
    if (clip.playable) {
      const bits = [fmtRelative(clip.recordedAt)];
      if (clip.width && clip.height) bits.push(`${clip.width}×${clip.height}`);
      if (!clip.hasAudio) bits.push('no audio');
      detail.textContent = bits.filter(Boolean).join(' · ');
    } else {
      detail.textContent = clip.unplayableReason || 'Unplayable';
    }
    body.append(when, detail);

    // Game label sits above the thumbnail so a mixed list reads top-down.
    const strip = gameStrip(clip);
    if (strip) card.append(strip);
    card.append(thumb, body);
    if (clip.playable) card.addEventListener('click', () => openPlayer(index));
    frag.append(card);
  });
  wrap.append(frag);
}

// Thumbnails for flat screenshot folders are generated on demand; only ask for
// the ones that actually scroll into view.
const thumbObserver = new IntersectionObserver(
  (entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      const el = entry.target;
      thumbObserver.unobserve(el);
      loadShotThumb(el);
    }
  },
  { rootMargin: '300px' },
);

async function loadShotThumb(card) {
  // Must be the frame's image: in the All media view the card also contains the
  // game capsule, which querySelector('img') would find first.
  const img = card.querySelector('.shot-frame img');
  if (!img) return;
  const file = card.dataset.file;
  const fullUrl = card.dataset.fullUrl;
  const shipped = card.dataset.thumbUrl || null;

  const show = (url) => {
    if (!url || img.dataset.shownUrl === url) return;
    img.dataset.shownUrl = url;
    img.src = url;
    img.addEventListener('load', () => img.classList.add('loaded'), { once: true });
  };

  // Steam ships 200px thumbnails, which are far too small for the larger
  // preview sizes. Show one immediately if it exists, then replace it with a
  // sharper generated one once it is ready.
  if (shipped) show(shipped);

  try {
    const better = await window.api.screenshotThumb(file);
    show(better || (shipped ? null : fullUrl));
  } catch {
    if (!shipped) show(fullUrl);
  }
}

function renderScreenshots() {
  const grid = $('shot-grid');
  grid.textContent = '';
  const items = sorted(state.media.screenshots);
  $('shot-empty').textContent = emptyMessage('screenshots', state.media.screenshots.length);
  $('shot-empty').classList.toggle('hidden', items.length > 0);

  const frag = document.createDocumentFragment();
  items.forEach((shot, index) => {
    const card = document.createElement('button');
    card.className = 'shot-card';
    card.dataset.file = shot.file;
    card.dataset.fullUrl = shot.fullUrl;
    card.dataset.needsThumb = shot.needsThumb ? '1' : '0';
    if (shot.thumbnailUrl) card.dataset.thumbUrl = shot.thumbnailUrl;

    // Game label above the image, matching the recording cards.
    const strip = gameStrip(shot);
    if (strip) card.append(strip);

    const frame = document.createElement('span');
    frame.className = 'shot-frame';

    const img = document.createElement('img');
    img.alt = shot.name;
    const cap = document.createElement('span');
    cap.className = 'cap';
    cap.textContent = fmtWhen(shot.recordedAt);
    cap.title = shot.file;

    frame.append(img, cap);
    if (multiDrive() && shot.drive) {
      const badge = document.createElement('span');
      badge.className = 'badge drive';
      badge.textContent = shot.drive;
      badge.title = shot.root || '';
      frame.append(badge);
    }
    card.append(frame);
    card.addEventListener('click', () => openShot(index));
    frag.append(card);
    thumbObserver.observe(card);
  });
  grid.append(frag);
}

/* ---------------- player ---------------- */

function currentClips() {
  return sorted(state.media.recordings).filter((c) => c.playable);
}

async function openPlayer(indexInSortedAll) {
  const all = sorted(state.media.recordings);
  const clip = all[indexInSortedAll];
  if (!clip || !clip.playable) return;
  const playable = currentClips();
  state.playingIndex = playable.findIndex((c) => c.id === clip.id);
  await showClip();
}

async function showClip() {
  const playable = currentClips();
  const clip = playable[state.playingIndex];
  if (!clip) return;

  const overlay = $('player-overlay');
  const video = $('player');
  overlay.classList.remove('hidden');

  $('pl-title').textContent = fmtWhenPrecise(clip.recordedAt);
  const bits = [`${state.playingIndex + 1} of ${playable.length}`, fmtDuration(clip.duration)];
  if (clip.width && clip.height) bits.push(`${clip.width}×${clip.height}`);
  if (clip.sessionCount > 1) bits.push(`${clip.sessionCount} parts`);
  if (!clip.hasAudio) bits.push('no audio');
  $('pl-sub').textContent = bits.join(' · ');
  $('pl-prev').disabled = state.playingIndex <= 0;
  $('pl-next').disabled = state.playingIndex >= playable.length - 1;

  $('pl-error').classList.add('hidden');
  video.removeAttribute('src');
  video.load();

  const prep = $('pl-prep');
  const bar = $('prep-bar');
  bar.style.width = '0%';
  $('prep-label').textContent = 'Preparing clip…';
  prep.classList.remove('hidden');

  state.preparing = clip.id;
  try {
    const res = await window.api.prepareClip(clip.id);
    if (state.preparing !== clip.id) return; // user moved on while we worked
    prep.classList.add('hidden');
    video.src = res.url;
    video.currentTime = 0;
    await video.play().catch(() => {}); // autoplay can be refused; controls still work
  } catch (err) {
    if (state.preparing !== clip.id) return;
    prep.classList.add('hidden');
    $('pl-error-msg').textContent = String((err && err.message) || err).replace(/^Error: /, '');
    $('pl-error').classList.remove('hidden');
  }
}

function closePlayer() {
  const video = $('player');
  video.pause();
  video.removeAttribute('src');
  video.load();
  state.preparing = null;
  state.playingIndex = -1;
  $('player-overlay').classList.add('hidden');
  $('pl-prep').classList.add('hidden');
  $('pl-error').classList.add('hidden');
}

function stepClip(delta) {
  const playable = currentClips();
  const next = state.playingIndex + delta;
  if (next < 0 || next >= playable.length) return;
  state.playingIndex = next;
  showClip();
}

/* ---------------- screenshot viewer ---------------- */

function openShot(index) {
  state.shotIndex = index;
  showShot();
}

function showShot() {
  const items = sorted(state.media.screenshots);
  const shot = items[state.shotIndex];
  if (!shot) return;

  $('shot-overlay').classList.remove('hidden');
  $('sh-img').src = shot.fullUrl;
  $('sh-title').textContent = fmtWhenPrecise(shot.recordedAt);
  $('sh-sub').textContent = `${state.shotIndex + 1} of ${items.length} · ${shot.name} · ${fmtBytes(shot.size)}`;
  $('sh-prev').disabled = state.shotIndex <= 0;
  $('sh-next').disabled = state.shotIndex >= items.length - 1;
}

function closeShot() {
  $('shot-overlay').classList.add('hidden');
  $('sh-img').removeAttribute('src');
  state.shotIndex = -1;
}

function stepShot(delta) {
  const items = sorted(state.media.screenshots);
  const next = state.shotIndex + delta;
  if (next < 0 || next >= items.length) return;
  state.shotIndex = next;
  showShot();
}

/* ---------------- settings ---------------- */

// The custom folders the user last chose, kept while they toggle back to Steam
// default so switching does not throw them away.
const pendingCustom = { recordings: [], screenshots: [] };

const PATH_FIELDS = {
  recordings: {
    listId: 'rec-paths',
    radio: 'rec-mode',
    hintId: 'rec-detected',
    title: 'Choose a recordings folder',
    customHint: 'A folder holding Steam clips.',
  },
  screenshots: {
    listId: 'shot-paths',
    radio: 'shot-mode',
    hintId: 'shot-detected',
    title: 'Choose a screenshots folder',
    customHint: 'A folder holding Steam screenshots.',
  },
};

/**
 * Renders the folder list for one media kind. Under "Steam default" it shows
 * the detected folders read-only; under "Custom folder" it's an editable list
 * so clips spread across drives can all be scanned.
 */
function renderPathList(kind) {
  const cfg = PATH_FIELDS[kind];
  const container = $(cfg.listId);
  const det = (state.library && state.library.detected) || {};
  const isCustom = document.querySelector(`input[name="${cfg.radio}"]:checked`).value === 'custom';

  const detectedPaths =
    kind === 'recordings'
      ? det.recordingsRoot
        ? [det.recordingsRoot]
        : []
      : det.screenshotRoots || [];

  container.textContent = '';
  const rows = isCustom ? pendingCustom[kind] : detectedPaths;

  if (!rows.length) {
    const empty = document.createElement('p');
    empty.className = 'hint';
    empty.textContent = isCustom
      ? 'No folders added yet.'
      : 'Nothing detected from Steam. Switch to Custom folder.';
    container.append(empty);
  }

  rows.forEach((value, index) => {
    const row = document.createElement('div');
    row.className = 'path-row';

    const input = document.createElement('input');
    input.type = 'text';
    input.spellcheck = false;
    input.value = value;
    input.disabled = !isCustom;
    input.classList.toggle('showing-default', !isCustom);
    input.addEventListener('input', () => {
      pendingCustom[kind][index] = input.value;
    });
    row.append(input);

    if (isCustom) {
      const browse = document.createElement('button');
      browse.className = 'ghost-btn small';
      browse.textContent = 'Browse…';
      browse.addEventListener('click', async () => {
        const picked = await window.api.pickFolder({ current: input.value, title: cfg.title });
        if (picked) {
          pendingCustom[kind][index] = picked;
          renderPathList(kind);
        }
      });

      const remove = document.createElement('button');
      remove.className = 'ghost-btn small';
      remove.textContent = 'Remove';
      remove.title = 'Stop scanning this folder';
      remove.addEventListener('click', () => {
        pendingCustom[kind].splice(index, 1);
        renderPathList(kind);
      });

      row.append(browse, remove);
    }
    container.append(row);
  });

  if (isCustom) {
    const add = document.createElement('button');
    add.className = 'ghost-btn small add-folder';
    add.textContent = 'Add folder…';
    add.addEventListener('click', async () => {
      const picked = await window.api.pickFolder({ title: cfg.title });
      if (picked) {
        pendingCustom[kind].push(picked);
        renderPathList(kind);
      }
    });
    container.append(add);
  }

  // Both kinds take a list, so both say so the same way.
  $(cfg.hintId).textContent = isCustom
    ? `${cfg.customHint} Add more than one to scan several folders or drives.`
    : 'Read from your Steam settings. Use Refresh after changing it in Steam.';
}

/** Re-renders both folder lists after a mode change. */
function syncModeInputs() {
  renderPathList('recordings');
  renderPathList('screenshots');
}

async function openSettings() {
  // Read the live values rather than the cached copy, so the sheet
  // always reflects what is actually saved.
  try {
    state.settings = await window.api.getSettings();
  } catch {
    /* fall back to what we have */
  }
  const s = state.settings;
  const lib = state.library;

  document.querySelector(`input[name="rec-mode"][value="${s.recordings.mode}"]`).checked = true;
  document.querySelector(`input[name="shot-mode"][value="${s.screenshots.mode}"]`).checked = true;
  pendingCustom.recordings = (s.recordings.customPaths || []).slice();
  pendingCustom.screenshots = (s.screenshots.customPaths || []).slice();
  $('allow-network').checked = s.allowNetwork;
  $('ffmpeg-path').value = s.ffmpegPath || '';
  $('cache-limit').value = s.maxCacheGB;

  const det = lib.detected || {};

  // Steam's "save an uncompressed copy" folder isn't the Steam default, but it
  // is almost certainly what the user wants, so offer it explicitly.
  const suggestion = det.uncompressedRoot;
  const alreadyUsing =
    suggestion &&
    s.screenshots.mode === 'custom' &&
    (s.screenshots.customPaths || []).some((p) => samePath(p, suggestion));
  if (suggestion && !alreadyUsing) {
    $('shot-suggestion-text').textContent = `Your Steam settings also list an uncompressed screenshots folder: ${suggestion}`;
    $('shot-suggestion').classList.remove('hidden');
  } else {
    $('shot-suggestion').classList.add('hidden');
  }

  // The path itself is only useful when troubleshooting, so it lives in the
  // field rather than as another line of text.
  $('ffmpeg-status').textContent = lib.hasFfmpeg
    ? 'Found automatically.'
    : 'Not found. Clips cannot be prepared for playback until ffmpeg is available.';
  $('ffmpeg-path').title = lib.ffmpeg || '';
  $('ffmpeg-path').placeholder = lib.hasFfmpeg ? lib.ffmpeg : 'Locate ffmpeg.exe';

  $('set-status').textContent = '';

  // Show whatever the last check found rather than re-querying on every open.
  if (state.update) {
    $('update-status').textContent = describeRelease(state.update);
    $('open-release').classList.toggle('hidden', state.update.status !== 'available');
  } else {
    $('update-status').textContent = '';
    $('open-release').classList.add('hidden');
  }

  syncModeInputs();
  refreshCacheStats();
  $('settings-overlay').classList.remove('hidden');
}

/* ---------------- updates ---------------- */

function describeRelease(result) {
  switch (result.status) {
    case 'available': {
      const when = result.publishedAt
        ? ` released ${fmtWhen(new Date(result.publishedAt).getTime())}`
        : '';
      return `Version ${result.latest} is available${when}.`;
    }
    case 'current':
      return 'You are on the latest version.';
    case 'none':
      return 'No releases have been published yet.';
    case 'disabled':
      return result.message;
    default:
      return `Could not check: ${result.message}`;
  }
}

async function checkUpdates({ quiet = false } = {}) {
  const status = $('update-status');
  const getBtn = $('open-release');
  if (!quiet) status.textContent = 'Checking…';

  let result;
  try {
    result = await window.api.checkForUpdates();
  } catch (err) {
    if (!quiet) status.textContent = `Could not check: ${(err && err.message) || err}`;
    return null;
  }

  state.update = result;
  if (result.status === 'available') {
    getBtn.textContent = result.assetName ? 'Download installer' : 'Open release page';
    getBtn.classList.remove('hidden');
  } else {
    getBtn.classList.add('hidden');
  }
  if (!quiet || result.status === 'available') status.textContent = describeRelease(result);
  return result;
}

async function refreshCacheStats() {
  try {
    const st = await window.api.cacheStats();
    $('cache-stats').textContent =
      `${fmtBytes(st.totalBytes)} used. ${st.clips.count} prepared clip${st.clips.count === 1 ? '' : 's'} ` +
      `(${fmtBytes(st.clips.bytes)}), ${st.thumbs.count} thumbnail${st.thumbs.count === 1 ? '' : 's'} (${fmtBytes(st.thumbs.bytes)})`;
  } catch {
    $('cache-stats').textContent = 'Unavailable';
  }
}

async function saveSettings() {
  $('set-status').textContent = 'Saving…';
  // Under "Steam default" the rows show detected folders, not the user's own,
  // so the custom list always comes from what they last chose.
  const patch = {
    recordings: {
      mode: document.querySelector('input[name="rec-mode"]:checked').value,
      customPaths: pendingCustom.recordings.map((p) => p.trim()).filter(Boolean),
    },
    screenshots: {
      mode: document.querySelector('input[name="shot-mode"]:checked').value,
      customPaths: pendingCustom.screenshots.map((p) => p.trim()).filter(Boolean),
    },
    allowNetwork: $('allow-network').checked,
    ffmpegPath: $('ffmpeg-path').value.trim(),
    maxCacheGB: Number($('cache-limit').value) || 12,
  };

  try {
    const res = await window.api.setSettings(patch);
    state.settings = res.settings;
    applyLibrary(res.library);
    $('set-status').textContent = 'Saved';
    $('settings-overlay').classList.add('hidden');
  } catch (err) {
    $('set-status').textContent = `Could not save: ${(err && err.message) || err}`;
  }
}

/* ---------------- library plumbing ---------------- */

/** Sidebar header: overall totals, plus a per-drive line when folders span drives. */
function renderLibraryOverview(lib) {
  const drives = lib.drives || [];

  $('all-sub').textContent =
    `${lib.counts.recordings.toLocaleString()} clips · ${lib.counts.screenshots.toLocaleString()} screenshots`;

  const summary = $('drive-summary');
  if (drives.length > 1) {
    summary.textContent = '';

    const label = document.createElement('div');
    label.className = 'ds-label';
    label.textContent = `Your media is spread across ${drives.length} drives`;
    summary.append(label);

    for (const d of drives) {
      const row = document.createElement('div');
      row.className = 'ds-row';
      row.title = `Scanned from:\n${d.roots.join('\n')}`;

      const letter = document.createElement('span');
      letter.className = 'ds-drive';
      letter.textContent = d.drive;

      const counts = document.createElement('span');
      counts.className = 'ds-counts';
      const parts = [];
      if (d.recordings) parts.push(`${d.recordings.toLocaleString()} clip${d.recordings === 1 ? '' : 's'}`);
      if (d.screenshots) parts.push(`${d.screenshots.toLocaleString()} screenshot${d.screenshots === 1 ? '' : 's'}`);
      counts.textContent = parts.join(' · ') || 'nothing found';

      row.append(letter, counts);
      summary.append(row);
    }
    summary.classList.remove('hidden');
  } else {
    summary.classList.add('hidden');
  }

  // Drive filter is pointless with a single drive, so it only appears when useful.
  const wrap = $('drive-wrap');
  const select = $('drive-filter');
  if (drives.length > 1) {
    const previous = state.driveFilter;
    select.textContent = '';
    const any = document.createElement('option');
    any.value = '';
    select.append(any);
    any.textContent = 'All drives';
    for (const d of drives) {
      const opt = document.createElement('option');
      opt.value = d.drive;
      opt.textContent = `${d.drive} only (${(d.recordings + d.screenshots).toLocaleString()} items)`;
      select.append(opt);
    }
    // Keep the choice if that drive is still present.
    state.driveFilter = drives.some((d) => d.drive === previous) ? previous : '';
    select.value = state.driveFilter;
    wrap.classList.remove('hidden');
  } else {
    state.driveFilter = '';
    wrap.classList.add('hidden');
  }
}

function applyLibrary(lib) {
  state.library = lib;
  state.games = lib.games || [];

  renderLibraryOverview(lib);

  const warn = $('warn-banner');
  if (lib.errors && lib.errors.length) {
    warn.textContent = lib.errors.join('  ·  ');
    warn.classList.remove('hidden');
  } else if (!lib.hasFfmpeg) {
    warn.textContent = 'ffmpeg was not found, so clips cannot be prepared for playback. Set its location in Settings.';
    warn.classList.remove('hidden');
  } else {
    warn.classList.add('hidden');
  }

  renderGameList();

  const stillThere =
    state.selectedAppId === ALL_GAMES || state.games.some((g) => g.appId === state.selectedAppId);
  if (state.games.length === 0) {
    state.selectedAppId = null;
    $('game-view').classList.add('hidden');
    $('empty-state').classList.remove('hidden');
    $('empty-detail').textContent =
      lib.errors && lib.errors.length
        ? lib.errors.join(' ')
        : 'No clips or screenshots were found in the configured folders.';
  } else if (!stillThere) {
    // Launching straight into the combined view shows everything that was
    // found, which is the most useful starting point.
    selectGame(ALL_GAMES);
  } else {
    selectGame(state.selectedAppId);
  }
}

function wireEvents() {
  $('game-filter').addEventListener('input', (e) => {
    state.filter = e.target.value;
    renderGameList();
  });

  $('btn-refresh').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      // Shift-click forces game names and art to be looked up again.
      applyLibrary(await window.api.rescan({ full: e.shiftKey }));
    } finally {
      btn.disabled = false;
    }
  });

  for (const btn of document.querySelectorAll('.tab')) {
    btn.addEventListener('click', () => setTab(btn.dataset.tab));
  }

  $('sort-order').addEventListener('change', async (e) => {
    state.settings.sortOrder = e.target.value;
    renderCurrentTab();
    window.api.setSettings({ sortOrder: e.target.value }).catch(() => {});
  });

  $('all-media').addEventListener('click', () => selectGame(ALL_GAMES));

  // Resizing is pure CSS, so update live while dragging and only save on release.
  $('size-slider').addEventListener('input', (e) => applyCardScale(e.target.value));
  $('size-slider').addEventListener('change', (e) => {
    const i = applyCardScale(e.target.value);
    state.settings.cardScale = i;
    window.api.setSettings({ cardScale: i }).catch(() => {});
  });

  // Drive is library-wide: it narrows the game list as well as the media lists.
  $('drive-filter').addEventListener('change', (e) => {
    state.driveFilter = e.target.value;
    renderGameList();

    // If the selected game has nothing on this drive, move to one that does.
    const stillListed =
      state.selectedAppId === ALL_GAMES || visibleGames().some((g) => g.appId === state.selectedAppId);
    if (stillListed) renderCurrentTab();
    else {
      const next = visibleGames()[0];
      if (next) selectGame(next.appId);
      else renderCurrentTab();
    }
  });

  $('date-filter').addEventListener('change', (e) => {
    state.dateFilter = e.target.value;
    renderCurrentTab();
  });

  $('btn-store').addEventListener('click', () => {
    if (state.selectedAppId) window.api.openStorePage(state.selectedAppId);
  });

  // Player
  $('pl-close').addEventListener('click', closePlayer);
  $('pl-prev').addEventListener('click', () => stepClip(-1));
  $('pl-next').addEventListener('click', () => stepClip(1));
  $('pl-reveal').addEventListener('click', () => {
    const clip = currentClips()[state.playingIndex];
    if (clip) window.api.reveal(clip.dir);
  });
  $('pl-export').addEventListener('click', async (e) => {
    const clip = currentClips()[state.playingIndex];
    if (!clip) return;
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await window.api.exportClip(clip.id);
    } catch (err) {
      $('pl-error-msg').textContent = String((err && err.message) || err);
      $('pl-error').classList.remove('hidden');
    } finally {
      btn.disabled = false;
    }
  });

  // Screenshot viewer
  $('sh-close').addEventListener('click', closeShot);
  $('sh-prev').addEventListener('click', () => stepShot(-1));
  $('sh-next').addEventListener('click', () => stepShot(1));
  $('sh-reveal').addEventListener('click', () => {
    const shot = sorted(state.media.screenshots)[state.shotIndex];
    if (shot) window.api.reveal(shot.file);
  });
  $('sh-export').addEventListener('click', async () => {
    const shot = sorted(state.media.screenshots)[state.shotIndex];
    if (shot) await window.api.exportScreenshot(shot.file).catch(() => {});
  });

  // Settings
  $('btn-settings').addEventListener('click', openSettings);
  $('btn-empty-settings').addEventListener('click', openSettings);
  $('set-close').addEventListener('click', () => $('settings-overlay').classList.add('hidden'));
  $('set-save').addEventListener('click', saveSettings);

  for (const input of document.querySelectorAll('input[name="rec-mode"], input[name="shot-mode"]')) {
    input.addEventListener('change', syncModeInputs);
  }

  // Adds Steam's uncompressed-originals folder alongside whatever is already there.
  $('shot-use-suggestion').addEventListener('click', () => {
    const suggestion = state.library.detected && state.library.detected.uncompressedRoot;
    if (!suggestion) return;
    document.querySelector('input[name="shot-mode"][value="custom"]').checked = true;
    if (!pendingCustom.screenshots.some((p) => samePath(p, suggestion))) {
      pendingCustom.screenshots.push(suggestion);
    }
    syncModeInputs();
    $('shot-suggestion').classList.add('hidden');
  });
  $('ffmpeg-browse').addEventListener('click', async () => {
    const picked = await window.api.pickFfmpeg();
    if (picked) $('ffmpeg-path').value = picked;
  });
  $('check-updates').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await checkUpdates();
    } finally {
      btn.disabled = false;
    }
  });

  $('open-release').addEventListener('click', () => {
    const url = state.update && (state.update.url || state.update.releasesUrl);
    if (url) window.api.openRepo(url);
  });

  $('cache-clear').addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    btn.disabled = true;
    try {
      await window.api.clearCache({ clips: true, thumbs: true });
      await refreshCacheStats();
    } finally {
      btn.disabled = false;
    }
  });

  // Keyboard: overlays first, then the list.
  document.addEventListener('keydown', (e) => {
    const playerOpen = !$('player-overlay').classList.contains('hidden');
    const shotOpen = !$('shot-overlay').classList.contains('hidden');
    const settingsOpen = !$('settings-overlay').classList.contains('hidden');

    if (e.key === 'Escape') {
      if (settingsOpen) $('settings-overlay').classList.add('hidden');
      else if (playerOpen) closePlayer();
      else if (shotOpen) closeShot();
      return;
    }
    if (settingsOpen) return;

    if (playerOpen) {
      const video = $('player');
      if (e.key === 'ArrowLeft') { stepClip(-1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { stepClip(1); e.preventDefault(); }
      else if (e.key === ' ') { video.paused ? video.play().catch(() => {}) : video.pause(); e.preventDefault(); }
      else if (e.key === 'j') video.currentTime = Math.max(0, video.currentTime - 5);
      else if (e.key === 'l') video.currentTime = Math.min(video.duration || 0, video.currentTime + 5);
      else if (e.key === 'f') {
        if (document.fullscreenElement) document.exitFullscreen();
        else video.requestFullscreen().catch(() => {});
      }
      return;
    }
    if (shotOpen) {
      if (e.key === 'ArrowLeft') { stepShot(-1); e.preventDefault(); }
      else if (e.key === 'ArrowRight') { stepShot(1); e.preventDefault(); }
      return;
    }

    if (e.key === '/' && document.activeElement !== $('game-filter')) {
      $('game-filter').focus();
      e.preventDefault();
    }
  });

  // Clicking the dim area outside the media closes the overlays.
  $('player-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget || e.target.classList.contains('overlay-body')) closePlayer();
  });
  $('shot-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget || e.target.classList.contains('overlay-body')) closeShot();
  });
  $('settings-overlay').addEventListener('click', (e) => {
    if (e.target === e.currentTarget) $('settings-overlay').classList.add('hidden');
  });

  window.api.onScanStatus((s) => {
    const banner = $('scan-banner');
    if (!s || s.phase === 'done') {
      banner.classList.add('hidden');
      return;
    }
    let text = s.message || '';
    if (s.phase === 'metadata' && s.total) text += ` ${s.done}/${s.total}`;
    if (s.phase === 'error') text = `Scan failed: ${s.message}`;
    banner.textContent = text;
    banner.classList.remove('hidden');
  });

  window.api.onLibraryUpdated((lib) => applyLibrary(lib));

  window.api.onClipProgress(({ clipId, fraction, stage }) => {
    if (state.preparing !== clipId) return;
    $('prep-bar').style.width = `${Math.round(fraction * 100)}%`;
    $('prep-label').textContent = stage === 'join' ? 'Joining clip parts…' : 'Preparing clip…';
  });
}

async function boot() {
  const { settings, library } = await window.api.bootstrap();
  state.settings = settings;
  $('sort-order').value = settings.sortOrder;
  $('size-slider').value = String(applyCardScale(settings.cardScale));

  const build = await window.api.appVersion().catch(() => null);
  if (build) $('app-version').textContent = `Version ${build.version}`;
  wireEvents();
  applyLibrary(library);

  // Quiet check on launch: only says anything if there is something to install.
  checkUpdates({ quiet: true }).catch(() => {});
}

boot().catch((err) => {
  document.body.textContent = `Failed to start: ${(err && err.message) || err}`;
});
