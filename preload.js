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

const { ipcRenderer, webFrame } = require('electron');

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

let appSettings = null; // сводка настроек из главного процесса

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

/* Имена методов легаси-API плеера ВК (window.ap) в основном мире страницы. */
const AP_METHODS = {
  toggle: ['togglePause', 'togglePlay', 'toggle'],
  next: ['next', 'playNext', 'nextTrack'],
  previous: ['prev', 'previous', 'playPrev', 'prevTrack']
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

/** Клик по кнопке плеера в основном мире ВК: window.ap (если жив легаси-API). */
function pressViaPlayerApi(kind) {
  const names = AP_METHODS[kind];
  if (!names || !names.length) return Promise.resolve(false);
  const script =
    `(function(){try{var a=window.ap;` +
    `if(!a&&window.AudioPlayer&&typeof window.AudioPlayer.getInstance==="function"){try{a=window.AudioPlayer.getInstance();}catch(e){}}` +
    `if(!a)return false;var m=${JSON.stringify(names)};` +
    `for(var i=0;i<m.length;i++){if(typeof a[m[i]]==="function"){a[m[i]]();return m[i];}}}catch(e){}return false;})()`;
  try {
    return Promise.resolve(webFrame.executeJavaScript(script, true))
      .then((result) => !!result)
      .catch(() => false);
  } catch (_) {
    return Promise.resolve(false);
  }
}

/**
 * Позиционная эвристика: aria/классы не сработали — берём кнопку play
 * (находится надёжно) и ищем соседей слева/справа в том же ряду плеера.
 * У ВК порядок кнопок стабилен: [перемешать] [назад] [play] [вперёд] [повтор].
 */
function findRelativeTransportButton(kind) {
  if (kind !== 'next' && kind !== 'previous') return null;
  const toggle = findControl('toggle');
  if (!toggle) return null;
  const root = findPlayerRoot() || document;
  const tRect = toggle.getBoundingClientRect();
  if (!tRect.width && !tRect.height) return null;

  const tX = tRect.left + tRect.width / 2;
  const tY = tRect.top + tRect.height / 2;
  const rowTolerance = Math.max(tRect.height * 0.75, 24);

  const candidates = Array.from(root.querySelectorAll('button, [role="button"]'))
    .map((el) => {
      const r = el.getBoundingClientRect();
      return {
        el,
        x: r.left + r.width / 2,
        y: r.top + r.height / 2,
        hidden: !r.width && !r.height
      };
    })
    .filter((c) => !c.hidden && c.el !== toggle && Math.abs(c.y - tY) <= rowTolerance)
    .sort((a, z) => a.x - z.x);

  const side = candidates.filter((c) =>
    kind === 'previous' ? c.x < tX - 4 : c.x > tX + 4
  );
  const target = kind === 'previous' ? side[side.length - 1] : side[0];
  return target ? target.el : null;
}

async function pressControl(kind) {
  // 1) Прямой вызов API плеера ВК (основной мир) — самый надёжный путь.
  if (await pressViaPlayerApi(kind)) return true;
  // 2) Классы/aria-label, если ВК их отдаёт.
  const el = findControl(kind);
  if (el) {
    el.click();
    return true;
  }
  // 3) Позиционная эвристика вокруг кнопки play.
  const relative = findRelativeTransportButton(kind);
  if (relative) {
    relative.click();
    return true;
  }
  return false;
}

/** play/pause из MediaSession и трея: нажимаем тумблер только когда нужно. */
async function handleTransportAction(action) {
  if (action === 'play' && state.isPlaying) return;
  if (action === 'pause' && !state.isPlaying) return;
  await pressControl('toggle');
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
  } else if (el.seekable && el.seekable.length > 0) {
    // MSE-потоки ВК отдают duration = Infinity — реальная длина живёт в seekable.
    try {
      const seekableEnd = el.seekable.end(el.seekable.length - 1);
      if (Number.isFinite(seekableEnd) && seekableEnd > 0) state.duration = seekableEnd;
    } catch (_) {
      /* seekable недоступен для этого источника */
    }
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

/* ------------------- Настройки, темы и панель управления ------------------ */

const THEME_PRESETS = {
  default: { background: '#141414', cards: '#1d1d22', accent: '#0077ff', radius: 16 },
  oled: { background: '#000000', cards: '#101014', accent: '#0077ff', radius: 14 },
  midnight: { background: '#0e1322', cards: '#172033', accent: '#5b8cff', radius: 18 },
  light: { background: '#edeef0', cards: '#ffffff', accent: '#0077ff', radius: 16 }
};

/** Базовое переопределение (если скан токенов ВК ничего не нашёл). */
const VKUI_FALLBACK_CSS = `
  :root {
    --vkui--color_background: var(--vkwave-bg) !important;
    --vkui--color_background_page: var(--vkwave-bg) !important;
    --vkui--color_background_content: var(--vkwave-cards) !important;
    --vkui--color_background_secondary: var(--vkwave-cards) !important;
    --vkui--color_background_tertiary: var(--vkwave-cards) !important;
    --vkui--color_background_accent: var(--vkwave-accent) !important;
    --vkui--color_background_accent_tint: var(--vkwave-accent) !important;
    --vkui--color_stroke_accent: var(--vkwave-accent) !important;
    --vkui--color_icon_accent: var(--vkwave-accent) !important;
    --vkui--color_text_link: var(--vkwave-accent) !important;
    --vkui--size_border_radius--regular: var(--vkwave-radius) !important;
    --vkui--size_border_radius: var(--vkwave-radius) !important;
  }
  body { background: var(--vkwave-bg) !important; }
`;

let themeStyleEl = null;
let vkuiTokensScanned = false;

function isLightBackground(hexColor) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hexColor || '');
  if (!match) return false;
  const int = parseInt(match[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

/** Скан ВСЕХ цветовых дизайн-токенов VKUI из загруженных стилей ВК —
 * так тема перекрашивает весь интерфейс, как это делают темы-расширения. */
function collectVkuiColorTokens() {
  const names = new Set();
  for (const sheet of document.styleSheets) {
    let rules;
    try {
      rules = sheet.cssRules;
    } catch (_) {
      continue; // кросс-доменный лист недоступен для чтения — пропускаем
    }
    for (const rule of rules) {
      const style = rule && rule.style;
      if (!style) continue;
      for (let i = 0; i < style.length; i += 1) {
        const prop = style[i];
        if (typeof prop === 'string' && prop.startsWith('--vkui--color_')) {
          names.add(prop);
        }
      }
    }
  }
  return Array.from(names);
}

/** Категория токена → цвет палитры VK Wave. Семантические цвета
 * (ошибки/предупреждения/успех) не трогаем — они должны оставаться красными/зелёными. */
function mapVkuiToken(name) {
  const n = name.toLowerCase();
  if (/(_|)(negative|positive|warning)/.test(n)) return null;
  if (n.includes('accent') || n.includes('text_link')) return 'var(--vkwave-accent)';
  if (n.includes('background')) return 'var(--vkwave-cards)';
  if (n.includes('text') || n.includes('icon')) return 'var(--vkwave-text)';
  if (n.includes('stroke')) return 'var(--vkwave-stroke)';
  if (n.includes('overlay')) return 'rgba(0, 0, 0, 0.55)';
  return null;
}

function buildDeepThemeOverride() {
  const tokens = collectVkuiColorTokens();
  if (!tokens.length) return '';
  const lines = [
    // VK объявляет токены на классах-обёртках темы — override только на :root
    // проигрывает им. Объявляем на каждом элементе: наследование не перебьёт.
    ':root, body, body * {'
  ];
  for (const name of tokens) {
    const mapped = mapVkuiToken(name);
    if (mapped) lines.push(`  ${name}: ${mapped} !important;`);
  }
  lines.push('}');
  lines.push('body { background: var(--vkwave-bg) !important; }');
  return lines.join('\n');
}

function applyTheme(s) {
  const t = (s && s.theme) || {};
  const bg = t.background || '#141414';
  const light = isLightBackground(bg);
  const root = document.documentElement;
  root.style.setProperty('--vkwave-bg', bg);
  root.style.setProperty('--vkwave-cards', t.cards || '#1d1d22');
  root.style.setProperty('--vkwave-accent', t.accent || '#0077ff');
  root.style.setProperty('--vkwave-text', light ? '#1d1d22' : '#e8eaf0');
  root.style.setProperty('--vkwave-stroke', light ? 'rgba(0, 0, 0, 0.14)' : 'rgba(255, 255, 255, 0.14)');
  root.style.setProperty('--vkwave-radius', `${Number(t.radius) || 16}px`);

  if (!themeStyleEl || !themeStyleEl.isConnected) {
    themeStyleEl = document.createElement('style');
    themeStyleEl.id = 'vkwave-theme';
    (document.head || document.documentElement).appendChild(themeStyleEl);
  }
  // Пресет «default» = родная тема ВК, ничего не перекрашиваем.
  if (!t.preset || t.preset === 'default') {
    themeStyleEl.textContent = '';
    return;
  }
  themeStyleEl.textContent = buildDeepThemeOverride() || VKUI_FALLBACK_CSS;

  // Стили ВК могли догрузиться после первого прохода — один раз пересканируем.
  if (!vkuiTokensScanned) {
    vkuiTokensScanned = true;
    setTimeout(() => {
      if (appSettings && appSettings.theme && appSettings.theme.preset !== 'default') {
        applyTheme(appSettings);
      }
    }, 4000);
  }
}

const PANEL_CSS = `
  #vkwave-panel {
    position: fixed; top: 46px; right: 12px; width: 322px;
    background: #17171b; color: #e8eaf0;
    border: 1px solid #2a2a31; border-radius: 14px;
    box-shadow: 0 18px 48px rgba(0, 0, 0, .5);
    padding: 14px; z-index: 2147483640;
    font: 13px/1.45 -apple-system, "Segoe UI", Roboto, sans-serif;
    transition: transform .18s ease, opacity .18s ease;
  }
  #vkwave-panel.vkwave-hidden { transform: translateX(24px); opacity: 0; pointer-events: none; }
  #vkwave-panel .vkwave-panel__head { display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px; }
  #vkwave-panel .vkwave-panel__title { font-weight: 600; font-size: 14px; }
  #vkwave-panel .vkwave-panel__x { background: none; border: 0; color: #9aa0ab; font-size: 14px; cursor: pointer; padding: 4px 8px; border-radius: 8px; }
  #vkwave-panel .vkwave-panel__x:hover { background: #232329; color: #fff; }
  #vkwave-panel .vkwave-panel__section { margin: 10px 0 6px; font-size: 11px; letter-spacing: .08em; text-transform: uppercase; color: #7d8590; }
  #vkwave-panel .vkwave-panel__presets { display: flex; gap: 6px; flex-wrap: wrap; margin-bottom: 8px; }
  #vkwave-panel .vkwave-chip { background: #232329; color: #e8eaf0; border: 1px solid #2f2f37; border-radius: 999px; padding: 4px 10px; cursor: pointer; font-size: 12px; }
  #vkwave-panel .vkwave-chip.vkwave-active { background: var(--vkwave-accent, #0077ff); border-color: transparent; color: #fff; }
  #vkwave-panel .vkwave-row { display: flex; align-items: center; justify-content: space-between; gap: 10px; padding: 5px 0; }
  #vkwave-panel input[type="color"] { width: 44px; height: 26px; border: 1px solid #2f2f37; border-radius: 8px; background: #232329; padding: 2px; cursor: pointer; }
  #vkwave-panel input[type="range"] { width: 150px; accent-color: var(--vkwave-accent, #0077ff); }
  #vkwave-panel input[type="checkbox"] { width: 16px; height: 16px; accent-color: var(--vkwave-accent, #0077ff); cursor: pointer; }
  #vkwave-panel .vkwave-check { cursor: pointer; }
  #vkwave-panel .vkwave-panel__actions { display: flex; gap: 8px; margin-top: 12px; }
  #vkwave-panel .vkwave-btn { flex: 1; background: #232329; color: #e8eaf0; border: 1px solid #2f2f37; border-radius: 10px; padding: 7px 6px; cursor: pointer; font-size: 12px; }
  #vkwave-panel .vkwave-btn:hover { background: #2b2b33; }
  #vkwave-panel .vkwave-btn--ghost { background: transparent; }
  #vkwave-panel .vkwave-panel__hint { margin-top: 10px; font-size: 11px; color: #7d8590; }
`;

const PANEL_HTML = `
  <div class="vkwave-panel__head">
    <span class="vkwave-panel__title">🌊 VK Wave · Настройки</span>
    <button id="vkwave-close" class="vkwave-panel__x" title="Закрыть (Ctrl+Shift+T)">✕</button>
  </div>

  <div class="vkwave-panel__section">Тема</div>
  <div class="vkwave-panel__presets">
    <button data-preset="default" class="vkwave-chip">VK Dark</button>
    <button data-preset="oled" class="vkwave-chip">OLED</button>
    <button data-preset="midnight" class="vkwave-chip">Midnight</button>
    <button data-preset="light" class="vkwave-chip">Light</button>
  </div>
  <label class="vkwave-row">Фон окна <input type="color" id="vkwave-bg-input"></label>
  <label class="vkwave-row">Карточки <input type="color" id="vkwave-cards-input"></label>
  <label class="vkwave-row">Акцент <input type="color" id="vkwave-accent-input"></label>
  <label class="vkwave-row">Скругления <input type="range" id="vkwave-radius-input" min="0" max="32" step="2"></label>

  <div class="vkwave-panel__section">Поведение</div>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-musiconly"> Только музыка</label>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-hotkeys"> Хоткеи (Space, Ctrl+←/→)</label>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-autolaunch"> Запускать с Windows</label>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-startintray"> Стартовать в трее</label>

  <div class="vkwave-panel__actions">
    <button id="vkwave-copy" class="vkwave-btn">Копировать тему</button>
    <button id="vkwave-paste" class="vkwave-btn">Вставить</button>
    <button id="vkwave-reset" class="vkwave-btn vkwave-btn--ghost">Сброс</button>
  </div>
  <div class="vkwave-panel__hint">Тема перекрашивает все цветовые токены VKUI в стилях ВК (текст, иконки, обводки — автоматически). Семантические цвета ошибок/успеха остаются родными.</div>
`;

function flashButton(panel, selector, text) {
  const btn = panel.querySelector(selector);
  if (!btn) return;
  const original = btn.textContent;
  btn.textContent = text;
  setTimeout(() => {
    btn.textContent = original;
  }, 1200);
}

function syncPanel(s) {
  if (!s) return;
  const panel = document.getElementById('vkwave-panel');
  if (!panel) return;
  const t = s.theme || {};
  const setValue = (id, value) => {
    const el = panel.querySelector(`#${id}`);
    if (el) el.value = value;
  };
  setValue('vkwave-bg-input', t.background);
  setValue('vkwave-cards-input', t.cards);
  setValue('vkwave-accent-input', t.accent);
  setValue('vkwave-radius-input', Number(t.radius) || 16);
  panel.querySelectorAll('[data-preset]').forEach((chip) => {
    chip.classList.toggle('vkwave-active', chip.dataset.preset === t.preset);
  });
  const setChecked = (id, value) => {
    const el = panel.querySelector(`#${id}`);
    if (el) el.checked = !!value;
  };
  setChecked('vkwave-musiconly', s.musicOnly);
  setChecked('vkwave-hotkeys', s.hotkeys);
  setChecked('vkwave-autolaunch', s.autoLaunch);
  setChecked('vkwave-startintray', s.startInTray);
}

function buildPanel() {
  if (document.getElementById('vkwave-panel')) return;

  const style = document.createElement('style');
  style.id = 'vkwave-panel-style';
  style.textContent = PANEL_CSS;
  (document.head || document.documentElement).appendChild(style);

  const panel = document.createElement('div');
  panel.id = 'vkwave-panel';
  panel.className = 'vkwave-hidden';
  panel.innerHTML = PANEL_HTML;
  document.body.appendChild(panel);

  panel.querySelectorAll('[data-preset]').forEach((chip) => {
    chip.addEventListener('click', () => {
      const preset = chip.dataset.preset;
      sendSettings({ theme: { ...THEME_PRESETS[preset], preset } });
    });
  });

  const currentTheme = () => (appSettings && appSettings.theme) || THEME_PRESETS.default;

  const bindColor = (id, key) => {
    const el = panel.querySelector(`#${id}`);
    el.addEventListener('input', () => {
      sendSettings({ theme: { ...currentTheme(), [key]: el.value, preset: 'custom' } });
    });
  };
  bindColor('vkwave-bg-input', 'background');
  bindColor('vkwave-cards-input', 'cards');
  bindColor('vkwave-accent-input', 'accent');

  const radius = panel.querySelector('#vkwave-radius-input');
  radius.addEventListener('input', () => {
    sendSettings({ theme: { ...currentTheme(), radius: Number(radius.value), preset: 'custom' } });
  });

  const bindCheckbox = (id, key) => {
    const el = panel.querySelector(`#${id}`);
    el.addEventListener('change', () => sendSettings({ [key]: el.checked }));
  };
  bindCheckbox('vkwave-musiconly', 'musicOnly');
  bindCheckbox('vkwave-hotkeys', 'hotkeys');
  bindCheckbox('vkwave-autolaunch', 'autoLaunch');
  bindCheckbox('vkwave-startintray', 'startInTray');

  panel.querySelector('#vkwave-close').addEventListener('click', () => togglePanel());

  panel.querySelector('#vkwave-copy').addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(JSON.stringify(appSettings.theme, null, 2));
      flashButton(panel, '#vkwave-copy', 'Скопировано ✓');
    } catch (_) {
      flashButton(panel, '#vkwave-copy', 'Не удалось');
    }
  });

  panel.querySelector('#vkwave-paste').addEventListener('click', async () => {
    try {
      const parsed = JSON.parse(await navigator.clipboard.readText());
      if (!parsed || typeof parsed !== 'object') throw new Error('not a theme');
      sendSettings({ theme: { ...parsed, preset: 'custom' } });
      flashButton(panel, '#vkwave-paste', 'Загружено ✓');
    } catch (_) {
      flashButton(panel, '#vkwave-paste', 'Не тема');
    }
  });

  panel.querySelector('#vkwave-reset').addEventListener('click', () => {
    sendSettings({ theme: { ...THEME_PRESETS.default, preset: 'default' } });
  });

  if (appSettings) syncPanel(appSettings);
}

