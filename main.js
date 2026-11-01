'use strict';

/**
 * VK Wave — главный процесс Electron.
 *
 * Окно-обёртка над https://vk.com/music с «родной» тёмной рамкой Windows,
 * сохранением сессии (persist:vkwave), сворачиванием в системный трей
 * и мостом перехватчика плеера к Discord Rich Presence.
 */

const {
  app,
  BrowserWindow,
  Tray,
  Menu,
  nativeImage,
  ipcMain,
  shell,
  session,
  net
} = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
// Node-овский fetch (undici) в main лезет через IPv6 и умирает там, где его нет
// (fetch failed на lrclib.net при рабочем IPv4). Отныне IPv4 — первый.
require('dns').setDefaultResultOrder('ipv4first');

const { DiscordPresence } = require('./discord');

// VK душит нестандартные клиенты: строка Electron/x.y в User-Agent даёт
// урезанные сценарии входа и чаще включает флуд-контроль («Слишком много
// попыток, попробуйте позже»). Маскируемся под обычный Chrome той же версии.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s*Electron\/[\d.]+/i, '')
  .replace(/\s*VK Wave\/[\d.]+/i, '')
  .trim();

/* ------------------------------- Настройки ------------------------------- */

const DEFAULT_SETTINGS = {
  musicOnly: true,   // «Только музыка»: редирект на /music + скрытие лишнего ВК
  hotkeys: true,     // Space — пауза, Ctrl+←/→ — треки, L — текст песни
  autoLaunch: false, // запускать с Windows
  startInTray: false, // стартовать свёрнутым в трей
  trayCover: true,   // иконка трея = обложка текущего трека
  blockTrackers: true, // резать рекламу/метрики ВК на подлёте
  ambientCover: true,  // размытая обложка фоном окна
  vinylMode: false,    // обложка-винил: вращается, пока играет
  accentFromCover: false, // акцент темы подмешивается из цвета обложки
  autoDayNight: false, // авто-тема: день light / ночь midnight
  backgroundMaterial: 'none', // none | mica | acrylic (Win11)
  theme: {
    preset: 'default', // default | oled | midnight | light | sakura | emerald | lavender | amber | cyberpunk | ocean | graphite | coffee | neon | halloween | custom
    background: '#141414',
    cards: '#1d1d22',
    accent: '#0077ff',
    radius: 16
  }
};

let settings = { ...DEFAULT_SETTINGS, theme: { ...DEFAULT_SETTINGS.theme } };

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = {
      ...DEFAULT_SETTINGS,
      ...raw,
      theme: { ...DEFAULT_SETTINGS.theme, ...(raw && raw.theme ? raw.theme : {}) }
    };
  } catch (_) {
    settings = { ...DEFAULT_SETTINGS, theme: { ...DEFAULT_SETTINGS.theme } };
  }
}

function saveSettings() {
  try {
    fs.writeFileSync(settingsFile(), JSON.stringify(settings, null, 2), 'utf8');
  } catch (_) {
    /* не записали — настройки не сохранятся до следующего раза */
  }
}

function mergeSettings(current, patch) {
  if (!patch || typeof patch !== 'object') return current;
  const next = { ...current, ...patch };
  next.theme = { ...current.theme, ...(patch.theme || {}) };
  return next;
}

