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
const KEEPALIVE_INTERVAL_MS = 60000;   // периодический ре-синк присутствия
const FALLBACK_SCAN_INTERVAL_MS = 8000;// троттлинг тяжёлого поиска плеера

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
  playerRoot: null,
  coverAccent: null,      // цвет, вытащенный из обложки (main присылает hex)
  lyrics: null,           // { synced: [{time,text}], plain: string|null, key }
  lyricsOpen: false,
  prefetchKey: null,      // ключ трека, для которого лирикс уже запрошен
  lastVinylEl: null       // элемент обложки, на который надет «винил»
};

let appSettings = null; // сводка настроек из главного процесса

/* ---------------------------- Сигнатура трека ----------------------------- */

function trackKey() {
  return `${state.artist || ''}—${state.title || ''}`;
}

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
  updateLyricsHighlight();
  maybeSend();
}


/* -------------------- Web Audio API: EQ, Visualizer, Crossfade ---------------- */

let audioCtx = null;
let mediaSourceNode = null;
let analyserNode = null;
let eqFilters = [];
let gainNode = null;
const EQ_FREQUENCIES = [32, 64, 125, 250, 500, 1000, 2000, 4000, 8000, 16000];
const EQ_PRESETS = {
  flat: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
  bass: [6, 5, 4, 2, 0, 0, 0, 1, 2, 3],
  rock: [4, 3, 1, -1, -2, 0, 2, 4, 5, 5],
  vocal: [-2, -2, -1, 1, 3, 4, 3, 2, 0, -1],
  electronic: [5, 4, 2, 0, -1, 1, 2, 3, 4, 5]
};

function initAudioPipeline(mediaEl) {
  if (!mediaEl) return;
  try {
    if (!audioCtx) {
      const AudioContextClass = window.AudioContext || window.webkitAudioContext;
      if (!AudioContextClass) return;
      audioCtx = new AudioContextClass();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume().catch(() => {});
    }
    if (mediaSourceNode) return; // уже подключён

    mediaSourceNode = audioCtx.createMediaElementSource(mediaEl);
    analyserNode = audioCtx.createAnalyser();
    analyserNode.fftSize = 64;

    gainNode = audioCtx.createGain();
    gainNode.gain.value = 1;

    // 10-полосный эквалайзер
    eqFilters = EQ_FREQUENCIES.map((freq, i) => {
      const filter = audioCtx.createBiquadFilter();
      if (i === 0) filter.type = 'lowshelf';
      else if (i === EQ_FREQUENCIES.length - 1) filter.type = 'highshelf';
      else filter.type = 'peaking';
      filter.frequency.value = freq;
      filter.Q.value = 1.4;
      filter.gain.value = 0;
      return filter;
    });

    // Соединяем цепочку: mediaSource -> eq0 -> eq1 ... -> eq9 -> gain -> analyser -> destination
    let lastNode = mediaSourceNode;
    for (const f of eqFilters) {
      lastNode.connect(f);
      lastNode = f;
    }
    lastNode.connect(gainNode);
    gainNode.connect(analyserNode);
    analyserNode.connect(audioCtx.destination);

    applyEqSettings();
    startWaveVisualizer();
  } catch (_) {
    // CORS ограничения на внешние аудиопотоки могут не позволить перехватить AudioContext
  }
}

function applyEqSettings() {
  if (!eqFilters.length) return;
  const s = appSettings || {};
  const isEnabled = !!s.eqEnabled;
  const gains = Array.isArray(s.eqGains) && s.eqGains.length === 10
    ? s.eqGains
    : (EQ_PRESETS[s.eqPreset] || EQ_PRESETS.flat);

  eqFilters.forEach((filter, i) => {
    try {
      filter.gain.value = isEnabled ? (Number(gains[i]) || 0) : 0;
    } catch (_) {}
  });
}

// Плавный кроссфейд при смене трека
function triggerFadeIn() {
  if (!gainNode || !audioCtx || !appSettings) return;
  const dur = Number(appSettings.crossfadeDuration) || 0;
  if (dur <= 0) {
    try { gainNode.gain.setValueAtTime(1, audioCtx.currentTime); } catch (_) {}
    return;
  }
  try {
    // Мягкий фейд-ин только при начале воспроизведения
    gainNode.gain.setValueAtTime(0.01, audioCtx.currentTime);
    gainNode.gain.exponentialRampToValueAtTime(1, audioCtx.currentTime + dur);
  } catch (_) {
    try { gainNode.gain.setValueAtTime(1, audioCtx.currentTime); } catch (_) {}
  }
}

// Визуализатор частот для тайтлбара
let visualizerRaf = null;
function startWaveVisualizer() {
  if (visualizerRaf) return;
  const data = new Uint8Array(32);
  const loop = () => {
    visualizerRaf = requestAnimationFrame(loop);
    if (!state.isPlaying || !analyserNode || !appSettings || !appSettings.audioVisualizer) {
      const wave = document.getElementById('vkwave-wave');
      if (wave) wave.style.transform = 'scaleY(1)';
      return;
    }
    analyserNode.getByteFrequencyData(data);
    let sum = 0;
    for (let i = 0; i < 16; i++) sum += data[i];
    const avg = sum / 16; // 0..255
    const scale = 0.7 + (avg / 255) * 0.9;
    const wave = document.getElementById('vkwave-wave');
    if (wave) wave.style.transform = `scaleY(${scale.toFixed(2)})`;
  };
  visualizerRaf = requestAnimationFrame(loop);
}

// Smart Resume: сохранение позиции трека
function checkSmartResumeSave() {
  if (!appSettings || !appSettings.smartResume || !state.title) return;
  if (state.currentTime > 15 && state.duration > 180) {
    try {
      localStorage.setItem('vkwave_resume_' + trackKey(), String(Math.floor(state.currentTime)));
    } catch (_) {}
  }
}

function trySmartResumeRestore(el) {
  if (!appSettings || !appSettings.smartResume || !el) return;
  try {
    const saved = localStorage.getItem('vkwave_resume_' + trackKey());
    if (saved && Number(saved) > 10) {
      const pos = Number(saved);
      if (Math.abs(el.currentTime - pos) > 15) {
        el.currentTime = pos;
      }
    }
  } catch (_) {}
}