function togglePanel() {
  if (!document.body) return;
  buildPanel();
  const panel = document.getElementById('vkwave-panel');
  if (panel) panel.classList.toggle('vkwave-hidden');
}

async function sendSettings(patch) {
  try {
    const updated = await ipcRenderer.invoke('settings:set', patch);
    appSettings = updated;
    applyTheme(updated);
    syncPanel(updated);
  } catch (_) {
    /* настройки недоступны — изменения не сохранятся */
  }
}

/* ------------------------------ Хоткеи плеера ----------------------------- */

function isEditableTarget(target) {
  if (!target || !target.tagName) return false;
  const tag = target.tagName.toLowerCase();
  return (
    tag === 'input' ||
    tag === 'textarea' ||
    tag === 'select' ||
    (target.isContentEditable === true)
  );
}

function setupHotkeys() {
  window.addEventListener(
    'keydown',
    (event) => {
      if (!appSettings || !appSettings.hotkeys) return;
      if (isEditableTarget(event.target)) return; // не мешаем печатать в поиске

      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === 'ArrowRight') {
        event.preventDefault();
        pressControl('next');
      } else if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === 'ArrowLeft') {
        event.preventDefault();
        pressControl('previous');
      } else if (!event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'Space') {
        event.preventDefault();
        handleTransportAction(state.isPlaying ? 'pause' : 'play');
      }
    },
    true
  );
}

/* --------------------------------- Запуск -------------------------------- */

function init() {
  setupMediaSessionActions();
  setupMediaElementListeners();
  setupMutationObserver();
  setupIpcCommands();

  // Настройки и панель VK Wave (Ctrl+Shift+T / пункт в трее).
  ipcRenderer.on('settings-toggle', () => togglePanel());
  ipcRenderer.on('settings-updated', (_event, s) => {
    appSettings = s;
    applyTheme(s);
    syncPanel(s);
  });
  ipcRenderer
    .invoke('settings:get')
    .then((s) => {
      appSettings = s;
      applyTheme(s);
      syncPanel(s);
    })
    .catch(() => {});
  buildPanel();
  setupHotkeys();

  runExtraction();
  setInterval(runExtraction, POLL_INTERVAL_MS);

  // Живая строка «0:33 / 2:15» в Discord: раз в 5 секунд обновляем время,
  // пока играет. Между обновлениями нативный таймер Discord тикает сам.
  setInterval(() => {
    if (state.isPlaying && state.duration > 0 && state.title) {
      sendTrackUpdate(Date.now(), buildPayload());
    }
  }, 5000);
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
