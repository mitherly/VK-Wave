'use strict';

/**
 * VK Wave — preload-перехватчик состояния плеера VK Музыки.
 *
 * Работает в изолированном контексте страницы https://vk.com/music:
 *  1. Слушает события <audio>/<video> (play, pause, ended, timeupdate, seeked) —
 *     точные currentTime/duration и мгновенная реакция на паузу/воспроизведение.
 *  2. Раз в 750 мс опрашивает navigator.mediaSession (metadata, playbackState) —
 *     основной источник названия, исполнителя и обложки.
 *  3. Через DOM-разбор нижнего плеера и document.title добирает данные,
 *     если MediaSession недоступен; MutationObserver ловит смену трека.
 *  4. Регистрирует обработчики MediaSession — работают медиа-клавиши клавиатуры,
 *     наушников и нативный медиа-оверлей Windows 10/11.
 *  5. Шлёт сводку в главный процесс: ipcRenderer.send('track-update', data),
 *     принимает команды управления из трея: 'player-command'.
 */

const { ipcRenderer } = require('electron');

/* ------------------------------- Константы ------------------------------- */

const POLL_INTERVAL_MS = 750;          // период опроса MediaSession/DOM
const MUTATION_DEBOUNCE_MS = 500;      // антидребезг MutationObserver
const SEEK_THRESHOLD_SEC = 3;          // прыжок позиции больше этого — перемотка
const KEEPALIVE_INTERVAL_MS = 120000;  // периодический ре-синк присутствия
const FALLBACK_SCAN_INTERVAL_MS = 3000;// троттлинг тяжёлого поиска плеера

/* ------------------------------- Состояние ------------------------------- */

const state = {
  title: null,
  artist: null,
  coverUrl: null,
  isPlaying: false,
  currentTime: 0,
  duration: 0,
  activeMedia: null,      // текущий <audio>/<video>-элемент
  metadataPresent: false, // VK отдаёт navigator.mediaSession.metadata
  lastSent: null,         // последняя отправленная сводка
  lastSentAt: 0,
  mutationTimer: null,
  lastRootScanAt: 0,
  playerRoot: null
};

/* --------------------- Управление плеером (DOM-клики) -------------------- */

const PLAYER_ROOT_SELECTORS = [
  '.audioPlayer__wrapElement',
  '.audioPlayer',
  '.MusicPlayer',
  '.audio_page_player',
  '#audio_player',
  '[class*="audioPlayer"]'
];

const CONTROL_SELECTORS = {
  toggle: [
    '.audioPlayer__play',
    '.audioPlayer__btn--play',
    '.audioPlayer__control--play',
    '.MusicPlayer__play',
    '.MusicPlayer__control--play',
    '.audio_page_player__play',
    '.top_audio_player_play',
    '#audio_player .audio_button--play',
    '[class*="audioPlayer"] [class*="playButton"]',
    '[class*="Player"] [class*="play"]'
  ],
  next: [
    '.audioPlayer__btn--next',
    '.MusicPlayer__next',
    '.audio_page_player__next',
    '[class*="Player"] [class*="next"]'
  ],
  previous: [
    '.audioPlayer__btn--prev',
    '.MusicPlayer__prev',
    '.audio_page_player__prev',
    '[class*="Player"] [class*="prev"]'
  ]
};

const ARIA_HINTS = {
  play: ['слушать', 'воспроизвести', 'play'],
  pause: ['пауза', 'останов', 'pause'],
  next: ['следующ', 'next'],
  previous: ['предыдущ', 'previous', 'назад']
};

