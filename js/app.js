import { buildCatalog, filterCatalog, formatTime, normalize } from './catalog.js';
import { ChiptuneEngine } from './player.js';
import { Visualizer } from './visualizer.js';
import { setWakeActive, getWakeState } from './wake-lock.js';
import { readStore, writeStore } from './storage.js';

const $ = (id) => document.getElementById(id);
const el = {
  boot: $('boot'), bootStatus: $('bootStatus'), bootBar: $('bootBar'), toasts: $('toasts'),
  favoritesOnlyBtn: $('favoritesOnlyBtn'), libraryStat: $('libraryStat'), statusPill: $('statusPill'),
  canvas: $('visualizer'), trackNumber: $('trackNumber'), trackTitle: $('trackTitle'),
  trackArtist: $('trackArtist'), trackGame: $('trackGame'), formatChip: $('formatChip'),
  seek: $('seek'), seekFill: $('seekFill'), seekThumb: $('seekThumb'),
  currentTime: $('currentTime'), totalTime: $('totalTime'),
  shuffleBtn: $('shuffleBtn'), prevBtn: $('prevBtn'), playBtn: $('playBtn'),
  playIcon: $('playIcon'), pauseIcon: $('pauseIcon'), nextBtn: $('nextBtn'),
  repeatBtn: $('repeatBtn'), repeatDot: $('repeatDot'), favoriteBtn: $('favoriteBtn'),
  muteBtn: $('muteBtn'), volume: $('volume'), volumeValue: $('volumeValue'),
  statPattern: $('statPattern'), statRow: $('statRow'), statOrder: $('statOrder'),
  libraryCount: $('libraryCount'), search: $('search'), formatFilter: $('formatFilter'),
  sortBy: $('sortBy'), trackList: $('trackList'), listSpacer: $('listSpacer'),
  listWindow: $('listWindow'), resultInfo: $('resultInfo'), selectionInfo: $('selectionInfo'),
  shuffleAllBtn: $('shuffleAllBtn'),
};

const ROW_HEIGHT = 54;
const REPEAT_MODES = ['off', 'all', 'one'];
const favoritesOnly = readStore('favoritesOnly', false);

const state = {
  tracks: [], filtered: [], queue: [], queueIndex: -1, current: null,
  position: 0, duration: 0, isPlaying: false, buffering: false,
  volume: clamp(readStore('volume', 0.8), 0, 1),
  muted: readStore('muted', false),
  repeat: REPEAT_MODES.includes(readStore('repeat', 'all')) ? readStore('repeat', 'all') : 'all',
  shuffle: readStore('shuffle', false),
  filter: favoritesOnly ? 'favorites' : 'all', format: 'all', sort: 'default', query: '',
  favoritesOnly,
  selected: -1,
  favorites: new Set(readStore('favorites', [])),
  recent: readStore('recent', []),
};

let shuffleBag = [];
let catalogLoaded = false;
const failed = new Set();
let filterTimer = 0;
let renderQueued = false;
let seeking = false;

const visualizer = new Visualizer(el.canvas);

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, Number(value) || 0));
}

function toast(message, isError = false) {
  const node = document.createElement('div');
  node.className = `toast${isError ? ' error' : ''}`;
  node.textContent = message;
  el.toasts.appendChild(node);
  setTimeout(() => {
    node.classList.add('out');
    setTimeout(() => node.remove(), 300);
  }, 4000);
}

function setBoot(message, progress) {
  if (message) el.bootStatus.textContent = message;
  if (progress) el.bootBar.style.width = `${progress}%`;
}

function setStatus(status, label) {
  el.statusPill.dataset.state = status;
  el.statusPill.textContent = label || status;
  const playing = status === 'playing' || status === 'buffering';
  setPlayIcon(playing);
  setWakeActive(playing);
  if ('mediaSession' in navigator) {
    try {
      navigator.mediaSession.playbackState = playing ? 'playing' : status === 'paused' ? 'paused' : 'none';
    } catch { /* playbackState is best-effort */ }
  }
}

const engine = new ChiptuneEngine({
  ready: () => { if (!catalogLoaded) setBoot('Decoder ready · loading catalog', 55); },
  loaded: onLoaded,
  position: onPosition,
  ended: onEnded,
  error: onEngineError,
});

/* ---------------- Playback ---------------- */