function isLightColor(hexColor) {
  const match = /^#?([0-9a-f]{6})$/i.exec(hexColor || '');
  if (!match) return false;
  const int = parseInt(match[1], 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

function applyAutoLaunch() {
  try {
    app.setLoginItemSettings({ openAtLogin: !!settings.autoLaunch, args: ['--hidden'] });
  } catch (_) {
    /* недоступно в некоторых portable-сценариях */
  }
}

const VK_MUSIC_URL = 'https://vk.com/music';
const WINDOW_TITLE = 'VK Wave';
const TITLEBAR_HEIGHT = 34;

/** Хосты, которым разрешена навигация внутри окна (остальное — во внешний браузер). */
const VK_HOST_PATTERN = /(^|\.)(vk\.com|vk\.ru|userapi\.com|mycdn\.me|vk-cdn\.net|vkuser\.net)$/i;

let mainWindow = null;
let tray = null;
let discord = null;
let isQuitting = false;
let lastTrack = null;
let defaultTrayIcon = null;           // родная иконка приложения для трея
const trayCoverCache = new Map();     // url обложки → nativeImage 16×16

/* ---------------------------- Вспомогательное ---------------------------- */

function isVkUrl(url) {
  try {
    return VK_HOST_PATTERN.test(new URL(url).hostname);
  } catch (_) {
    return false;
  }
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function sendPlayerCommand(command) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('player-command', command);
  }
}

/** Панель настроек ходит по своему каналу — это не плеерная команда. */
function sendSettingsToggle() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings-toggle');
  }
}

/** Панель текста песни (караоке) — тоже отдельный канал. */
function sendLyricsToggle() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('lyrics-toggle');
  }
}

/* --------------------------- Пресеты тем (main) --------------------------- */
/* Дубликат THEME_PRESETS из preload: нужен для авто день/ночь в главном процессе. */

const THEME_PRESETS = {
  default: { background: '#141414', cards: '#1d1d22', accent: '#0077ff', radius: 16 },
  oled: { background: '#000000', cards: '#101014', accent: '#0077ff', radius: 14 },
  midnight: { background: '#0e1322', cards: '#172033', accent: '#5b8cff', radius: 18 },
  light: { background: '#edeef0', cards: '#ffffff', accent: '#0077ff', radius: 16 },
  sakura: { background: '#201622', cards: '#2b1f30', accent: '#ff7eb6', radius: 20 },
  emerald: { background: '#0d1a13', cards: '#142520', accent: '#2ecc8f', radius: 16 },
  lavender: { background: '#171225', cards: '#221b33', accent: '#a78bfa', radius: 18 },
  amber: { background: '#1f1810', cards: '#2b2318', accent: '#ffb14a', radius: 16 },
  cyberpunk: { background: '#0b0f14', cards: '#131a24', accent: '#00ffd5', radius: 12 },
  ocean: { background: '#0b1b2a', cards: '#12283d', accent: '#38bdf8', radius: 18 },
  graphite: { background: '#161719', cards: '#1f2124', accent: '#8e9aab', radius: 10 },
  coffee: { background: '#191210', cards: '#241a15', accent: '#c98a5e', radius: 16 },
  neon: { background: '#0d0a14', cards: '#161022', accent: '#e34fd0', radius: 14 },
  halloween: { background: '#150d08', cards: '#221510', accent: '#ff7a1a', radius: 14 }
};

/* ------------------------- Обложка: данные и цвет ------------------------- */

const coverDataCache = new Map(); // url → dataURL (для ambient-фона)

/** Скачивает обложку (с браузерным UA — CDN ВК режет прочее) и возвращает dataURL. */
async function fetchCoverDataUrl(url) {
  if (coverDataCache.has(url)) return coverDataCache.get(url);
  const response = await fetch(url, {
    headers: { 'User-Agent': app.userAgentFallback, Referer: 'https://vk.com/' }
  });
  if (!response.ok) return null;
  const contentType = response.headers.get('content-type') || '';
  if (!contentType.startsWith('image/')) return null;
  const buffer = Buffer.from(await response.arrayBuffer());
  const image = nativeImage.createFromBuffer(buffer);
  if (image.isEmpty()) return null;
  const dataUrl = `data:${contentType};base64,${buffer.toString('base64')}`;
  coverDataCache.set(url, dataUrl);
  if (coverDataCache.size > 12) {
    coverDataCache.delete(coverDataCache.keys().next().value);
  }
  return dataUrl;
}