function setupMediaElementListeners() {
  document.addEventListener('play', onMediaPlay, true);
  document.addEventListener('pause', onMediaPause, true);
  document.addEventListener('ended', onMediaPause, true);
  document.addEventListener('timeupdate', onTimeUpdate, true);
  document.addEventListener('seeked', onTimeUpdate, true);
  document.addEventListener('loadedmetadata', onTimeUpdate, true);
  document.addEventListener('durationchange', onTimeUpdate, true);
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

/** Ещё один источник времени: прогресс-бар ВК — это aria-слайдер
 * (aria-valuemax = длительность, aria-valuenow/valuetext = позиция). */
function readTimesFromSlider(root) {
  if (!root) return null;
  const sliders = root.querySelectorAll('[role="slider"], [aria-valuemax]');
  for (const slider of sliders) {
    const max = parseFloat(slider.getAttribute('aria-valuemax') || '');
    if (!Number.isFinite(max) || max <= 5) continue; // отсеиваем слайдер громкости
    const now = parseFloat(slider.getAttribute('aria-valuenow') || '');
    const text = slider.getAttribute('aria-valuetext') || '';
    if (Number.isFinite(max)) {
      return {
        currentTime: Number.isFinite(now) && now >= 0 ? now : -1,
        duration: max
      };
    }
    const match = /(\d{1,2}:\d{2})(?:\D+(\d{1,2}:\d{2}))?/.exec(text);
    if (match) {
      const toSeconds = (value) => {
        const parts = value.split(':').map(Number);
        return parts[0] * 60 + parts[1];
      };
      return {
        currentTime: toSeconds(match[1]),
        duration: match[2] ? toSeconds(match[2]) : 0
      };
    }
  }
  return null;
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

    // Тяжёлый проход по всем узлам нужен только без живого <audio> —
    // с активным элементом время точнее из timeupdate.
    if (!state.activeMedia) {
      const times = readTimesFromDom(root);
      if (times) {
        if (times.duration > 0 && Math.abs(times.duration - state.duration) > 1) {
          state.duration = times.duration;
        }
        if (times.currentTime >= 0) state.currentTime = times.currentTime;
      }
    }

    // Длительность так и не известна? Пробуем aria-слайдер прогресс-бара ВК.
    if (!(state.duration > 0)) {
      const sliderTimes = readTimesFromSlider(root);
      if (sliderTimes) {
        if (sliderTimes.duration > 0) state.duration = sliderTimes.duration;
        if (
          sliderTimes.currentTime >= 0 &&
          Math.abs(sliderTimes.currentTime - state.currentTime) <= 30
        ) {
          state.currentTime = sliderTimes.currentTime;
        }
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

  // Визуальные эффекты и лирикс-префетч — следом за сводкой о треке.
  syncEffectClasses();
  if (appSettings && appSettings.vinylMode) applyVinyl();
  updateFullscreenOverlay();
  if (payload.title && payload.artist && state.prefetchKey !== lyricsRequestId()) {
    requestLyrics(); // фоновой prefetch: панель откроется с готовым текстом
  }
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

/* -------------------- Волна в тайтлбаре, винил, ambient ------------------- */

const WAVE_CSS = `
  #vkwave-wave {
    position: fixed; top: 0; left: 0; width: 100%; height: 34px;
    z-index: 2147483647; pointer-events: none;
    -webkit-app-region: drag;
    opacity: 0; transition: opacity .4s ease;
    overflow: hidden;
  }
  body.vkwave-wave-on #vkwave-wave { opacity: 1; }
  #vkwave-wave svg { position: absolute; left: 0; top: 0; width: 200%; height: 34px; }
  #vkwave-wave path { fill: var(--vkwave-accent, #0077ff); }
  #vkwave-wave .vkwave-wfront { opacity: .38; animation: vkwave-drift 9s linear infinite; animation-play-state: paused; }
  #vkwave-wave .vkwave-wback { opacity: .16; animation: vkwave-drift 14s linear infinite reverse; animation-play-state: paused; }
  body.vkwave-playing #vkwave-wave .vkwave-wfront,
  body.vkwave-playing #vkwave-wave .vkwave-wback { animation-play-state: running; }
  @keyframes vkwave-drift {
    from { transform: translateX(0); }
    to   { transform: translateX(-240px); }
  }
  /* Винил-режим: обложка в плеере ВК становится пластинкой. */
  
  /* Винил с физикой остановки */
  .vkwave-vinyl {
    border-radius: 50% !important;
    animation: vkwave-spin 10s linear infinite;
    animation-play-state: paused;
    box-shadow: 0 4px 18px rgba(0,0,0,.6), inset 0 0 0 2px rgba(255,255,255,.15) !important;
    transition: transform .8s cubic-bezier(.25, 1, .5, 1);
  }
  body.vkwave-playing .vkwave-vinyl {
    animation-play-state: running;
  }

  .vkwave-vinyl-legacy {
    border-radius: 50% !important;
    animation: vkwave-spin 12s linear infinite;
    animation-play-state: paused;
  }
  body.vkwave-playing .vkwave-vinyl { animation-play-state: running; }
  @keyframes vkwave-spin {
    from { transform: rotate(0deg); }
    to   { transform: rotate(360deg); }
  }
  /* Ambient-фон: размытая обложка за интерфейсом. */
  #vkwave-ambient {
    position: fixed; inset: -40px; z-index: -1;
    background-position: center; background-size: cover;
    filter: blur(52px) saturate(1.25);
    transform: scale(1.1);
    opacity: 0; transition: opacity .8s ease;
    pointer-events: none;
  }
  body.vkwave-ambient-on #vkwave-ambient { opacity: .55; }

  /* Чистый полноэкранный режим */
  #vkwave-fullscreen-overlay {
    position: fixed; inset: 0; z-index: 2147483645;
    background: #0f0f13;
    display: flex; flex-direction: column; align-items: center; justify-content: center;
    color: #fff; font-family: -apple-system, "Segoe UI", Roboto, sans-serif;
    transition: opacity .3s ease;
    opacity: 0; pointer-events: none;
  }
  body.vkwave-clean-fullscreen #vkwave-fullscreen-overlay {
    opacity: 1; pointer-events: all;
  }
  .vkwave-fs__cover {
    width: 280px; height: 280px; border-radius: 18px;
    box-shadow: 0 20px 60px rgba(0,0,0,.7); margin-bottom: 24px;
    background-size: cover; background-position: center;
  }
  .vkwave-fs__title { font-size: 24px; font-weight: 700; margin-bottom: 6px; text-align: center; }
  .vkwave-fs__artist { font-size: 16px; color: #a1a1aa; margin-bottom: 20px; }
  .vkwave-fs__exit {
    position: absolute; top: 16px; right: 20px;
    background: rgba(255,255,255,.1); border: 0; color: #fff;
    padding: 6px 12px; border-radius: 8px; cursor: pointer; font-size: 12px;
  }
  .vkwave-fs__exit:hover { background: rgba(255,255,255,.2); }


  /* Кастомный фон и секретная тема */
  #vkwave-custom-bg {
    position: fixed; inset: 0; z-index: -2;
    background-position: center; background-size: cover; background-repeat: no-repeat;
    opacity: 0; transition: opacity .6s ease;
    pointer-events: none;
  }
  body.vkwave-custombg-on #vkwave-custom-bg { opacity: 1; }

  /* Нативный тост разблокировки темы */
  #vkwave-secret-overlay {
    position: fixed; bottom: 28px; left: 50%; transform: translateX(-50%);
    background: #18191e; color: #f4f4f5;
    border: 1px solid #27272a; border-radius: 8px;
    padding: 10px 18px; font-size: 13px; font-weight: 500;
    box-shadow: 0 10px 30px rgba(0,0,0,.45);
    z-index: 2147483647; display: flex; align-items: center; gap: 10px;
    transition: opacity .25s ease, transform .25s ease;
  }
  .vkwave-secret__tag {
    font-size: 11px; text-transform: uppercase; letter-spacing: .06em;
    color: #a1a1aa; background: #27272a; padding: 2px 6px; border-radius: 4px;
  }


  /* Компактный режим: кнопка в тайтлбаре */
  #vkwave-pip-btn {
    position: fixed; top: 6px; left: 8px; z-index: 2147483647;
    background: none; border: 0; color: rgba(255,255,255,.55); font-size: 13px;
    cursor: pointer; padding: 2px 6px; border-radius: 6px; line-height: 1;
    pointer-events: all; -webkit-app-region: no-drag;
    transition: color .15s, background .15s;
  }
  #vkwave-pip-btn:hover { color: #fff; background: rgba(255,255,255,.1); }

  #vkwave-ambient-b {
    position: fixed; inset: -40px; z-index: -1;
    background-position: center; background-size: cover;
    filter: blur(52px) saturate(1.25);
    transform: scale(1.1);
    pointer-events: none;
  }
`;

/** Ambient реально включён (есть и настройка, и обложка)? */
function ambientActive() {
  return !!(appSettings && appSettings.ambientCover && state.coverUrl);
}

// Бесшовный тайл волны: квадратичные T-сегменты с периодом 60px — начало
// и конец паттерна совпадают по позиции И наклону, стыков невидно.
const WAVE_PATTERN_D =
  'M0 20 Q 15 12 30 20 T 60 20 T 90 20 T 120 20 T 150 20 T 180 20 T 210 20 T 240 20 L 240 34 L 0 34 Z';

let waveEl = null;



function showSecretUnlockBanner() {
  const existing = document.getElementById('vkwave-secret-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.id = 'vkwave-secret-overlay';
  overlay.innerHTML = `
    <span class="vkwave-secret__tag">Секрет</span>
    <span>Разблокирована тема Anime · <b>+rep wvunison</b></span>
  `;
  document.body.appendChild(overlay);

  setTimeout(() => {
    overlay.style.opacity = '0';
    overlay.style.transform = 'translate(-50%, 8px)';
    setTimeout(() => overlay.remove(), 250);
  }, 3500);
}


let fullscreenOverlayEl = null;

function buildFullscreenOverlay() {
  if (fullscreenOverlayEl && fullscreenOverlayEl.isConnected) return;
  fullscreenOverlayEl = document.createElement('div');
  fullscreenOverlayEl.id = 'vkwave-fullscreen-overlay';
  fullscreenOverlayEl.innerHTML = `
    <button class="vkwave-fs__exit">Выйти из полного экрана (Esc / F11)</button>
    <div class="vkwave-fs__cover"></div>
    <div class="vkwave-fs__title">Трек</div>
    <div class="vkwave-fs__artist">Исполнитель</div>
  `;
  fullscreenOverlayEl.querySelector('.vkwave-fs__exit').addEventListener('click', () => toggleCleanFullscreen(false));
  document.body.appendChild(fullscreenOverlayEl);
}

function updateFullscreenOverlay() {
  if (!fullscreenOverlayEl) return;
  const coverEl = fullscreenOverlayEl.querySelector('.vkwave-fs__cover');
  const titleEl = fullscreenOverlayEl.querySelector('.vkwave-fs__title');
  const artistEl = fullscreenOverlayEl.querySelector('.vkwave-fs__artist');
  
  // Пытаемся получить обложку из state.coverUrl, либо из DOM плеера напрямую
  let cover = state.coverUrl;
  if (!cover) {
    const root = findPlayerRoot();
    if (root) cover = readCoverFromDom(root);
  }
  if (!cover) {
    const anyImg = document.querySelector('img[src*="userapi.com"], img[src*="vk-cdn"]');
    if (anyImg) cover = anyImg.currentSrc || anyImg.src;
  }

  if (coverEl) {
    if (cover) {
      coverEl.style.backgroundImage = `url("${cover}")`;
      coverEl.style.display = 'block';
    } else {
      coverEl.style.backgroundImage = 'none';
      coverEl.style.backgroundColor = 'var(--vkwave-cards, #1d1d22)';
    }
  }
  if (titleEl) titleEl.textContent = state.title || 'VK Музыка';
  if (artistEl) artistEl.textContent = state.artist || 'Воспроизведение';
}

function toggleCleanFullscreen(force) {
  buildFullscreenOverlay();
  const active = typeof force === 'boolean' ? force : !document.body.classList.contains('vkwave-clean-fullscreen');
  document.body.classList.toggle('vkwave-clean-fullscreen', active);
  if (active) updateFullscreenOverlay();
}

function buildPipButton() {
  if (document.getElementById('vkwave-pip-btn')) return;
  const btn = document.createElement('button');
  btn.id = 'vkwave-pip-btn';
  btn.title = 'Компактный режим (мини-плеер)';
  btn.textContent = '⧉';
  btn.addEventListener('click', () => {
    ipcRenderer.invoke('window:toggle-pip').catch(() => {});
  });
  document.body.appendChild(btn);
}

function buildWave() {
  if (waveEl && waveEl.isConnected) return;
  if (!document.getElementById('vkwave-wave-style')) {
    const style = document.createElement('style');
    style.id = 'vkwave-wave-style';
    style.textContent = WAVE_CSS;
    (document.head || document.documentElement).appendChild(style);
  }
  waveEl = document.createElement('div');
  waveEl.id = 'vkwave-wave';
  // Инлайн-SVG: path наследует var(--vkwave-accent) — волна живёт в теме.
  waveEl.innerHTML =
    `<svg xmlns="http://www.w3.org/2000/svg">` +
    `<defs>` +
    `<pattern id="vkwave-wp-f" width="240" height="34" patternUnits="userSpaceOnUse"><path d="${WAVE_PATTERN_D}"/></pattern>` +
    `<pattern id="vkwave-wp-b" width="240" height="34" patternUnits="userSpaceOnUse"><path d="${WAVE_PATTERN_D}"/></pattern>` +
    `</defs>` +
    `<rect class="vkwave-wback" width="200%" height="34" fill="url(#vkwave-wp-b)"/>` +
    `<rect class="vkwave-wfront" width="200%" height="34" fill="url(#vkwave-wp-f)"/>` +
    `</svg>`;
  document.body.appendChild(waveEl);
}

let ambientEl = null;
let ambientElB = null;
let ambientFadeTimer = null;


let customBgEl = null;

function buildCustomBg() {
  if (customBgEl && customBgEl.isConnected) return;
  customBgEl = document.createElement('div');
  customBgEl.id = 'vkwave-custom-bg';
  document.body.appendChild(customBgEl);
}

function updateCustomBg(url) {
  buildCustomBg();
  if (customBgEl) {
    if (url) {
      customBgEl.style.backgroundImage = `linear-gradient(180deg, rgba(14,10,24,.4), rgba(14,10,24,.75)), url("${url}")`;
      document.body.classList.add('vkwave-custombg-on');
    } else {
      customBgEl.style.backgroundImage = 'none';
      document.body.classList.remove('vkwave-custombg-on');
    }
  }
}

function buildAmbient() {
  if (ambientEl && ambientEl.isConnected) return;
  const gradient = 'linear-gradient(180deg, rgba(0,0,0,.32), rgba(0,0,0,.62))';
  ambientEl = document.createElement('div');
  ambientEl.id = 'vkwave-ambient';
  ambientEl.style.backgroundImage = `${gradient}, var(--vkwave-cover-image, none)`;
  document.body.appendChild(ambientEl);

  ambientElB = document.createElement('div');
  ambientElB.id = 'vkwave-ambient-b';
  ambientElB.style.backgroundImage = gradient;
  ambientElB.style.opacity = '0';
  ambientElB.style.transition = 'opacity .9s ease';
  document.body.appendChild(ambientElB);
}

/** Обложка пришла из main (dataURL): плавный crossfade ambient-фона. */
function onCoverImage(dataUrl) {
  if (!dataUrl) return;
  buildAmbient();
  if (ambientElB) {
    const gradient = 'linear-gradient(180deg, rgba(0,0,0,.32), rgba(0,0,0,.62))';
    ambientElB.style.backgroundImage = `${gradient}, url("${dataUrl}")`;
    ambientElB.style.opacity = '0.55';
    if (ambientFadeTimer) clearTimeout(ambientFadeTimer);
    ambientFadeTimer = setTimeout(() => {
      document.documentElement.style.setProperty('--vkwave-cover-image', `url("${dataUrl}")`);
      if (ambientElB) ambientElB.style.opacity = '0';
      ambientFadeTimer = null;
    }, 900);
  } else {
    document.documentElement.style.setProperty('--vkwave-cover-image', `url("${dataUrl}")`);
  }
  syncEffectClasses();
}

function syncEffectClasses() {
  if (!document.body) return;
  const s = appSettings || {};
  document.body.classList.toggle('vkwave-playing', !!state.isPlaying);
  // Волна включена по умолчанию; тумблера нет — она и есть «подпись» клиента.
  buildWave();
  document.body.classList.toggle('vkwave-wave-on', true);
  buildPipButton();
  if (s && s.customBackground) updateCustomBg(s.customBackground);
  else updateCustomBg(null);
  document.body.classList.toggle(
    'vkwave-ambient-on',
    !!s.ambientCover && !!state.coverUrl
  );
}

/** Винил: навешиваем класс на текущий элемент обложки в плеере ВК. */
function applyVinyl() {
  if (!appSettings || !appSettings.vinylMode) return;
  const root = findPlayerRoot();
  if (!root) return;
  const coverEl =
    root.querySelector('img') ||
    root.querySelector('[style*="background-image"]');
  if (!coverEl || coverEl === state.lastVinylEl) return;
  if (state.lastVinylEl) state.lastVinylEl.classList.remove('vkwave-vinyl');
  coverEl.classList.add('vkwave-vinyl');
  state.lastVinylEl = coverEl;
}

function disableVinyl() {
  if (state.lastVinylEl) {
    state.lastVinylEl.classList.remove('vkwave-vinyl');
    state.lastVinylEl = null;
  }
}

/* --------------- Точное время из API плеера ВК (главный мир) --------------- */
/* У нового плеера ВК нет <audio> в DOM (звук идёт мимо документа), поэтому
   timeupdate не тикает. Зато жив window.ap: getCurrentProgressTime() (мс),
   getCurrentDuration() (с), isPlaying(). Опрашиваем его тем же паттерном,
   что и кнопки управления — это источник времени для караоке и Discord. */

function syncApState() {
  const script =
    '(function(){try{var a=window.ap;' +
    'if(!a||typeof a.getCurrentProgressTime!=="function")return null;' +
    'return {t:a.getCurrentProgressTime()/1000,d:Number(a.getCurrentDuration())||0,' +
    'playing:(typeof a.isPlaying==="function")?!!a.isPlaying():null};}catch(e){return null;}})()';
  return webFrame
    .executeJavaScript(script, true)
    .then((st) => {
      if (!st || typeof st.t !== 'number' || !Number.isFinite(st.t) || st.t < 0) return;
      if (state.activeMedia) return; // старый DOM-плеер: элементные события точнее
      state.currentTime = st.t;
      if (st.d > 0 && Number.isFinite(st.d)) state.duration = st.d;
      if (st.playing !== null) state.isPlaying = st.playing;
      updateLyricsHighlight();
      maybeSend();
    })
    .catch(() => {});
}

/* ------------------------------ Лирикс-панель ----------------------------- */

const LYRICS_CSS = `
  #vkwave-lyrics {
    position: fixed; top: 46px; right: 12px; width: 380px; max-height: 72vh;
    background: #17171b; color: #e8eaf0;
    border: 1px solid #2a2a31; border-radius: 14px;
    box-shadow: 0 18px 48px rgba(0, 0, 0, .5);
    padding: 14px; z-index: 2147483641;
    font: 13px/1.5 -apple-system, "Segoe UI", Roboto, sans-serif;
    display: flex; flex-direction: column;
    transition: transform .18s ease, opacity .18s ease;
  }
  #vkwave-lyrics.vkwave-hidden { transform: translateX(24px); opacity: 0; pointer-events: none; }
  #vkwave-lyrics .vkwave-lyrics__head {
    display: flex; align-items: center; justify-content: space-between; gap: 8px;
    margin-bottom: 10px;
  }
  #vkwave-lyrics .vkwave-lyrics__title {
    font-weight: 600; font-size: 14px; overflow: hidden; text-overflow: ellipsis;
    white-space: nowrap;
  }
  #vkwave-lyrics .vkwave-lyrics__x {
    background: none; border: 0; color: #9aa0ab; font-size: 14px; cursor: pointer;
    padding: 4px 8px; border-radius: 8px;
  }
  #vkwave-lyrics .vkwave-lyrics__x:hover { background: #232329; color: #fff; }
  #vkwave-lyrics .vkwave-lyrics__body {
    overflow-y: auto; scrollbar-width: thin; padding-right: 6px;
  }
  #vkwave-lyrics .vkwave-lyr {
    padding: 5px 8px; border-radius: 8px; color: #8f96a3;
    font-size: 13.5px; transition: background .15s ease, color .15s ease;
  }
  #vkwave-lyrics .vkwave-lyr.vkwave-lyr--active {
    background: rgba(0, 119, 255, .16); color: #fff;
    font-weight: 600;
  }
  #vkwave-lyrics .vkwave-lyr--plain { color: #c6cbd4; padding: 2px 0; }
  #vkwave-lyrics .vkwave-lyrics__empty { color: #7d8590; padding: 18px 0; text-align: center; }

  #vkwave-lyrics {
    backdrop-filter: blur(20px) saturate(1.6) !important;
    -webkit-backdrop-filter: blur(20px) saturate(1.6) !important;
    background: rgba(20, 20, 24, 0.88) !important;
    border: 1px solid rgba(255, 255, 255, 0.09) !important;
    box-shadow: 0 24px 64px rgba(0, 0, 0, .65), 0 0 0 1px rgba(255, 255, 255, .04) inset !important;
  }
  #vkwave-lyrics .vkwave-lyr {
    transition: all .2s ease;
  }
  #vkwave-lyrics .vkwave-lyr:hover {
    background: rgba(255, 255, 255, .06) !important;
  }
  #vkwave-lyrics-copy-btn {
    background: none; border: 0; color: #9aa0ab; font-size: 13px;
    cursor: pointer; padding: 2px 6px; border-radius: 6px;
    transition: color .15s, background .15s;
  }
  #vkwave-lyrics-copy-btn:hover { background: #232329; color: #fff; }
`;

let lyricsEl = null;
let lyricsBodyEl = null;
let lyricsActiveIndex = -1;
let lyricsSyncTimer = null;

function parseLrc(raw) {
  const lines = [];
  for (const rawLine of String(raw).split('\n')) {
    // Строка может содержать несколько меток: [00:12.34][00:45.67]Текст.
    const tagRe = /\[(\d{1,2}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    const matches = Array.from(rawLine.matchAll(tagRe));
    if (!matches.length) continue;
    const text = rawLine.replace(tagRe, '').trim();
    for (const match of matches) {
      const time =
        Number(match[1]) * 60 +
        Number(match[2]) +
        (match[3] ? Number(`0.${match[3]}`) : 0);
      lines.push({ time, text });
    }
  }
  lines.sort((a, b) => a.time - b.time);
  return lines;
}

function lyricsRequestId() {
  return `${state.artist || ''}|${state.title || ''}|${Math.round(state.duration || 0)}`;
}

/** Просим текст у main (LRCLIB-прокси) и рендерим панель, если она открыта. */
async function requestLyrics(force) {
  if (!state.title || !state.artist) return;
  const key = lyricsRequestId();
  if (!force && state.prefetchKey === key) return;
  state.prefetchKey = key;

  try {
    const data = await ipcRenderer.invoke('lyrics:get', {
      artist: state.artist,
      title: state.title,
      duration: state.duration
    });
    // Пока качали — трек сменился; складываем в state, но панель не перерисовываем зря.
    if (lyricsRequestId() !== key) return;
    if (data && data.synced) {
      state.lyrics = { synced: parseLrc(data.synced), plain: null, key };
    } else if (data && data.plain) {
      state.lyrics = { synced: null, plain: data.plain, key };
    } else {
      state.lyrics = { synced: null, plain: null, key };
    }
    if (state.lyricsOpen) renderLyrics();
  } catch (_) {
    state.lyrics = null;
    state.prefetchKey = null; // позволяем повторить запрос
  }
}

function renderLyrics() {
  if (!lyricsEl || !state.lyricsOpen) return;
  const head = lyricsEl.querySelector('.vkwave-lyrics__title');
  if (head) head.textContent = `${state.artist} — ${state.title}`;

  lyricsBodyEl.innerHTML = '';
  lyricsActiveIndex = -1;

  if (state.lyrics && Array.isArray(state.lyrics.synced) && state.lyrics.synced.length) {
    for (const line of state.lyrics.synced) {
      const div = document.createElement('div');
      div.className = 'vkwave-lyr';
      div.textContent = line.text || '♪';
      lyricsBodyEl.appendChild(div);
    }
  } else if (state.lyrics && state.lyrics.plain) {
    for (const text of state.lyrics.plain.split('\n')) {
      const div = document.createElement('div');
      div.className = 'vkwave-lyr vkwave-lyr--plain';
      div.textContent = text || ' ';
      lyricsBodyEl.appendChild(div);
    }
  } else {
    const empty = document.createElement('div');
    empty.className = 'vkwave-lyrics__empty';
    empty.textContent =
      state.lyrics
        ? 'Текст не найден в LRCLIB 🙃'
        : 'Ищу текст песни…';
    lyricsBodyEl.appendChild(empty);
  }
}

/** Караоке-подсветка: вызывается из onTimeUpdate. */
function updateLyricsHighlight() {
  if (!state.lyricsOpen || !state.lyrics || !state.lyrics.synced) return;
  const lines = state.lyrics.synced;
  let index = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].time <= state.currentTime) index = i;
    else break;
  }
  if (index === lyricsActiveIndex) return;
  lyricsActiveIndex = index;

  const nodes = lyricsBodyEl.querySelectorAll('.vkwave-lyr');
  if (nodes[lyricsActiveIndex]) {
    for (const node of nodes) node.classList.remove('vkwave-lyr--active');
    nodes[lyricsActiveIndex].classList.add('vkwave-lyr--active');
    // Держим активную строку по центру, но не дёргаем прокрутку постоянно.
    nodes[lyricsActiveIndex].scrollIntoView({
      block: 'center',
      behavior: 'smooth'
    });
  }
}

function buildLyricsPanel() {
  if (lyricsEl && lyricsEl.isConnected) return;
  const style = document.createElement('style');
  style.id = 'vkwave-lyrics-style';
  style.textContent = LYRICS_CSS;
  (document.head || document.documentElement).appendChild(style);

  lyricsEl = document.createElement('div');
  lyricsEl.id = 'vkwave-lyrics';
  lyricsEl.className = 'vkwave-hidden';
  lyricsEl.innerHTML = `
    <div class="vkwave-lyrics__head">
      <span class="vkwave-lyrics__title">Текст песни</span>
      <div style="display:flex;gap:4px;align-items:center">
        <button id="vkwave-lyrics-copy-btn" title="Копировать текст">Копировать</button>
        <button class="vkwave-lyrics__x" title="Закрыть (L)">✕</button>
      </div>
    </div>
    <div class="vkwave-lyrics__body"></div>
  `;
  document.body.appendChild(lyricsEl);
  lyricsBodyEl = lyricsEl.querySelector('.vkwave-lyrics__body');
  lyricsEl.querySelector('.vkwave-lyrics__x').addEventListener('click', () => toggleLyrics());
  const copyLyricsBtn = lyricsEl.querySelector('#vkwave-lyrics-copy-btn');
  if (copyLyricsBtn) {
    copyLyricsBtn.addEventListener('click', async () => {
      try {
        const lines = [];
        if (state.lyrics && state.lyrics.synced) {
          state.lyrics.synced.forEach((l) => lines.push(l.text));
        } else if (state.lyrics && state.lyrics.plain) {
          lines.push(state.lyrics.plain);
        }
        if (lines.length) {
          await ipcRenderer.invoke('clipboard:write', lines.join('\n'));
          copyLyricsBtn.textContent = 'Скопировано';
          setTimeout(() => { copyLyricsBtn.textContent = 'Копировать'; }, 1500);
        }
      } catch (_) {}
    });
  }
}

function toggleLyrics(forceOpen) {
  buildLyricsPanel();
  const open = typeof forceOpen === 'boolean' ? forceOpen : !state.lyricsOpen;
  state.lyricsOpen = open;
  lyricsEl.classList.toggle('vkwave-hidden', !open);
  if (open) {
    // Панели делят правый край — не даём им толкаться.
    const settingsPanel = document.getElementById('vkwave-panel');
    if (settingsPanel) settingsPanel.classList.add('vkwave-hidden');
    if (
      !state.lyrics ||
      state.lyrics.key !== lyricsRequestId() ||
      (!state.lyrics.synced && !state.lyrics.plain && state.lyrics.key === lyricsRequestId())
    ) {
      // Новый трек или прошлый раз текста не было — переспрашиваем.
      state.prefetchKey = null;
      state.lyrics = null;
      renderLyrics();
      requestLyrics(true);
    } else {
      renderLyrics();
    }
  }
}

/** Применяет эффектные настройки поверх applyTheme — единая точка для
 * sendSettings и broadcast'а settings-updated. */
function applySettingsEffects(s) {
  applyTheme(s);
  syncEffectClasses();
  if (s && s.vinylMode) applyVinyl();
  else disableVinyl();
}

/** Единая точка приёма настроек: main присылает их вместе с пресетами тем. */
function applySettingsPayload(s) {
  if (!s || typeof s !== 'object') return;
  if (s.presets && typeof s.presets === 'object') {
    THEME_PRESETS = s.presets;
  }
  appSettings = s;
  applySettingsEffects(s);
  syncPanel(s);
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
  // Без attributes: ВК дёргает стиль прогресс-бара десятки раз в секунду —
  // это самый горячий источник мутаций. Смены трека ловим по childList/characterData.
  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
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

/**
 * Пресеты приходят из main вместе с настройками: preload в sandbox не может
 * require'ить shared/theme.js. До первого ответа используем безопасный дефолт.
 */
const FALLBACK_THEME = {
  background: '#141414',
  cards: '#1d1d22',
  accent: '#0077ff',
  radius: 16
};
let THEME_PRESETS = { default: FALLBACK_THEME };

/** Базовое переопределение (если скан токенов ВК ничего не нашёл). */
function vkuiFallbackCss() {
  // При ambient фон-контейнеры ВК полупрозрачные — сквозь них видно обложку.
  const bgToken = ambientActive()
    ? 'color-mix(in srgb, var(--vkwave-cards) 72%, transparent)'
    : 'var(--vkwave-cards)';
  return `
  :root {
    --vkui--color_background: var(--vkwave-bg) !important;
    --vkui--color_background_page: var(--vkwave-bg) !important;
    --vkui--color_background_content: ${bgToken} !important;
    --vkui--color_background_secondary: ${bgToken} !important;
    --vkui--color_background_tertiary: ${bgToken} !important;
    --vkui--color_background_accent: var(--vkwave-accent) !important;
    --vkui--color_background_accent_tint: var(--vkwave-accent) !important;
    --vkui--color_stroke_accent: var(--vkwave-accent) !important;
    --vkui--color_icon_accent: var(--vkwave-accent) !important;
    --vkui--color_text_link: var(--vkwave-accent) !important;
    --vkui--size_border_radius--regular: var(--vkwave-radius) !important;
    --vkui--size_border_radius: var(--vkwave-radius) !important;
  }
  body { background: var(--vkwave-bg) !important; }

    /* Центрирование контента VK Музыки */
    #audio, .audio_page, [class*="AudioPage"], [class*="MusicPage"], [id*="audio_page"] {
      max-width: 1140px !important;
      margin-left: auto !important;
      margin-right: auto !important;
    }
    .page_block {
      max-width: none !important;
    }
`;
}

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
  if (n.includes('background')) {
    return ambientActive()
      ? 'color-mix(in srgb, var(--vkwave-cards) 72%, transparent)'
      : 'var(--vkwave-cards)';
  }
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

/** Смешивает два hex-цвета: ratio — доля второго (обложечного). */
function hexMix(hexA, hexB, ratio) {
  const parse = (hex) => {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
    return m ? parseInt(m[1], 16) : null;
  };
  const a = parse(hexA);
  const b = parse(hexB);
  if (a === null) return hexB || hexA;
  if (b === null) return hexA;
  const mix = (sa, sb) => Math.round(sa * (1 - ratio) + sb * ratio);
  const r = mix((a >> 16) & 255, (b >> 16) & 255);
  const g = mix((a >> 8) & 255, (b >> 8) & 255);
  const bl = mix(a & 255, b & 255);
  return `#${((r << 16) | (g << 8) | bl).toString(16).padStart(6, '0')}`;
}

function applyTheme(s) {
  const t = (s && s.theme) || {};
  let bg = t.background || '#141414';
  const light = isLightBackground(bg);
  const root = document.documentElement;

  // Ambient-фон: сама «подложка» ВК слегка просвечивает — сквозь неё видна
  // размытая обложка. Тайтлбар и карточки остаются плотными.
  if (ambientActive()) {
    bg = `color-mix(in srgb, ${bg} 78%, transparent)`;
  }

  // Акцент: подмешиваем цвет обложки (35%), если включено и цвет извлечён.
  let accent = t.accent || '#0077ff';
  if (s.accentFromCover && state.coverAccent) {
    accent = hexMix(accent, state.coverAccent, 0.35);
  }

  root.style.setProperty('--vkwave-bg', bg);
  root.style.setProperty('--vkwave-cards', t.cards || '#1d1d22');
  root.style.setProperty('--vkwave-accent', accent);
  root.style.setProperty('--vkwave-text', light ? '#1d1d22' : '#e8eaf0');
  root.style.setProperty('--vkwave-stroke', light ? 'rgba(0, 0, 0, 0.14)' : 'rgba(255, 255, 255, 0.14)');
  root.style.setProperty('--vkwave-radius', `${Number(t.radius) || 16}px`);

  if (!themeStyleEl || !themeStyleEl.isConnected) {
    themeStyleEl = document.createElement('style');
    themeStyleEl.id = 'vkwave-theme';
    (document.head || document.documentElement).appendChild(themeStyleEl);
  }
  // Пресет «default» = родная тема ВК... кроме ambient: тогда всё равно
  // вмешиваемся, иначе VK рисует непрозрачные контейнеры поверх обложки.
  const needOverride = ambientActive() || (t.preset && t.preset !== 'default');
  if (!needOverride) {
    themeStyleEl.textContent = '';
    return;
  }
  themeStyleEl.textContent = buildDeepThemeOverride() || vkuiFallbackCss();

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
    max-height: calc(100vh - 60px); overflow-y: auto; scrollbar-width: thin;
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
  #vkwave-panel select {
    background: #232329; color: #e8eaf0; border: 1px solid #2f2f37;
    border-radius: 8px; padding: 4px 8px; font-size: 12px; cursor: pointer;
  }
  #vkwave-panel .vkwave-mem { margin-top: 6px; font-size: 11.5px; color: #aab2bf; line-height: 1.7; }
  #vkwave-panel .vkwave-mem b { color: #e8eaf0; }

  #vkwave-panel {
    backdrop-filter: blur(20px) saturate(1.6) !important;
    -webkit-backdrop-filter: blur(20px) saturate(1.6) !important;
    background: rgba(20, 20, 24, 0.88) !important;
    border: 1px solid rgba(255, 255, 255, 0.09) !important;
    box-shadow: 0 24px 64px rgba(0, 0, 0, .65), 0 0 0 1px rgba(255, 255, 255, .04) inset !important;
  }
  #vkwave-panel .vkwave-panel__section {
    padding: 6px 0 3px;
    border-bottom: 1px solid rgba(255, 255, 255, 0.06);
    margin-bottom: 4px;
    font-weight: 600;
  }
  #vkwave-panel .vkwave-chip {
    transition: background .12s ease, transform .1s ease;
  }
  #vkwave-panel .vkwave-chip:hover {
    transform: translateY(-1px);
    background: #2e2e38 !important;
  }
  #vkwave-panel .vkwave-btn {
    transition: background .12s ease, transform .1s ease;
  }
  #vkwave-panel .vkwave-btn:hover {
    transform: translateY(-1px);
  }
  #vkwave-panel input[type="color"] {
    transition: transform .1s ease;
  }
  #vkwave-panel input[type="color"]:hover {
    transform: scale(1.08);
  }