async function playTrack(track, startAt = 0) {
  if (!track) return;
  if (!engine.ready) {
    const deadline = performance.now() + 4000;
    while (!engine.ready && performance.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  if (!engine.ready) {
    toast('Audio engine is not ready in this browser', true);
    return;
  }
  state.current = track;
  state.position = startAt;
  state.duration = 0;
  state.isPlaying = true;
  state.buffering = true;
  failed.delete(track.id);
  updateTrackUI();
  updateSeekUI();
  setStatus('buffering', 'Buffering');
  visualizer.setIdle(true);
  pushRecent(track.id);
  setupMediaSession();
  renderList();
  try {
    await engine.resume();
    engine.load(track, startAt);
  } catch (error) {
    onEngineError(String(error.message || error));
  }
}

function onLoaded(data) {
  state.duration = Number(data.duration) || 0;
  state.buffering = false;
  state.isPlaying = true;
  setStatus('playing', 'Playing');
  visualizer.setIdle(false);
  updateSeekUI();
  setupMediaSession();
}

function onPosition(data) {
  if (!state.isPlaying || !state.current) return;
  state.position = Number(data.seconds) || 0;
  updateSeekUI();
  el.statPattern.textContent = String(data.pattern ?? 0).padStart(2, '0');
  el.statRow.textContent = String(data.row ?? 0).padStart(2, '0');
  el.statOrder.textContent = String(data.order ?? 0).padStart(2, '0');
  if ('mediaSession' in navigator && state.duration > 0 && navigator.mediaSession.setPositionState) {
    try {
      navigator.mediaSession.setPositionState({
        duration: state.duration,
        position: Math.min(state.position, state.duration),
        playbackRate: 1,
      });
    } catch { /* some browsers reject fractional positions */ }
  }
}

function onEnded() {
  if (!state.current) return;
  if (state.repeat === 'one') {
    engine.seek(0);
    state.position = 0;
    updateSeekUI();
    return;
  }
  nextTrack(true);
}

function onEngineError(message) {
  toast(`Playback error: ${message}`, true);
  setStatus('error', 'Error');
  if (!state.current || failed.has(state.current.id)) return;
  failed.add(state.current.id);
  setTimeout(() => {
    if (state.current && failed.has(state.current.id)) nextTrack(true);
  }, 1200);
}

function playFromFiltered(index) {
  const track = state.filtered[index];
  if (!track) return;
  state.queue = state.filtered.slice();
  state.queueIndex = index;
  state.selected = index;
  playTrack(track);
}

function nextTrack(auto = false) {
  if (!state.queue.length) return;
  let index;
  if (state.shuffle) {
    if (!shuffleBag.length) {
      shuffleBag = state.queue.map((_, i) => i).filter((i) => i !== state.queueIndex);
      for (let i = shuffleBag.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffleBag[i], shuffleBag[j]] = [shuffleBag[j], shuffleBag[i]];
      }
    }
    index = shuffleBag.pop() ?? 0;
  } else {
    index = state.queueIndex + 1;
    if (index >= state.queue.length) {
      if (!auto || state.repeat !== 'off') index = 0;
      else {
        state.position = state.duration;
        state.isPlaying = false;
        setStatus('ready', 'Finished');
        visualizer.setIdle(true);
        updateSeekUI();
        return;
      }
    }
  }
  state.queueIndex = index;
  const track = state.queue[index];
  state.selected = state.filtered.findIndex((item) => item.id === track?.id);
  playTrack(track);
}

function prevTrack() {
  if (!state.queue.length) return;
  if (state.position > 4) {
    seekTo(0);
    return;
  }
  let index = state.queueIndex - 1;
  if (index < 0) index = state.repeat === 'off' ? 0 : state.queue.length - 1;
  state.queueIndex = index;
  const track = state.queue[index];
  state.selected = state.filtered.findIndex((item) => item.id === track?.id);
  playTrack(track);
}

function togglePlay() {
  if (!state.current) {
    if (state.filtered.length) playFromFiltered(0);
    return;
  }
  if (state.isPlaying) {
    engine.pause();
    state.isPlaying = false;
    setStatus('paused', 'Paused');
    visualizer.setIdle(true);
  } else {
    state.isPlaying = true;
    setStatus(state.buffering ? 'buffering' : 'playing', state.buffering ? 'Buffering' : 'Playing');
    visualizer.setIdle(false);
    engine.resume();
  }
}

function stopTrack() {
  engine.stop();
  state.isPlaying = false;
  state.buffering = false;
  state.position = 0;
  state.duration = 0;
  setStatus('ready', 'Stopped');
  visualizer.setIdle(true);
  updateSeekUI();
  renderList();
}

function seekTo(seconds) {
  if (!state.current) return;
  const target = clamp(seconds, 0, state.duration || Infinity);
  state.position = target;
  engine.seek(target);
  updateSeekUI();
}

function setPlayIcon(playing) {
  // These are SVG elements: the .hidden IDL property does not reflect to the
  // hidden attribute there, so toggle the attribute CSS actually sees.
  el.playIcon.toggleAttribute('hidden', playing);
  el.pauseIcon.toggleAttribute('hidden', !playing);
  el.playBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
}

/* ---------------- UI ---------------- */

function updateTrackUI() {
  const track = state.current;
  if (!track) return;
  el.trackNumber.textContent = `#${String(track.number).padStart(4, '0')}`;
  el.trackTitle.textContent = track.title;
  el.trackArtist.textContent = track.artist;
  el.trackGame.textContent = track.game;
  el.formatChip.textContent = track.format;
  el.selectionInfo.textContent = `${track.title} · ${track.format}`;
  const isFav = state.favorites.has(track.id);
  el.favoriteBtn.classList.toggle('active', isFav);
  el.favoriteBtn.setAttribute('aria-pressed', String(isFav));
  el.favoriteBtn.setAttribute('aria-label', isFav ? 'Remove from favorites' : 'Add to favorites');
}

function clearCurrent() {
  state.current = null;
  state.queueIndex = -1;
  el.trackNumber.textContent = '—';
  el.trackTitle.textContent = 'Nothing selected';
  el.trackArtist.textContent = state.favoritesOnly ? 'Add a favorite from the library' : 'Pick a module from the library';
  el.trackGame.textContent = '';
  el.formatChip.textContent = '—';
  el.favoriteBtn.classList.remove('active');
  el.favoriteBtn.setAttribute('aria-pressed', 'false');
  el.favoriteBtn.setAttribute('aria-label', 'Add to favorites');
}

function updateSeekUI() {
  const duration = state.duration || 0;
  const ratio = duration > 0 ? clamp(state.position / duration, 0, 1) : 0;
  const percent = `${(ratio * 100).toFixed(2)}%`;
  el.seekFill.style.width = percent;
  el.seekThumb.style.left = percent;
  el.currentTime.textContent = formatTime(state.position);
  el.totalTime.textContent = formatTime(duration);
  el.seek.setAttribute('aria-valuenow', String(Math.round(ratio * 100)));
  el.seek.setAttribute('aria-valuetext', `${formatTime(state.position)} of ${formatTime(duration)}`);
}

function escapeHtml(text) {
  return String(text).replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]));
}