/** Средний/доминирующий цвет обложки: 8×8 → самый насыщенный живой пиксель. */
function extractCoverAccent(url) {
  return fetchCoverDataUrl(url)
    .then((dataUrl) => {
      if (!dataUrl) return null;
      const image = nativeImage.createFromDataURL(dataUrl).resize({ width: 8, height: 8 });
      const size = image.getSize();
      if (!size.width || !size.height) return null;
      const bitmap = image.getBitmap(); // BGRA
      let best = null;
      let bestScore = -1;
      let sr = 0;
      let sg = 0;
      let sb = 0;
      let count = 0;
      for (let i = 0; i + 3 < bitmap.length; i += 4) {
        const r = bitmap[i + 2];
        const g = bitmap[i + 1];
        const b = bitmap[i];
        const max = Math.max(r, g, b);
        const min = Math.min(r, g, b);
        const sat = max === 0 ? 0 : (max - min) / max;
        const light = max / 255;
        sr += r; sg += g; sb += b; count += 1;
        // живой цвет: заметно насыщенный, не вырванный в чёрный/белый
        const score = sat * (light > 0.25 && light < 0.85 ? 1 : 0.2);
        if (score > bestScore) {
          bestScore = score;
          best = [r, g, b];
        }
      }
      // доминирующий слишком серый? берём средний цвет
      if (!best || bestScore < 0.18) {
        if (!count) return null;
        best = [Math.round(sr / count), Math.round(sg / count), Math.round(sb / count)];
      }
      return `#${best.map((c) => c.toString(16).padStart(2, '0')).join('')}`;
    })
    .catch(() => null);
}

/* ------------------------------ Лирикс (LRCLIB) --------------------------- */

const lyricsCache = new Map(); // 'artist|title|dur' → { synced, plain }

/** Чистим мусор из названий, который сбивает поиск LRCLIB. */
function cleanLyricsQuery(s) {
  return String(s || '')
    .replace(/\s*\((?:feat|ft|with)[^)]*\)/gi, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s*[-–—]\s*(?:remix|cover|live|acoustic|radio edit).*$/i, '')
    .trim();
}

/* Транспорт к LRCLIB. Прямой ход из Chromium/Node-стека на части сетей РФ
 * режется DPI по SNI (ERR_CONNECTION_RESET у Cloudflare), а системный curl
 * проходит — поэтому сначала curl.exe (есть в Windows 10+), затем net.fetch.
 * На сетях, где всё открыто, оба пути работают, разница незаметна. */

function lrclibJsonViaCurl(url) {
  return new Promise((resolve, reject) => {
    execFile(
      'curl',
      ['-s', '--max-time', '9', '-H', `User-Agent: VK Wave/${app.getVersion()}`, url],
      { windowsHide: true, timeout: 10000, maxBuffer: 4 * 1024 * 1024 },
      (error, stdout) => {
        if (error) return reject(error);
        try {
          resolve(JSON.parse(stdout));
        } catch (_) {
          reject(new Error('curl: некорректный JSON'));
        }
      }
    );
  });
}

async function lrclibJsonViaNet(url) {
  const response = await net.fetch(url, {
    headers: { 'User-Agent': `VK Wave/${app.getVersion()} (github.com/mitherly/VK-Wave)` }
  });
  if (!response.ok) throw new Error(`lrclib http ${response.status}`);
  return response.json();
}

function lrclibJson(pathWithQuery) {
  const url = `https://lrclib.net${pathWithQuery}`;
  return lrclibJsonViaCurl(url).catch(() => lrclibJsonViaNet(url));
}

/** /api/get → {synced, plain} или null (включая JSON-ошибки 404). */
async function lrclibLookup(pathWithQuery) {
  try {
    const data = await lrclibJson(pathWithQuery);
    if (data && (data.syncedLyrics || data.plainLyrics)) {
      return { synced: data.syncedLyrics || null, plain: data.plainLyrics || null };
    }
  } catch (_) {
    /* 404/сеть — уйдём в search */
  }
  return null;
}