`;

const PANEL_HTML = `
  <div class="vkwave-panel__head">
    <span class="vkwave-panel__title">Настройки VK Wave</span>
    <button id="vkwave-close" class="vkwave-panel__x" title="Закрыть (Ctrl+Shift+T)">✕</button>
  </div>

  <div class="vkwave-panel__section">Тема</div>
  <div class="vkwave-panel__presets">
    <button data-preset="default" class="vkwave-chip">VK Dark</button>
    <button data-preset="oled" class="vkwave-chip">OLED</button>
    <button data-preset="midnight" class="vkwave-chip">Midnight</button>
    <button data-preset="light" class="vkwave-chip">Light</button>
    <button data-preset="sakura" class="vkwave-chip">Sakura</button>
    <button data-preset="emerald" class="vkwave-chip">Emerald</button>
    <button data-preset="lavender" class="vkwave-chip">Lavender</button>
    <button data-preset="amber" class="vkwave-chip">Amber</button>
    <button data-preset="cyberpunk" class="vkwave-chip">Cyberpunk</button>
    <button data-preset="ocean" class="vkwave-chip">Ocean</button>
    <button data-preset="graphite" class="vkwave-chip">Graphite</button>
    <button data-preset="coffee" class="vkwave-chip">Coffee</button>
    <button data-preset="neon" class="vkwave-chip">Neon</button>
        <button data-preset="halloween" class="vkwave-chip">Halloween</button>
    <button data-preset="anime" id="vkwave-chip-anime" class="vkwave-chip" style="display:none;background:#2d1b38;color:#f472b6;border:1px solid #3b2149;">Anime</button>
  </div>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-autodaynight"> Авто день/ночь (Light ↔ Midnight)</label>
  <label class="vkwave-row">Фон окна <input type="color" id="vkwave-bg-input"></label>
  <label class="vkwave-row">Карточки <input type="color" id="vkwave-cards-input"></label>
  <label class="vkwave-row">Акцент <input type="color" id="vkwave-accent-input"></label>
  <label class="vkwave-row">Скругления <input type="range" id="vkwave-radius-input" min="0" max="32" step="2"></label>

  <div class="vkwave-panel__section">Внешний вид</div>
    <label class="vkwave-row">Свой фон окна
    <div style="display:flex;gap:6px;">
      <button id="vkwave-bg-choose" class="vkwave-btn" style="padding:4px 8px;">Выбрать фото…</button>
      <button id="vkwave-bg-clear" class="vkwave-btn vkwave-btn--ghost" style="padding:4px 8px;" title="Очистить фон">✕</button>
    </div>
  </label>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-ambient"> Ambient-фон из обложки</label>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-vinyl"> Винил-режим обложки</label>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-accentcover"> Акцент из цвета обложки</label>
  <label class="vkwave-row">Эффект окна (Win 11)
    <select id="vkwave-material">
      <option value="none">Выключен</option>
      <option value="acrylic">Acrylic</option>
      <option value="mica">Mica</option>
    </select>
  </label>

  
  <div class="vkwave-panel__section">Звук и эквалайзер</div>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-eq-enabled"> Включить эквалайзер</label>
  <label class="vkwave-row">Пресет эквалайзера
    <select id="vkwave-eq-preset">
      <option value="flat">Обычный (Flat)</option>
      <option value="bass">Усиление басов (Bass Boost)</option>
      <option value="rock">Рок</option>
      <option value="vocal">Вокал</option>
      <option value="electronic">Электроника</option>
    </select>
  </label>
  <label class="vkwave-row">Кроссфейд (плавный переход)
    <select id="vkwave-crossfade">
      <option value="0">Выключен</option>
      <option value="1">1 секунда</option>
      <option value="2">2 секунды</option>
      <option value="3">3 секунды</option>
      <option value="5">5 секунд</option>
    </select>
  </label>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-smart-resume"> Запоминать позицию длинных треков</label>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-audio-viz"> Живая волна в тайтлбаре (спектр)</label>
  <label class="vkwave-row">
    <button id="vkwave-download-track" class="vkwave-btn">Сохранить трек (MP3)</button>
  </label>
  <label class="vkwave-row">
    <button id="vkwave-fs-btn" class="vkwave-btn">Полноэкранный режим (F11)</button>
  </label>

  <div class="vkwave-panel__section">Плеер</div>
  <label class="vkwave-row">
    <button id="vkwave-lyrics-btn" class="vkwave-btn">Текст песни (L)</button>
  </label>
  <label class="vkwave-row">
    <button id="vkwave-copy-track" class="vkwave-btn">Скопировать название трека</button>
  </label>

  <div class="vkwave-panel__section">Поведение</div>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-musiconly"> Только музыка</label>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-traycover"> Обложка в трее</label>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-hotkeys"> Хоткеи в окне (Space, Ctrl+←/→, L)</label>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-globalhotkeys"> Глобальные хоткеи (Ctrl+Alt+Space/←/→)</label>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-notifications"> Всплывающие уведомления о треке</label>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-discord"> Discord Rich Presence</label>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-autolaunch"> Запускать с Windows</label>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-startintray"> Стартовать в трее</label>

  <div class="vkwave-panel__section">Оптимизация</div>
  <label class="vkwave-row vkwave-check"><input type="checkbox" id="vkwave-blocktrackers"> Блокировать рекламу и метрики</label>
  <label class="vkwave-row">Sleep-таймер
    <select id="vkwave-sleep">
      <option value="0">Выключен</option>
      <option value="15">15 минут</option>
      <option value="30">30 минут</option>
      <option value="60">60 минут</option>
      <option value="90">90 минут</option>
    </select>
  </label>
  <div class="vkwave-row">
    <button id="vkwave-mem-btn" class="vkwave-btn">Состояние памяти</button>
  </div>
  <div id="vkwave-mem" class="vkwave-mem"></div>

  <div class="vkwave-panel__actions">
    <button id="vkwave-copy" class="vkwave-btn">Копировать тему</button>
    <button id="vkwave-paste" class="vkwave-btn">Вставить</button>
    <button id="vkwave-reset" class="vkwave-btn vkwave-btn--ghost">Сброс</button>
  </div>
  <div class="vkwave-panel__hint">Тема перекрашивает все цветовые токены VKUI. Волна в тайтлбаре отображает активность аудио. Эффект окна — экспериментальный, только Win 11.</div>
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
  const radius = Number(t.radius);
  setValue('vkwave-radius-input', Number.isFinite(radius) ? radius : 16);
  panel.querySelectorAll('[data-preset]').forEach((chip) => {
    chip.classList.toggle('vkwave-active', chip.dataset.preset === t.preset);
  });
  const setChecked = (id, value) => {
    const el = panel.querySelector(`#${id}`);
    if (el) el.checked = !!value;
  };
  
  setChecked('vkwave-eq-enabled', s.eqEnabled);
  setChecked('vkwave-smart-resume', s.smartResume);
  setChecked('vkwave-audio-viz', s.audioVisualizer);
  const eqPresetEl = panel.querySelector('#vkwave-eq-preset');
  if (eqPresetEl && s.eqPreset) eqPresetEl.value = s.eqPreset;
  const crossfadeEl = panel.querySelector('#vkwave-crossfade');
  if (crossfadeEl && typeof s.crossfadeDuration === 'number') crossfadeEl.value = String(s.crossfadeDuration);

  setChecked('vkwave-musiconly', s.musicOnly);
  setChecked('vkwave-traycover', s.trayCover);
  setChecked('vkwave-hotkeys', s.hotkeys);
  setChecked('vkwave-globalhotkeys', s.globalHotkeys);
  setChecked('vkwave-notifications', s.trackNotifications);
  setChecked('vkwave-discord', s.discordRpc);
  setChecked('vkwave-autolaunch', s.autoLaunch);
  setChecked('vkwave-startintray', s.startInTray);
  setChecked('vkwave-ambient', s.ambientCover);
  setChecked('vkwave-vinyl', s.vinylMode);
  setChecked('vkwave-accentcover', s.accentFromCover);
  setChecked('vkwave-blocktrackers', s.blockTrackers);
  setChecked('vkwave-autodaynight', s.autoDayNight);
  const material = panel.querySelector('#vkwave-material');
  if (material) material.value = s.backgroundMaterial || 'none';
  const sleep = panel.querySelector('#vkwave-sleep');
  if (sleep && !sleep.dataset.dirty) sleep.value = '0';
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
      // Если пресеты ещё не пришли из main — отправляем только имя:
      // главный процесс сам подставит цвета пресета.
      sendSettings({ theme: { ...(THEME_PRESETS[preset] || {}), preset } });
    });
  });

  const currentTheme = () =>
    (appSettings && appSettings.theme) || THEME_PRESETS.default || FALLBACK_THEME;

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
  
  bindCheckbox('vkwave-eq-enabled', 'eqEnabled');
  bindCheckbox('vkwave-smart-resume', 'smartResume');
  bindCheckbox('vkwave-audio-viz', 'audioVisualizer');

  const eqPresetSelect = panel.querySelector('#vkwave-eq-preset');
  if (eqPresetSelect) {
    eqPresetSelect.addEventListener('change', () => {
      sendSettings({ eqPreset: eqPresetSelect.value });
      applyEqSettings();
    });
  }

  const crossfadeSelect = panel.querySelector('#vkwave-crossfade');
  if (crossfadeSelect) {
    crossfadeSelect.addEventListener('change', () => {
      sendSettings({ crossfadeDuration: Number(crossfadeSelect.value) || 0 });
    });
  }

  const fsBtn = panel.querySelector('#vkwave-fs-btn');
  if (fsBtn) {
    fsBtn.addEventListener('click', () => {
      togglePanel();
      toggleCleanFullscreen(true);
    });
  }

  bindCheckbox('vkwave-musiconly', 'musicOnly');
  bindCheckbox('vkwave-traycover', 'trayCover');
  bindCheckbox('vkwave-hotkeys', 'hotkeys');
  bindCheckbox('vkwave-globalhotkeys', 'globalHotkeys');
  bindCheckbox('vkwave-notifications', 'trackNotifications');
  bindCheckbox('vkwave-discord', 'discordRpc');
  bindCheckbox('vkwave-autolaunch', 'autoLaunch');
  bindCheckbox('vkwave-startintray', 'startInTray');
  bindCheckbox('vkwave-ambient', 'ambientCover');
  bindCheckbox('vkwave-vinyl', 'vinylMode');
  bindCheckbox('vkwave-accentcover', 'accentFromCover');
  bindCheckbox('vkwave-blocktrackers', 'blockTrackers');
  bindCheckbox('vkwave-autodaynight', 'autoDayNight');

  panel.querySelector('#vkwave-material').addEventListener('change', (e) => {
    sendSettings({ backgroundMaterial: e.target.value });
  });

  
  panel.querySelector('#vkwave-copy-track').addEventListener('click', async () => {
    if (!state.title && !state.artist) return;
    const text = `${state.artist || 'VK Музыка'} — ${state.title || 'Трек'}`;
    try {
      const ok = await ipcRenderer.invoke('clipboard:write', text);
      if (ok) flashButton(panel, '#vkwave-copy-track', '✓ Скопировано');
    } catch (_) {}
  });

  
  const chooseBgBtn = panel.querySelector('#vkwave-bg-choose');
  if (chooseBgBtn) {
    chooseBgBtn.addEventListener('click', async () => {
      try {
        const dataUrl = await ipcRenderer.invoke('dialog:choose-image');
        if (dataUrl) {
          sendSettings({ customBackground: dataUrl });
          flashButton(panel, '#vkwave-bg-choose', '✓ Установлено');
        }
      } catch (_) {}
    });
  }

  const clearBgBtn = panel.querySelector('#vkwave-bg-clear');
  if (clearBgBtn) {
    clearBgBtn.addEventListener('click', () => {
      sendSettings({ customBackground: '' });
      flashButton(panel, '#vkwave-bg-choose', 'Очищено');
    });
  }

  
  const downloadTrackBtn = panel.querySelector('#vkwave-download-track');
  if (downloadTrackBtn) {
    downloadTrackBtn.addEventListener('click', async () => {
      let audioUrl = state.activeMedia ? state.activeMedia.src : null;
      if (!audioUrl) {
        // Попытка взять url из первого audio на странице
        const a = document.querySelector('audio');
        if (a) audioUrl = a.src;
      }
      if (!audioUrl) {
        flashButton(panel, '#vkwave-download-track', 'URL не найден');
        return;
      }
      flashButton(panel, '#vkwave-download-track', 'Сохранение…');
      try {
        const res = await ipcRenderer.invoke('audio:download', {
          url: audioUrl,
          artist: state.artist,
          title: state.title
        });
        if (res.success) flashButton(panel, '#vkwave-download-track', '✓ Сохранено');
        else if (res.canceled) flashButton(panel, '#vkwave-download-track', 'Отменено');
        else flashButton(panel, '#vkwave-download-track', 'Ошибка');
      } catch (_) {
        flashButton(panel, '#vkwave-download-track', 'Ошибка');
      }
    });
  }

  panel.querySelector('#vkwave-lyrics-btn').addEventListener('click', () => {
    togglePanel(); // прячем настройки, открываем текст
    toggleLyrics(true);
  });

  const sleepSelect = panel.querySelector('#vkwave-sleep');
  sleepSelect.addEventListener('change', async () => {
    const minutes = Number(sleepSelect.value) || 0;
    sleepSelect.dataset.dirty = minutes > 0 ? '1' : '';
    const hint = panel.querySelector('#vkwave-mem');
    try {
      const endsAt = await ipcRenderer.invoke('sleep:set', minutes);
      if (endsAt) {
        const time = new Date(endsAt).toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' });
        if (hint) hint.textContent = `Таймер остановки: ${time}`;
      } else if (hint) {
        hint.textContent = '';
      }
    } catch (_) {
      /* таймер недоступен */
    }
  });

  panel.querySelector('#vkwave-mem-btn').addEventListener('click', async () => {
    const box = panel.querySelector('#vkwave-mem');
    if (!box) return;
    box.textContent = 'Считаю…';
    try {
      const stats = await ipcRenderer.invoke('memory:stats');
      if (!stats) {
        box.textContent = 'Недоступно';
        return;
      }
      box.innerHTML = '';
      const totalLine = document.createElement('div');
      totalLine.textContent = `Всего: ${stats.total.toFixed(0)} МБ · аптайм ${stats.appUptimeMin} мин`;
      box.appendChild(totalLine);
      const rowsWrap = document.createElement('div');
      stats.rows
        .filter((r) => r.mb > 0)
        .sort((a, b) => b.mb - a.mb)
        .forEach((r, idx, arr) => {
          const span = document.createElement('span');
          const safeType = String(r.type || 'proc').replace(/[<>'"&]/g, '');
          span.textContent = `${safeType}: ${r.mb.toFixed(0)} МБ${idx < arr.length - 1 ? ' · ' : ''}`;
          rowsWrap.appendChild(span);
        });
      box.appendChild(rowsWrap);
    } catch (_) {
      box.textContent = 'Недоступно';
    }
  });

  panel.querySelector('#vkwave-close').addEventListener('click', () => togglePanel());

  panel.querySelector('#vkwave-copy').addEventListener('click', async () => {
    try {
      const ok = await ipcRenderer.invoke(
        'clipboard:write',
        JSON.stringify(appSettings.theme, null, 2)
      );
      if (!ok) throw new Error('clipboard write failed');
      flashButton(panel, '#vkwave-copy', 'Скопировано ✓');
    } catch (_) {
      flashButton(panel, '#vkwave-copy', 'Не удалось');
    }
  });

  panel.querySelector('#vkwave-paste').addEventListener('click', async () => {
    try {
      const text = await ipcRenderer.invoke('clipboard:read');
      const parsed = JSON.parse(text);
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

  
  const animeChipEl = panel.querySelector('#vkwave-chip-anime');
  if (animeChipEl) {
    animeChipEl.style.display = (s.secretAnimeUnlocked || (t && t.preset === 'anime')) ? 'inline-block' : 'none';
  }

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
    applySettingsPayload(await ipcRenderer.invoke('settings:set', patch));
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


let cheatBuffer = '';
const CHEAT_WORD = 'wvunison';

function checkCheatCode(key) {
  if (!key || typeof key !== 'string') return;
  const lower = key.toLowerCase();
  const latin = russianToEnglish[lower] || lower;
  cheatBuffer += latin;
  if (cheatBuffer.length > 20) cheatBuffer = cheatBuffer.slice(-20);
  if (cheatBuffer.endsWith(CHEAT_WORD)) {
    cheatBuffer = '';
    unlockSecretAnimeTheme();
  }
}

function unlockSecretAnimeTheme() {
  const animeTheme = (THEME_PRESETS && THEME_PRESETS.anime) || {
    background: '#120d1c', cards: '#1d152e', accent: '#ff4db8', radius: 18
  };
  sendSettings({
    secretAnimeUnlocked: true,
    theme: { ...animeTheme, preset: 'anime' }
  });
  showSecretUnlockBanner();
}

function setupHotkeys() {
  window.addEventListener(
    'keydown',
    (event) => {
      if (!appSettings || !appSettings.hotkeys) return;
      if (isEditableTarget(event.target)) return; // не мешаем печатать в поиске

      // Проверка комбинаций разблокировки (Ctrl+Shift+U или Ctrl+Alt+U)
      if (
        (event.ctrlKey && event.shiftKey && (event.code === 'KeyU' || event.key.toLowerCase() === 'u' || event.key.toLowerCase() === 'г')) ||
        (event.ctrlKey && event.altKey && (event.code === 'KeyU' || event.key.toLowerCase() === 'u' || event.key.toLowerCase() === 'г'))
      ) {
        event.preventDefault();
        event.stopPropagation();
        unlockSecretAnimeTheme();
        return;
      }

      // Проверка побуквенного ввода
      if (!event.ctrlKey && !event.altKey && !event.metaKey && event.key && event.key.length === 1) {
        checkCheatCode(event.key);
      }


      
      if (event.code === 'F11') {
        event.preventDefault();
        toggleCleanFullscreen();
      } else if (event.code === 'Escape' && document.body.classList.contains('vkwave-clean-fullscreen')) {
        event.preventDefault();
        toggleCleanFullscreen(false);
      }

      if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === 'ArrowRight') {
        event.preventDefault();
        pressControl('next');
      } else if (event.ctrlKey && !event.shiftKey && !event.altKey && event.code === 'ArrowLeft') {
        event.preventDefault();
        pressControl('previous');
      } else if (!event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'Space') {
        event.preventDefault();
        handleTransportAction(state.isPlaying ? 'pause' : 'play');
      } else if (!event.ctrlKey && !event.altKey && !event.metaKey && event.code === 'KeyL') {
        // L — панель текста песни (караоке).
        event.preventDefault();
        toggleLyrics();
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
  ipcRenderer.on('settings-updated', (_event, s) => applySettingsPayload(s));
  ipcRenderer
    .invoke('settings:get')
    .then((s) => applySettingsPayload(s))
    .catch(() => {});

  // Обложка из main: dataURL для ambient + средний цвет для акцента.
  ipcRenderer.on('cover-image', (_event, dataUrl) => onCoverImage(dataUrl));
  ipcRenderer.on('cover-accent', (_event, hex) => {
    state.coverAccent = hex || null;
    if (appSettings) applyTheme(appSettings);
  });

  // Панель текста песни из трея.
  ipcRenderer.on('lyrics-toggle', () => toggleLyrics());

  // Sleep-таймер сработал — сообщаем в панели и сбрасываем селектор.
  ipcRenderer.on('sleep-fired', () => {
    const box = document.querySelector('#vkwave-mem');
    if (box) box.textContent = 'Sleep-таймер: воспроизведение остановлено';
    const sleep = document.querySelector('#vkwave-sleep');
    if (sleep) {
      sleep.value = '0';
      sleep.dataset.dirty = '';
    }
  });

  buildPanel();
  setupHotkeys();
  syncEffectClasses();

  runExtraction();
  setInterval(() => {
    runExtraction();
    syncApState(); // время плеера ВК: караоке и живой прогресс в Discord
  }, POLL_INTERVAL_MS);
  // Прогресс в Discord анимирует сам клиент по start/end timestamps —
  // частый SET_ACTIVITY не нужен. Долгий keepalive живёт в maybeSend().
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', init, { once: true });
} else {
  init();
}