function highlight(text, words) {
  let html = escapeHtml(text || '');
  for (const word of words) {
    if (!word) continue;
    const safe = word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    html = html.replace(new RegExp(safe, 'gi'), (match) => `<mark>${match}</mark>`);
  }
  return html;
}

function renderList() {
  const total = state.filtered.length;
  el.listSpacer.style.height = `${total * ROW_HEIGHT}px`;
  el.libraryCount.textContent = total.toLocaleString();
  el.resultInfo.textContent = total ? `${total.toLocaleString()} shown` : 'no results';

  const start = Math.max(0, Math.floor(el.trackList.scrollTop / ROW_HEIGHT) - 6);
  const end = Math.min(total, Math.ceil((el.trackList.scrollTop + el.trackList.clientHeight) / ROW_HEIGHT) + 6);
  const words = normalize(state.query).split(/\s+/).filter(Boolean);
  const activeId = state.current?.id;

  let html = '';
  for (let i = start; i < end; i++) {
    const track = state.filtered[i];
    const active = track.id === activeId;
    const fav = state.favorites.has(track.id);
    html += `<div class="track-row${active ? ' active' : ''}${i === state.selected ? ' selected' : ''}" role="option" aria-selected="${active}" data-index="${i}">
      <div class="row-index">${String(track.number).padStart(4, '0')}</div>
      <div class="row-main">
        <div class="row-title">${highlight(track.title, words)}</div>
        <div class="row-sub">${highlight(track.artist, words)}</div>
        <div class="row-game">${highlight(track.game, words)}</div>
      </div>
      <div class="row-end">
        <span class="row-format">${track.format}</span>
        <button type="button" class="row-fav${fav ? ' on' : ''}" data-fav="${escapeHtml(track.id)}" aria-label="${fav ? 'Remove' : 'Add'} favorite" tabindex="-1">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 20.5S4 15.5 4 10.2C4 7.3 6 5.5 8.4 5.5c1.5 0 2.8.8 3.6 1.9.8-1.1 2.1-1.9 3.6-1.9C18 5.5 20 7.3 20 10.2c0 5.3-8 10.3-8 10.3z"/></svg>
        </button>
      </div>
    </div>`;
  }

  if (!total) {
    html = state.favoritesOnly
      ? '<div class="empty-state"><b>No favorites yet</b>Tap the heart on a track to add it.</div>'
      : '<div class="empty-state"><b>Nothing found</b>Try another search or switch filters.</div>';
  }
  el.listWindow.style.transform = `translateY(${start * ROW_HEIGHT}px)`;
  el.listWindow.innerHTML = html;
}