/** /api/search → массив вариантов. */
async function lrclibList(pathWithQuery) {
  try {
    const data = await lrclibJson(pathWithQuery);
    return Array.isArray(data) ? data : [];
  } catch (_) {
    return [];
  }
}

async function fetchLyrics({ artist, title, duration }) {
  const key = `${artist}|${title}|${Math.round(duration || 0)}`;
  if (lyricsCache.has(key)) return lyricsCache.get(key);
  console.log(`[VK Wave · Lyrics] запрос: "${artist}" — "${title}" (${Math.round(duration)}с)`);

  try {
    const qArtist = cleanLyricsQuery(artist);
    const qTitle = cleanLyricsQuery(title);
    // Точный запрос: artist+title+duration — LRCLIB отдаёт лучший вариант.
    let result = await lrclibLookup(
      `/api/get?artist_name=${encodeURIComponent(qArtist)}` +
      `&track_name=${encodeURIComponent(qTitle)}` +
      (duration > 0 ? `&duration=${Math.round(duration)}` : '')
    );
    // Фолбэк: поиск без duration — берём ближайший по длительности вариант.
    if (!result) {
      const list = await lrclibList(
        `/api/search?track_name=${encodeURIComponent(qTitle)}` +
        `&artist_name=${encodeURIComponent(qArtist)}`
      );
      if (Array.isArray(list) && list.length) {
        let pick = list[0];
        if (duration > 0) {
          let bestDelta = Infinity;
          for (const item of list) {
            const delta = Math.abs((item.duration || 0) - duration);
            if (delta < bestDelta) {
              bestDelta = delta;
              pick = item;
            }
          }
        }
        if (pick && (pick.syncedLyrics || pick.plainLyrics)) {
          result = { synced: pick.syncedLyrics || null, plain: pick.plainLyrics || null };
        }
      }
    }
    lyricsCache.set(key, result);
    if (lyricsCache.size > 60) lyricsCache.delete(lyricsCache.keys().next().value);
    console.log(
      `[VK Wave · Lyrics] ${result ? (result.synced ? 'синхронизированный текст найден' : 'только простой текст') : 'текст не найден'}`
    );
    return result;
  } catch (error) {
    console.log('[VK Wave · Lyrics] ошибка:', error && error.message);
    return null;
  }
}

/* ------------------------------- Sleep-таймер ------------------------------ */

let sleepTimer = null;

function setSleepTimer(minutes) {
  if (sleepTimer) {
    clearTimeout(sleepTimer);
    sleepTimer = null;
  }
  if (!minutes || minutes <= 0) return null;
  sleepTimer = setTimeout(() => {
    sleepTimer = null;
    sendPlayerCommand('pause');
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('sleep-fired');
    }
  }, minutes * 60 * 1000);
  return Date.now() + minutes * 60 * 1000;
}

/* ---------------------- Авто-тема день/ночь (60 сек) ----------------------- */

function desiredDayNightPreset() {
  const hour = new Date().getHours();
  return hour >= 21 || hour < 7 ? 'midnight' : 'light';
}

function applyAutoDayNight() {
  if (!settings.autoDayNight) return;
  const desired = desiredDayNightPreset();
  if (settings.theme.preset === desired) return;
  // Перекрашиваем только если сейчас стоит одна из парных тем — кастом не трогаем.
  if (!['light', 'midnight'].includes(settings.theme.preset)) return;
  settings.theme = { ...THEME_PRESETS[desired], preset: desired };
  saveSettings();
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('settings-updated', settings);
  }
}

/* ----------------------- Блок рекламы/метрик ВК/сети ----------------------- */