function isVisible(el) {
  if (!el || typeof el.getBoundingClientRect !== 'function') return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/**
 * Ищет контейнер нижнего плеера: сначала по известным классам VK,
 * затем (с троттлингом) эвристикой «фиксированный блок снизу с кнопками и временем».
 */
function findPlayerRoot() {
  if (state.playerRoot && state.playerRoot.isConnected) return state.playerRoot;
  if (state.playerRoot && !state.playerRoot.isConnected) state.playerRoot = null;

  for (const selector of PLAYER_ROOT_SELECTORS) {
    for (const el of document.querySelectorAll(selector)) {
      if (el.querySelector('button, [role="button"]')) {
        state.playerRoot = el;
        return el;
      }
    }
  }

  const now = Date.now();
  if (now - state.lastRootScanAt < FALLBACK_SCAN_INTERVAL_MS) return null;
  state.lastRootScanAt = now;

  let best = null;
  for (const el of document.querySelectorAll('div')) {
    const style = getComputedStyle(el);
    if (style.position !== 'fixed') continue;
    const bottom = parseFloat(style.bottom);
    if (Number.isNaN(bottom) || bottom > 48) continue;
    const text = el.textContent || '';
    if (text.length > 400 || !/\d{1,2}:\d{2}/.test(text)) continue;
    if (!el.querySelector('button, [role="button"]')) continue;
    if (!best || text.length < (best.textContent || '').length) best = el;
  }

  state.playerRoot = best;
  return best;
}

function findByAccessibleName(scope, hints) {
  const candidates = scope.querySelectorAll('button, [role="button"], [aria-label], [title]');
  const allowText = scope !== document;
  for (const el of candidates) {
    let name = `${el.getAttribute('aria-label') || ''} ${el.getAttribute('title') || ''}`;
    if (allowText) name += ` ${el.textContent || ''}`;
    name = name.toLowerCase();
    if (hints.some((hint) => name.includes(hint)) && isVisible(el)) return el;
  }
  return null;
}

function findControl(kind) {
  const root = findPlayerRoot();
  const scope = root || document;

  for (const selector of CONTROL_SELECTORS[kind] || []) {
    const el = scope.querySelector(selector);
    if (el && isVisible(el)) return el;
  }

  const hints =
    kind === 'toggle'
      ? state.isPlaying
        ? ARIA_HINTS.pause
        : ARIA_HINTS.play
      : ARIA_HINTS[kind];
  const named = findByAccessibleName(scope, hints);
  if (named) return named;

  if (kind === 'toggle') {
    const generic = scope.querySelector('button[class*="play"], [role="button"][class*="play"]');
    if (generic && isVisible(generic)) return generic;
  }
  return null;
}

function pressControl(kind) {
  const el = findControl(kind);
  if (!el) return false;
  el.click();
  return true;
}

/** play/pause из MediaSession и трея: нажимаем тумблер только когда нужно. */
function handleTransportAction(action) {
  if (action === 'play' && state.isPlaying) return;
  if (action === 'pause' && !state.isPlaying) return;
  pressControl('toggle');
}

function seekBy(offsetSec) {
  const el = state.activeMedia;
  if (!el || !Number.isFinite(el.duration) || el.duration <= 0) return;
  try {
    el.currentTime = Math.min(Math.max(0, el.currentTime + offsetSec), el.duration);
  } catch (_) {
    /* перемотка для этого источника недоступна */
  }
}

/* ---------------------- MediaSession (медиа-клавиши) --------------------- */

function setupMediaSessionActions() {
  if (!('mediaSession' in navigator)) return;
  const ms = navigator.mediaSession;
  const handlers = {
    play: () => handleTransportAction('play'),
    pause: () => handleTransportAction('pause'),
    previoustrack: () => pressControl('previous'),
    nexttrack: () => pressControl('next'),
    seekbackward: (details) => seekBy(details && details.seekOffset ? -details.seekOffset : -10),
    seekforward: (details) => seekBy(details && details.seekOffset ? details.seekOffset : 10),
    stop: () => handleTransportAction('pause')
  };
  for (const [action, handler] of Object.entries(handlers)) {
    try {
      ms.setActionHandler(action, handler);
    } catch (_) {
      /* действие не поддержано этой сборкой Chromium */
    }
  }
}

/* --------------------- События медиа-элементов (время) ------------------- */

function isMediaElement(el) {
  return !!el && (el.tagName === 'AUDIO' || el.tagName === 'VIDEO');
}

function onMediaPlay(event) {
  const el = event.target;
  if (!isMediaElement(el)) return;
  state.activeMedia = el;
  state.isPlaying = true;
  maybeSend();
}

function onMediaPause(event) {
  const el = event.target;
  if (!isMediaElement(el)) return;
  if (state.activeMedia && el !== state.activeMedia) return;
  state.isPlaying = false;
  maybeSend();
}

function onTimeUpdate(event) {
  const el = event.target;
  if (!isMediaElement(el)) return;

  if (!state.activeMedia || state.activeMedia === el) {
    state.activeMedia = el;
  } else if (!el.paused) {
    state.activeMedia = el; // новый элемент «перехватил» воспроизведение
  } else {
    return;
  }

  if (Number.isFinite(el.currentTime)) state.currentTime = el.currentTime;
  if (Number.isFinite(el.duration) && el.duration > 0 && el.duration !== Infinity) {
    state.duration = el.duration;
  }
  maybeSend();
}

function setupMediaElementListeners() {
  document.addEventListener('play', onMediaPlay, true);
  document.addEventListener('pause', onMediaPause, true);
  document.addEventListener('ended', onMediaPause, true);
  document.addEventListener('timeupdate', onTimeUpdate, true);
  document.addEventListener('seeked', onTimeUpdate, true);
  document.addEventListener('loadedmetadata', onTimeUpdate, true);
}

/* ----------------------- Извлечение данных о треке ----------------------- */

function readMediaSession() {
  try {
    const ms = navigator.mediaSession;
    if (!ms) {
      state.metadataPresent = false;
      return;
    }
    const md = ms.metadata;
    if (md && (md.title || md.artist)) {
      state.metadataPresent = true;
      if (md.title) state.title = md.title;
      if (md.artist) state.artist = md.artist;
      if (Array.isArray(md.artwork) && md.artwork.length > 0) {
        const art = md.artwork[md.artwork.length - 1];
        const cover = normalizeCoverUrl(art && art.src);
        if (cover) state.coverUrl = cover;
      }
    } else {
      state.metadataPresent = false;
    }
    if (ms.playbackState === 'playing' || ms.playbackState === 'paused') {
      state.isPlaying = ms.playbackState === 'playing';
    }
  } catch (_) {
    state.metadataPresent = false;
  }
}

function normalizeCoverUrl(url) {
  if (!url || typeof url !== 'string') return null;
  if (url.startsWith('//')) url = `https:${url}`;
  if (!/^https?:\/\//i.test(url)) return null;
  try {
    const parsed = new URL(url);
    // У VK размеры обложек передаются параметром size — просим достойный для Discord.
    if (parsed.searchParams.has('size')) parsed.searchParams.set('size', '320x320');
    return parsed.toString();
  } catch (_) {
    return url;
  }
}

function readCoverFromDom(root) {
  if (!root) return null;
  const img = root.querySelector('img');
  if (img) {
    const cover = normalizeCoverUrl(img.currentSrc || img.src || '');
    if (cover) return cover;
  }
  const styled = root.querySelector('[style*="background-image"]');
  if (styled) {
    const match = /url\(["']?(https?:[^"')]+|\/\/[^"')]+)["']?\)/i.exec(
      styled.getAttribute('style') || ''
    );
    if (match) return normalizeCoverUrl(match[1]);
  }
  return null;
}

/** Фолбэк: VK выносит «Исполнитель — Трек» в заголовок вкладки. */
function readTitleFromDocument() {
  const raw = (document.title || '').trim();
  if (!raw) return null;
  const base = raw.split('|')[0].trim();
  const cleaned = base
    .replace(/^[\u25B6\u25B8\u23F5\u23F8\u23F9\u25A0\u23FA\u25CF\u266A\u266B\u266C\s]+/u, '')
    .trim();

  let artist = null;
  let title = null;
  const dash = cleaned.split(/\s+[—–]\s+/);
  if (dash.length >= 2) {
    artist = dash[0].trim();
    title = dash.slice(1).join(' — ').trim();
  } else {
    const hyphen = cleaned.split(/\s+-\s+/);
    if (hyphen.length >= 2) {
      artist = hyphen[0].trim();
      title = hyphen.slice(1).join(' - ').trim();
    }
  }
  if (!artist || !title) return null;
  return { artist, title };
}

/** Фолбэк по DOM плеера: сверху название, снизу исполнитель. */
function readTitleFromDom(root) {
  if (!root) return null;
  const leaves = Array.from(root.querySelectorAll('*')).filter((el) => {
    if (el.children.length) return false;
    const text = (el.textContent || '').trim();
    if (text.length < 2 || text.length > 120) return false;
    if (/^\d{1,2}:\d{2}$/.test(text)) return false;
    return true;
  });
  if (leaves.length < 2) return null;
  return {
    title: leaves[0].textContent.trim(),
    artist: leaves[1].textContent.trim()
  };
}

function readTimesFromDom(root) {
  if (!root) return null;
  const timeNodes = Array.from(root.querySelectorAll('*')).filter((el) => {
    if (el.children.length) return false;
    return /^\d{1,2}:\d{2}$/.test((el.textContent || '').trim());
  });
  if (!timeNodes.length) return null;

  const toSeconds = (text) => {
    const parts = text.trim().split(':').map(Number);
    if (parts.some((n) => !Number.isFinite(n))) return -1;
    if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
    return parts[0] * 60 + parts[1];
  };

  const values = timeNodes.map((n) => toSeconds(n.textContent)).filter((v) => v >= 0);
  if (!values.length) return null;
  if (values.length === 1) return { currentTime: values[0], duration: 0 };

  const duration = Math.max(...values);
  const currentTime = values.find((v) => v !== duration) || 0;
  return { currentTime, duration };
}

/** Полный проход извлечения: MediaSession → DOM → отправка при изменениях. */
function runExtraction() {
  readMediaSession();

  const root = findPlayerRoot();

  if (!state.metadataPresent) {
    const docTitle = readTitleFromDocument();
    if (docTitle) {
      state.title = docTitle.title;
      state.artist = docTitle.artist;
    }
  }

  if (root) {
    if (!state.metadataPresent || !state.coverUrl) {
      const cover = readCoverFromDom(root);
      if (cover) state.coverUrl = cover;
    }

    if (!state.metadataPresent) {
      const domTitle = readTitleFromDom(root);
      if (domTitle) {
        if (!state.title) state.title = domTitle.title;
        if (!state.artist) state.artist = domTitle.artist;
      }
    }

    const times = readTimesFromDom(root);
    if (times) {
      if (times.duration > 0 && Math.abs(times.duration - state.duration) > 1) {
        state.duration = times.duration;
      }
      if (!state.activeMedia) {
        if (times.currentTime >= 0) state.currentTime = times.currentTime;
      } else if (Math.abs(times.currentTime - state.currentTime) > 4) {
        state.currentTime = times.currentTime;
      }
    }
  }

  maybeSend();
}

/* ------------------------ Отправка данных в main ------------------------- */

function buildPayload() {
  return {
    title: state.title || 'Неизвестный трек',
    artist: state.artist || 'VK Музыка',
    coverUrl: state.coverUrl || null,
    isPlaying: !!state.isPlaying,
    currentTime: Math.round((state.currentTime || 0) * 10) / 10,
    duration: Math.round((state.duration || 0) * 10) / 10
  };
}

function sendTrackUpdate(now, payload) {
  state.lastSent = payload;
  state.lastSentAt = now;
  ipcRenderer.send('track-update', payload);
}

/**
 * Шлём данные только при реальных изменениях: смена трека, пауза/воспроизведение,
 * перемотка (расхождение с ожидаемой позицией) или по keepalive-таймеру.
 * Прогресс между обновлениями Discord досчитывает сам по timestamps.
 */
function maybeSend() {
  if (!state.title && !state.artist) return;
  const payload = buildPayload();
  const now = Date.now();

  if (!state.lastSent) {
    sendTrackUpdate(now, payload);
    return;
  }

  const last = state.lastSent;
  const metaChanged =
    last.title !== payload.title ||
    last.artist !== payload.artist ||
    last.coverUrl !== payload.coverUrl;
  const stateChanged = last.isPlaying !== payload.isPlaying;

  const elapsedSec = (now - state.lastSentAt) / 1000;
  const expected = last.isPlaying ? last.currentTime + elapsedSec : last.currentTime;
  const seeked = Math.abs(payload.currentTime - expected) > SEEK_THRESHOLD_SEC;
  const keepalive = now - state.lastSentAt >= KEEPALIVE_INTERVAL_MS;

  if (metaChanged || stateChanged || seeked || keepalive) {
    sendTrackUpdate(now, payload);
  }
}

/* ----------------------- MutationObserver и команды ---------------------- */

function setupMutationObserver() {
  const observer = new MutationObserver(() => {
    if (state.mutationTimer) return;
    state.mutationTimer = setTimeout(() => {
      state.mutationTimer = null;
      runExtraction();
    }, MUTATION_DEBOUNCE_MS);
  });
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    characterData: true
  });
}

function setupIpcCommands() {
  ipcRenderer.on('player-command', (_event, command) => {
    switch (command) {
      case 'play-pause':
        handleTransportAction(state.isPlaying ? 'pause' : 'play');
        break;
      case 'next':
        pressControl('next');
        break;
      case 'previous':
        pressControl('previous');
        break;
      default:
        break;
    }
  });
}

/* --------------------------------- Запуск -------------------------------- */

function init() {
  setupMediaSessionActions();
  setupMediaElementListeners();
  setupMutationObserver();
  setupIpcCommands();
  runExtraction();
  setInterval(runExtraction, POLL_INTERVAL_MS);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