function queueRender() {
  if (renderQueued) return;
  renderQueued = true;
  requestAnimationFrame(() => {
    renderQueued = false;
    renderList();
  });
}

function applyFilters(resetScroll = true) {
  state.filtered = filterCatalog(state.tracks, {
    query: state.query,
    filter: state.filter,
    format: state.format,
    sort: state.sort,
    favorites: state.favorites,
    recent: state.recent,
  });
  state.queue = state.filtered.slice();
  state.queueIndex = state.current ? state.queue.findIndex((track) => track.id === state.current.id) : -1;
  if (resetScroll) el.trackList.scrollTop = 0;
  renderList();
}

function toggleFavorite(id) {
  const wasFavorite = state.favorites.has(id);
  if (wasFavorite) state.favorites.delete(id);
  else state.favorites.add(id);
  writeStore('favorites', [...state.favorites]);
  if (state.current?.id === id) updateTrackUI();
  applyFilters(false);
  if (state.favoritesOnly && wasFavorite && state.current?.id === id) {
    if (state.filtered.length) playFromFiltered(0);
    else {
      stopTrack();
      clearCurrent();
    }
  }
}

function pushRecent(id) {
  state.recent = [id, ...state.recent.filter((item) => item !== id)].slice(0, 40);
  writeStore('recent', state.recent);
  if (state.filter === 'recent') applyFilters(false);
}

function applyVolume() {
  engine.setVolume(state.volume);
  engine.setMuted(state.muted);
  el.volume.value = String(Math.round(state.volume * 100));
  el.volumeValue.textContent = state.muted ? 'MUTE' : `${Math.round(state.volume * 100)}%`;
  el.muteBtn.setAttribute('aria-label', state.muted ? 'Unmute' : 'Mute');
  el.muteBtn.style.color = state.muted ? 'var(--accent-2)' : '';
  writeStore('volume', state.volume);
  writeStore('muted', state.muted);
}

function applyModeButtons() {
  el.shuffleBtn.classList.toggle('active', state.shuffle);
  el.shuffleBtn.setAttribute('aria-pressed', String(state.shuffle));
  el.repeatBtn.classList.toggle('active', state.repeat !== 'off');
  el.repeatBtn.setAttribute('aria-pressed', String(state.repeat !== 'off'));
  el.repeatBtn.setAttribute('aria-label', `Repeat: ${state.repeat}`);
  el.repeatBtn.title = `Repeat: ${state.repeat} (R)`;
  el.repeatDot.hidden = state.repeat === 'off';
  el.repeatDot.style.background = state.repeat === 'one' ? 'var(--accent-2)' : 'var(--accent-3)';
  writeStore('shuffle', state.shuffle);
  writeStore('repeat', state.repeat);
}

function applyFavoritesOnlyUI() {
  el.favoritesOnlyBtn.classList.toggle('active', state.favoritesOnly);
  el.favoritesOnlyBtn.setAttribute('aria-pressed', String(state.favoritesOnly));
  el.favoritesOnlyBtn.title = state.favoritesOnly ? 'Show all tracks' : 'Favorites only';
  el.search.placeholder = state.favoritesOnly ? 'Search favorites…' : 'Search tracks…';
  document.querySelectorAll('.chip[data-filter]').forEach((chip) => {
    const active = chip.dataset.filter === (state.favoritesOnly ? 'favorites' : 'all');
    chip.classList.toggle('active', active);
    chip.setAttribute('aria-pressed', String(active));
  });
  writeStore('favoritesOnly', state.favoritesOnly);
}