const TRACKER_BLOCKLIST = [
  '*://*.top-fwz1.mail.ru/*',      // счётчик Рейтинг Mail.ru
  '*://*.ad.mail.ru/*',            // баннерная сеть Mail.ru
  '*://*.mradx.net/*',             // медиа-реклама VK Ads
  '*://*.an.yandex.ru/*',          // рекламная сеть Яндекса
  '*://*.mc.yandex.ru/*',          // метрика
  '*://*.google-analytics.com/*',
  '*://*.googletagmanager.com/*',
  '*://*.doubleclick.net/*',
  '*://*.googlesyndication.com/*'
];

function installTrackerBlocklist(targetSession) {
  const filter = { urls: TRACKER_BLOCKLIST };
  targetSession.webRequest.onBeforeRequest(filter, (details, callback) => {
    // Флаг проверяем в момент запроса — тумблер в панели работает без перезапуска.
    callback({ cancel: !!settings.blockTrackers });
  });
}


function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 600,
    show: false,
    title: WINDOW_TITLE,
    backgroundColor: '#141414',
    // Mica/Acrylic на старте (Win11); дальше рулит applyBackgroundMaterial.
    ...(process.platform === 'win32' &&
      settings.backgroundMaterial &&
      settings.backgroundMaterial !== 'none'
      ? { backgroundMaterial: settings.backgroundMaterial }
      : {}),
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'logo.png'),
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
    // Overlay-кнопки окна: Windows и Linux. На macOS — нативные traffic lights.
    ...(process.platform !== 'darwin'
      ? {
          titleBarOverlay: {
            color: '#141414',
            symbolColor: '#ffffff',
            height: TITLEBAR_HEIGHT
          }
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition: 'persist:vkwave',
      contextIsolation: true,
      nodeIntegration: false,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false
    }
  });

  const startHidden = process.argv.includes('--hidden') || settings.startInTray;
  mainWindow.once('ready-to-show', () => {
    if (!startHidden) mainWindow.show();
  });

  // Крестик сворачивает окно в трей, а не закрывает приложение.
  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  mainWindow.webContents.on('did-finish-load', injectTitleBarStyles);

  // Переходы на сторонние сайты открываем в системном браузере.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isVkUrl(url)) return;
    event.preventDefault();
    shell.openExternal(url);
  });

  // Режим «Только музыка»: любые навигации вне музыкального раздела — назад в плеер.
  mainWindow.webContents.on('did-navigate', (_event, url) => enforceMusicOnly(url));
  mainWindow.webContents.on('did-navigate-in-page', (_event, url) => enforceMusicOnly(url));

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isVkUrl(url)) {
      // Внутренние ссылки и OAuth-попапы авторизации VK — в дочернем окне
      // с той же сессией (partition наследуется от открывшего окна).
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          autoHideMenuBar: true,
          backgroundColor: '#141414'
        }
      };
    }
    shell.openExternal(url);
    return { action: 'deny' };
  });

  // F12 / Ctrl+Shift+I — DevTools, Ctrl+R — перезагрузить страницу.
  mainWindow.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    const key = input.key.toLowerCase();
    const ctrl = input.control || input.meta;
    if (input.key === 'F12' || (ctrl && input.shift && key === 'i')) {
      mainWindow.webContents.toggleDevTools();
      event.preventDefault();
    } else if (ctrl && input.shift && key === 't') {
      // Ctrl+Shift+T — панель настроек VK Wave.
      sendSettingsToggle();
      event.preventDefault();
    } else if (ctrl && !input.shift && key === 'r') {
      mainWindow.webContents.reload();
      event.preventDefault();
    }
  });

  mainWindow.loadURL(VK_MUSIC_URL);
}

/**
 * Полоса-«заголовок» 34px: сплошной фон #141414 под кнопками управления
 * окном и область перетаскивания окна поверх шапки VK.
 */
function injectTitleBarStyles() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  const css = `
    body {
      padding-top: ${TITLEBAR_HEIGHT}px !important;
      box-sizing: border-box !important;
      background: var(--vkwave-bg, #141414) !important;
    }
    body::before {
      content: '' !important;
      display: block !important;
      position: fixed !important;
      top: 0 !important;
      left: 0 !important;
      width: 100% !important;
      height: ${TITLEBAR_HEIGHT}px !important;
      background: var(--vkwave-bg, #141414) !important;
      opacity: 1 !important;
      z-index: 2147483647 !important;
      -webkit-app-region: drag !important;
    }
    /* Шапка ВК с лого и аккаунтом прячется целиком — над полосой остаётся
       только системные кнопки окна. Кандидаты: то, чего нет в текущем DOM,
       просто не срабатывает. */
    body > header,
    #page_header,
    [id*="page_header"],
    [class*="topProfileMenu"]
    { display: none !important; }
  `;
  mainWindow.webContents.insertCSS(css, { cssOrigin: 'author' }).catch(() => {});
  applyMusicOnly();
}

/* -------------------- Режим «Только музыка» и темы ----------------------- */

let redirectingToMusic = false;
let musicOnlyCssKey = null;

/** Скрываем всё, что не относится к музыке (селекторы-кандидаты; то, чего
 * нет в текущем DOM ВК, просто не срабатывает). */
const MUSIC_ONLY_CSS = `
  #side_bar, #side_bar_inner, #left_menu, #left_nav,
  [class*="leftMenu"], [class*="LeftMenu"], [id*="left_menu"],
  [class*="AppPromo"], [class*="appPromo"], [class*="MobilePromo"],
  [class*="promoBanner"], [class*="PromoBanner"],
  [class*="promo" i], [class*="subscription" i],
  #footer, .footer_bar
  { display: none !important; }
`;

function enforceMusicOnly(url) {
  if (!settings.musicOnly || redirectingToMusic) return;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return;
  }
  // Логин/OAuth/внешние хосты не трогаем — иначе сломаем авторизацию.
  if (!/(^|\.)vk\.(com|ru)$/i.test(parsed.hostname)) return;
  // Музыкальный раздел (включая альбомы и страницы артистов) — можно.
  if (/^\/(music|artist|audio)/i.test(parsed.pathname)) return;
  redirectingToMusic = true;
  mainWindow.webContents
    .loadURL(VK_MUSIC_URL)
    .catch(() => {})
    .then(() => {
      redirectingToMusic = false;
    });
}

function applyMusicOnly() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (settings.musicOnly && !musicOnlyCssKey) {
    mainWindow.webContents
      .insertCSS(MUSIC_ONLY_CSS, { cssOrigin: 'user' })
      .then((key) => {
        musicOnlyCssKey = key;
      })
      .catch(() => {});
  } else if (!settings.musicOnly && musicOnlyCssKey) {
    mainWindow.webContents.removeInsertedCSS(musicOnlyCssKey).catch(() => {});
    musicOnlyCssKey = null;
  }
}

/** Применяет main-часть настроек: цвет рамки, mica/acrylic, musicOnly, автозапуск. */
function applySettingsToWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  try {
    mainWindow.setTitleBarOverlay({
      color: settings.theme.background || '#141414',
      symbolColor: isLightColor(settings.theme.background) ? '#1c1c1c' : '#ffffff'
    });
  } catch (_) {
    /* titleBarOverlay доступен не на всех платформах */
  }
  applyBackgroundMaterial();
  if (!settings.trayCover) resetTrayIcon();
  applyMusicOnly();
  applyAutoLaunch();
}

/** Mica/Acrylic — только Windows 11 (build 22000+). Экспериментально:
 * виден там, где фон страницы полупрозрачен (preload подмешивает альфу). */
function applyBackgroundMaterial() {
  if (process.platform !== 'win32') return;
  const material = settings.backgroundMaterial;
  try {
    mainWindow.setBackgroundMaterial(material === 'none' ? 'auto' : material);
  } catch (_) {
    /* старая сборка Windows или материал недоступен */
  }
}

/* --------------------------------- Трей --------------------------------- */