function setFavoritesOnly(enabled) {
  state.favoritesOnly = enabled;
  state.filter = enabled ? 'favorites' : 'all';
  shuffleBag = [];
  applyFavoritesOnlyUI();
  applyFilters();
  if (enabled && state.current && !state.favorites.has(state.current.id)) {
    if (state.filtered.length) playFromFiltered(0);
    else {
      stopTrack();
      clearCurrent();
    }
  }
  toast(enabled ? `Favorites only · ${state.filtered.length}` : 'Showing all tracks');
}

function setupMediaSession() {
  if (!('mediaSession' in navigator) || !state.current || typeof MediaMetadata === 'undefined') return;
  const track = state.current;
  try {
    navigator.mediaSession.metadata = new MediaMetadata({
      title: track.title,
      artist: track.artist,
      album: track.game || 'Keygen Music',
      artwork: [{ src: new URL('./icon.svg', location.href).href, sizes: 'any', type: 'image/svg+xml' }],
    });
    const actions = {
      play: () => { if (!state.isPlaying) togglePlay(); },
      pause: () => { if (state.isPlaying) togglePlay(); },
      stop: stopTrack,
      previoustrack: prevTrack,
      nexttrack: () => nextTrack(),
      seekbackward: () => seekTo(state.position - 10),
      seekforward: () => seekTo(state.position + 10),
      seekto: (details) => seekTo(details.seekTime ?? 0),
    };
    for (const [action, handler] of Object.entries(actions)) {
      try { navigator.mediaSession.setActionHandler(action, handler); } catch { /* unsupported action */ }
    }
  } catch { /* MediaSession is best-effort */ }
}

/* ---------------- Events ---------------- */

el.playBtn.addEventListener('click', togglePlay);
el.nextBtn.addEventListener('click', () => nextTrack());
el.prevBtn.addEventListener('click', prevTrack);
$('stopBtn')?.addEventListener('click', stopTrack);
el.shuffleBtn.addEventListener('click', () => {
  state.shuffle = !state.shuffle;
  shuffleBag = [];
  applyModeButtons();
  toast(state.shuffle ? 'Shuffle on' : 'Shuffle off');
});
el.repeatBtn.addEventListener('click', () => {
  state.repeat = REPEAT_MODES[(REPEAT_MODES.indexOf(state.repeat) + 1) % REPEAT_MODES.length];
  applyModeButtons();
  toast(`Repeat: ${state.repeat}`);
});
el.favoriteBtn.addEventListener('click', () => state.current && toggleFavorite(state.current.id));
el.muteBtn.addEventListener('click', () => { state.muted = !state.muted; applyVolume(); });
el.volume.addEventListener('input', () => {
  state.volume = Number(el.volume.value) / 100;
  state.muted = false;
  applyVolume();
});
el.favoritesOnlyBtn.addEventListener('click', () => setFavoritesOnly(!state.favoritesOnly));

function seekFromPointer(event) {
  const rect = el.seek.getBoundingClientRect();
  seekTo(((event.clientX - rect.left) / rect.width) * state.duration);
}
el.seek.addEventListener('pointerdown', (event) => {
  if (!state.current) return;
  seeking = true;
  el.seek.classList.add('dragging');
  el.seek.setPointerCapture(event.pointerId);
  seekFromPointer(event);
});
el.seek.addEventListener('pointermove', (event) => { if (seeking) seekFromPointer(event); });
el.seek.addEventListener('pointerup', () => { seeking = false; el.seek.classList.remove('dragging'); });
el.seek.addEventListener('pointercancel', () => { seeking = false; el.seek.classList.remove('dragging'); });

el.search.addEventListener('input', () => {
  clearTimeout(filterTimer);
  filterTimer = setTimeout(() => {
    state.query = el.search.value.trim();
    applyFilters();
  }, 100);
});