function createTray() {
  const icon = nativeImage
    .createFromPath(path.join(__dirname, 'assets', 'logo.png'))
    .resize({ width: 16, height: 16 });
  defaultTrayIcon = icon;
  tray = new Tray(icon);
  tray.setToolTip(WINDOW_TITLE);
  tray.on('click', () => showMainWindow());
  updateTray();
}

/** Иконка трея = обложка текущего трека (если включено в настройках). */
async function updateTrayIcon(track) {
  if (!tray) return;
  if (!settings.trayCover || !track || !track.coverUrl) return;
  const url = track.coverUrl;
  if (trayCoverCache.has(url)) {
    tray.setImage(trayCoverCache.get(url));
    return;
  }
  try {
    const response = await fetch(url, {
      headers: {
        // CDN ВК режет запросы без браузерного User-Agent.
        'User-Agent': app.userAgentFallback,
        Referer: 'https://vk.com/'
      }
    });
    if (!response.ok) return;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return;
    const image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()));
    if (image.isEmpty()) return;
    const trayImage = image.resize({ width: 16, height: 16 });
    trayCoverCache.set(url, trayImage);
    if (trayCoverCache.size > 30) {
      const oldest = trayCoverCache.keys().next().value;
      trayCoverCache.delete(oldest);
    }
    tray.setImage(trayImage);
  } catch (_) {
    /* обложка не скачалась — оставляем прошлую иконку */
  }
}

function resetTrayIcon() {
  if (tray && defaultTrayIcon) tray.setImage(defaultTrayIcon);
}

function updateTray() {
  if (!tray) return;

  const playing = !!(lastTrack && lastTrack.isPlaying);
  if (lastTrack && lastTrack.title) {
    tray.setToolTip(`VK Wave — ${lastTrack.artist} — ${lastTrack.title}`);
  } else {
    tray.setToolTip(`${WINDOW_TITLE} — плеер не активен`);
  }

  tray.setContextMenu(
    Menu.buildFromTemplate([
      {
        label: playing ? 'Пауза' : 'Слушать',
        click: () => sendPlayerCommand('play-pause')
      },
      {
        label: 'Следующий трек',
        click: () => sendPlayerCommand('next')
      },
      {
        label: 'Предыдущий трек',
        click: () => sendPlayerCommand('previous')
      },
      { type: 'separator' },
      { label: 'Текст песни', click: () => sendLyricsToggle() },
      { label: 'Настройки', click: () => sendSettingsToggle() },
      { label: 'Развернуть VK Wave', click: showMainWindow },
      { type: 'separator' },
      {
        label: 'Выход',
        click: () => {
          isQuitting = true;
          app.quit();
        }
      }
    ])
  );
}

/* ---------------------------- Автообновления ------------------------------ */
/* electron-updater в dev-режиме не работает — включаем только в собранном app.
   Тихо проверяем GitHub Releases при старте и раз в 6 часов; ставим при выходе. */

const SIX_HOURS_MS = 6 * 60 * 60 * 1000;

function setupAutoUpdater() {
  if (!app.isPackaged) return;
  try {
    const { autoUpdater } = require('electron-updater');
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.logger = null; // без логов в консоль продакшена

    const check = () => {
      autoUpdater.checkForUpdates().catch(() => {});
    };

    check();
    setInterval(check, SIX_HOURS_MS);
  } catch (_) {
    /* electron-updater недоступен — обновления вручную с GitHub */
  }
}