document.querySelectorAll('.chip[data-filter]').forEach((chip) => {
  chip.addEventListener('click', () => {
    if (chip.dataset.filter === 'favorites' && !state.favoritesOnly) {
      setFavoritesOnly(true);
      return;
    }
    if (chip.dataset.filter === 'all' && state.favoritesOnly) {
      setFavoritesOnly(false);
      return;
    }
    document.querySelectorAll('.chip[data-filter]').forEach((other) => {
      other.classList.toggle('active', other === chip);
      other.setAttribute('aria-pressed', String(other === chip));
    });
    state.filter = chip.dataset.filter;
    applyFilters();
  });
});
el.formatFilter.addEventListener('change', () => { state.format = el.formatFilter.value; applyFilters(); });
el.sortBy.addEventListener('change', () => { state.sort = el.sortBy.value; applyFilters(false); });
el.shuffleAllBtn.addEventListener('click', () => {
  if (!state.filtered.length) return;
  const index = Math.floor(Math.random() * state.filtered.length);
  state.shuffle = true;
  shuffleBag = [];
  applyModeButtons();
  playFromFiltered(index);
  toast(`Shuffling ${state.filtered.length.toLocaleString()} modules`);
});

el.trackList.addEventListener('scroll', queueRender, { passive: true });
el.listWindow.addEventListener('click', (event) => {
  const favButton = event.target.closest('.row-fav');
  if (favButton) {
    event.stopPropagation();
    toggleFavorite(favButton.dataset.fav);
    return;
  }
  const row = event.target.closest('.track-row');
  if (row) playFromFiltered(Number(row.dataset.index));
});
el.trackList.addEventListener('keydown', (event) => {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp' && event.key !== 'Enter') return;
  event.preventDefault();
  if (!state.filtered.length) return;
  if (event.key === 'Enter') {
    playFromFiltered(Math.max(0, state.selected));
    return;
  }
  const step = event.key === 'ArrowDown' ? 1 : -1;
  state.selected = clamp(state.selected + step, 0, state.filtered.length - 1);
  const top = state.selected * ROW_HEIGHT;
  if (top < el.trackList.scrollTop) el.trackList.scrollTop = top;
  if (top + ROW_HEIGHT > el.trackList.scrollTop + el.trackList.clientHeight) {
    el.trackList.scrollTop = top + ROW_HEIGHT - el.trackList.clientHeight;
  }
  renderList();
});

document.addEventListener('keydown', (event) => {
  const tag = event.target.tagName;
  if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA' || event.target.isContentEditable) return;
  if (event.key === '/' && tag !== 'BUTTON') {
    event.preventDefault();
    el.search.focus();
    return;
  }
  if (event.code === 'Space' && tag === 'BUTTON') return;
  switch (event.code) {
    case 'Space': event.preventDefault(); togglePlay(); break;
    case 'ArrowRight': event.preventDefault(); seekTo(state.position + 5); break;
    case 'ArrowLeft': event.preventDefault(); seekTo(state.position - 5); break;
    case 'KeyN': nextTrack(); break;
    case 'KeyP': prevTrack(); break;
    case 'KeyR': el.repeatBtn.click(); break;
    case 'KeyS': el.shuffleBtn.click(); break;
    case 'KeyF': state.current && toggleFavorite(state.current.id); break;
    case 'KeyM': state.muted = !state.muted; applyVolume(); break;
    case 'Escape': if (document.activeElement === el.search) { el.search.value = ''; el.search.dispatchEvent(new Event('input')); el.search.blur(); } break;
  }
});

window.addEventListener('resize', queueRender);

/* ---------------- Boot ---------------- */

async function boot() {
  applyVolume();
  applyModeButtons();
  applyFavoritesOnlyUI();
  visualizer.start();
  setBoot('Initializing audio engine', 20);

  try {
    await engine.init();
    visualizer.setAnalyser(engine.analyser);
  } catch (error) {
    toast(`Audio unavailable: ${error.message || error}`, true);
    setStatus('error', 'No audio');
  }

  try {
    const { TRACKS } = await import('./tracks.js');
    catalogLoaded = true;
    state.tracks = buildCatalog(TRACKS);
    el.libraryStat.textContent = state.tracks.length.toLocaleString();
    applyFilters();
    setBoot('Ready', 100);
  } catch (error) {
    setBoot('Could not load the catalog', 100);
    toast(`Catalog error: ${error.message || error}`, true);
  }

  setTimeout(() => el.boot.classList.add('done'), 350);
  if ('serviceWorker' in navigator && location.protocol.startsWith('http')) {
    navigator.serviceWorker.register('./sw.js').catch(() => {});
  }
}

/* Small debug hook, useful for inspecting playback state from the console. */
window.__kgm = { engine, state, visualizer, wakeLock: getWakeState };

boot();