/* ------------------------------- Запуск app ------------------------------ */

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(() => {
    app.setAppUserModelId('ru.vkwave.desktop');

    loadSettings();
    applyAutoLaunch();
    applyAutoDayNight(); // старт в правильной половине суток

    // Разрешаем только нужные странице разрешения (медиа, фулскрин, уведомления).
    const vkSession = session.fromPartition('persist:vkwave');
    vkSession.setPermissionRequestHandler((_wc, permission, callback) => {
      const allowed = [
        'media',
        'fullscreen',
        'notifications',
        'pointerLock',
        'clipboard-sanitized-write'
      ];
      callback(allowed.includes(permission));
    });

    installTrackerBlocklist(vkSession);

    // Сводка о треке из preload-перехватчика.
    ipcMain.on('track-update', (_event, track) => {
      if (!track || typeof track !== 'object' || (!track.title && !track.artist)) return;
      lastTrack = track;
      // Ошибка Discord не должна ронять главный процесс — только лог.
      if (discord) {
        try {
          discord.update(track);
        } catch (_) {
          /* уже залогировано внутри */
        }
      }
      updateTray();
      updateTrayIcon(track).catch(() => {});

      // Обложка → ambient-фон и акцент: отдаём рендеру при смене обложки.
      if (track.coverUrl && (settings.ambientCover || settings.accentFromCover)) {
        fetchCoverDataUrl(track.coverUrl)
          .then((dataUrl) => {
            if (!dataUrl || !mainWindow || mainWindow.isDestroyed()) return;
            if (settings.ambientCover) {
              mainWindow.webContents.send('cover-image', dataUrl);
            }
            if (settings.accentFromCover) {
              return extractCoverAccent(track.coverUrl).then((hex) => {
                if (hex && mainWindow && !mainWindow.isDestroyed()) {
                  mainWindow.webContents.send('cover-accent', hex);
                }
              });
            }
            return null;
          })
          .catch(() => {});
      }
    });

    // Лирикс: прокси к LRCLIB из main — CSP и CORS страницы не мешают.
    ipcMain.handle('lyrics:get', (_event, query) => {
      if (!query || typeof query !== 'object') return null;
      const artist = String(query.artist || '').trim();
      const title = String(query.title || '').trim();
      if (!artist || !title) return null;
      const duration = Number(query.duration) || 0;
      return fetchLyrics({ artist, title, duration });
    });

    // Диагностика памяти: честные цифры по процессам для панели настроек.
    ipcMain.handle('memory:stats', () => {
      try {
        const metrics = app.getAppMetrics();
        const rows = metrics.map((m) => ({
          type: m.type || 'process',
          pid: m.pid,
          mb: m.memory ? m.memory.workingSetSize / 1024 : 0
        }));
        return {
          rows,
          total: rows.reduce((sum, r) => sum + r.mb, 0),
          appUptimeMin: Math.round(process.uptime() / 60)
        };
      } catch (_) {
        return null;
      }
    });

    // Sleep-таймер: пауза через N минут. Возвращает метку окончания.
    ipcMain.handle('sleep:set', (_event, minutes) => setSleepTimer(Number(minutes) || 0));

    // Авто-тема день/ночь: проверка каждый час в половине случаев выстрелит в момент.
    setInterval(applyAutoDayNight, 60 * 1000);

    // Настройки из панели VK Wave (Ctrl+Shift+T / трей).
    ipcMain.handle('settings:get', () => settings);

    ipcMain.handle('settings:set', (_event, patch) => {
      settings = mergeSettings(settings, patch);
      saveSettings();
      applySettingsToWindow();
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) win.webContents.send('settings-updated', settings);
      });
      // Ambient включили посреди сессии — сразу отправляем текущую обложку,
      // не дожидаясь следующего трека.
      if (settings.ambientCover && lastTrack && lastTrack.coverUrl) {
        fetchCoverDataUrl(lastTrack.coverUrl)
          .then((dataUrl) => {
            if (dataUrl && mainWindow && !mainWindow.isDestroyed()) {
              mainWindow.webContents.send('cover-image', dataUrl);
            }
          })
          .catch(() => {});
      }
      return settings;
    });

    createWindow();
    createTray();

    discord = new DiscordPresence();
    discord.start();

    setupAutoUpdater();

    app.on('activate', () => showMainWindow());
  });

  app.on('window-all-closed', () => {
    if (isQuitting) app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    if (discord) {
      discord.destroy();
      discord = null;
    }
  });
}
