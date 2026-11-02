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
  net,
  clipboard,
  powerSaveBlocker,
  Notification,
  globalShortcut,
  dialog
} = require('electron');
const path = require('path');
const fs = require('fs');
const { execFile } = require('child_process');
// Node-овский fetch (undici) в main лезет через IPv6 и умирает там, где его нет
// (fetch failed на lrclib.net при рабочем IPv4). Отныне IPv4 — первый.
require('dns').setDefaultResultOrder('ipv4first');

const { DiscordPresence } = require('./discord');
const { THEME_PRESETS, isLightColor } = require('./shared/theme');
const { cleanLyricsQuery } = require('./shared/lyrics');
const {
  defaultSettings,
  normalizeSettings,
  mergeSettings
} = require('./shared/settings');

// VK душит нестандартные клиенты: строка Electron/x.y в User-Agent даёт
// урезанные сценарии входа и чаще включает флуд-контроль («Слишком много
// попыток, попробуйте позже»). Маскируемся под обычный Chrome той же версии.
app.userAgentFallback = app.userAgentFallback
  .replace(/\s*Electron\/[\d.]+/i, '')
  .replace(/\s*VK Wave\/[\d.]+/i, '')
  .trim();

/* ------------------------------- Настройки ------------------------------- */

let settings = defaultSettings();
// Что уже применено к окну — чтобы перетаскивание цвета не дёргало реестр
// автозапуска и не пересоздавало материалы на каждый пиксель.
let appliedMainSettings = null;

function settingsFile() {
  return path.join(app.getPath('userData'), 'settings.json');
}

function loadSettings() {
  try {
    const raw = JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
    settings = normalizeSettings(raw);
  } catch (_) {
    settings = defaultSettings();
  }
}

/**
 * Атомарная запись: сначала во временный файл, потом rename. Так выключение
 * питания посреди записи не оставляет полупустой settings.json.
 */
function saveSettings() {
  const file = settingsFile();
  const tmp = `${file}.tmp`;
  const json = JSON.stringify(settings, null, 2);
  try {
    fs.writeFileSync(tmp, json, 'utf8');
    fs.renameSync(tmp, file);
  } catch (_) {
    try {
      fs.unlinkSync(tmp);
    } catch (_) {
      /* временный файл мог не создаться */
    }
    // rename может упасть на Windows из-за антивируса/открытого файла —
    // не теряем настройки совсем.
    try {
      fs.writeFileSync(file, json, 'utf8');
    } catch (_) {
      /* не записали — настройки не сохранятся до следующего раза */
    }
  }
}

let settingsSaveTimer = null;

/** Не пишем диск на каждый пиксель перетаскивания цвета. */
function scheduleSaveSettings() {
  if (settingsSaveTimer) clearTimeout(settingsSaveTimer);
  settingsSaveTimer = setTimeout(() => {
    settingsSaveTimer = null;
    saveSettings();
  }, 250);
}

function flushSettingsSave() {
  if (!settingsSaveTimer) return;
  clearTimeout(settingsSaveTimer);
  settingsSaveTimer = null;
  saveSettings();
}

/** Настройки + пресеты для renderer (sandbox не может require'ить shared/theme). */
function settingsPayload() {
  return { ...settings, presets: THEME_PRESETS };
}

function broadcastSettings() {
  const payload = settingsPayload();
  BrowserWindow.getAllWindows().forEach((win) => {
    if (!win.isDestroyed()) win.webContents.send('settings-updated', payload);
  });
}

function applyAutoLaunch() {
  try {
    app.setLoginItemSettings({
      openAtLogin: !!settings.autoLaunch,
      // Прячем окно при автозапуске только если так просил пользователь.
      args: settings.startInTray ? ['--hidden'] : []
    });
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
let trayCoverRequest = 0;             // защита от гонки асинхронных обложек
let trayCoverEnabled = null;          // чтобы не дёргать обложку на каждую смену темы
let trayMenuKey = null;               // не пересобираем меню на каждый keepalive
let powerBlockId = null;              // не даём системе усыпить приложение при игре

/* ---------------------------- Вспомогательное ---------------------------- */

function isVkUrl(url) {
  try {
    return VK_HOST_PATTERN.test(new URL(url).hostname);
  } catch (_) {
    return false;
  }
}

/** Внешние ссылки — только безопасные схемы (никаких file:// и кастомных протоколов). */
function openExternalSafe(url) {
  try {
    const parsed = new URL(url);
    if (parsed.protocol === 'http:' || parsed.protocol === 'https:' || parsed.protocol === 'mailto:') {
      shell.openExternal(url).catch(() => {});
    }
  } catch (_) {
    /* некорректная ссылка — игнорируем */
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


function setupGlobalShortcuts() {
  if (!settings.globalHotkeys) return;
  try {
    globalShortcut.register('CommandOrControl+Alt+Space', () => sendPlayerCommand('play-pause'));
    globalShortcut.register('CommandOrControl+Alt+Right', () => sendPlayerCommand('next'));
    globalShortcut.register('CommandOrControl+Alt+Left', () => sendPlayerCommand('previous'));
    globalShortcut.register('CommandOrControl+Alt+L', () => sendLyricsToggle());
  } catch (_) {}
}

function applyGlobalShortcuts() {
  try { globalShortcut.unregisterAll(); } catch (_) {}
  if (settings.globalHotkeys) setupGlobalShortcuts();
}


function showWindowsToast(title, body, iconPath) {
  if (process.platform !== 'win32') {
    try { new Notification({ title, body, icon: iconPath }).show(); } catch (_) {}
    return;
  }
  const cleanTitle = (title || 'VK Музыка').replace(/['"]/g, '');
  const cleanBody = (body || '').replace(/['"]/g, '');
  const psScript = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] | Out-Null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] | Out-Null
$template = @"
<toast>
  <visual>
    <binding template="ToastGeneric">
      <text>${cleanTitle}</text>
      <text>${cleanBody}</text>
    </binding>
  </visual>
</toast>
"@
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml($template)
$toast = [Windows.UI.Notifications.ToastNotification]::new($xml)
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier("VK Wave").Show($toast)
`.trim();

  execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command', psScript], { windowsHide: true }, () => {});
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

/* ------------------------- Обложка: данные и цвет ------------------------- */

const coverDataCache = new Map(); // url → dataURL (для ambient-фона)
const coverFailureCache = new Map(); // url → timestamp, когда можно пробовать снова
const COVER_FAILURE_TTL_MS = 5 * 60 * 1000;

function coverRecentlyFailed(url) {
  const until = coverFailureCache.get(url);
  if (!until) return false;
  if (until > Date.now()) return true;
  coverFailureCache.delete(url);
  return false;
}

function markCoverFailed(url) {
  coverFailureCache.set(url, Date.now() + COVER_FAILURE_TTL_MS);
  if (coverFailureCache.size > 50) {
    coverFailureCache.delete(coverFailureCache.keys().next().value);
  }
}

/** Скачивает обложку (с браузерным UA — CDN ВК режет прочее) и возвращает dataURL. */
async function fetchCoverDataUrl(url) {
  if (!url) return null;
  if (coverDataCache.has(url)) return coverDataCache.get(url);
  // Не долбим один и тот же битый/заблокированный CDN каждые несколько секунд.
  if (coverRecentlyFailed(url)) return null;

  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': app.userAgentFallback, Referer: 'https://vk.com/' }
    });
    if (!response.ok) {
      markCoverFailed(url);
      return null;
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      markCoverFailed(url);
      return null;
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    const image = nativeImage.createFromBuffer(buffer);
    if (image.isEmpty()) {
      markCoverFailed(url);
      return null;
    }
    const dataUrl = `data:${contentType};base64,${buffer.toString('base64')}`;
    coverDataCache.set(url, dataUrl);
    if (coverDataCache.size > 12) {
      coverDataCache.delete(coverDataCache.keys().next().value);
    }
    return dataUrl;
  } catch (_) {
    markCoverFailed(url);
    return null;
  }
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

/** Из списка вариантов LRCLIB берём ближайший по длительности. */
function pickLyricsVariant(list, duration) {
  if (!Array.isArray(list) || !list.length) return null;
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
  return pick && (pick.syncedLyrics || pick.plainLyrics)
    ? { synced: pick.syncedLyrics || null, plain: pick.plainLyrics || null }
    : null;
}

async function fetchLyrics({ artist, title, duration }) {
  const safeDuration = Number.isFinite(Number(duration)) && Number(duration) > 0
    ? Math.round(Number(duration))
    : 0;
  const key = `${artist}|${title}|${safeDuration}`;
  if (lyricsCache.has(key)) return lyricsCache.get(key);
  if (!app.isPackaged) console.log(`[VK Wave · Lyrics] запрос: "${artist}" — "${title}" (${safeDuration}с)`);

  try {
    const qArtist = cleanLyricsQuery(artist);
    const qTitle = cleanLyricsQuery(title);
    // Точный запрос: artist+title+duration — LRCLIB отдаёт лучший вариант.
    let result = await lrclibLookup(
      `/api/get?artist_name=${encodeURIComponent(qArtist)}` +
      `&track_name=${encodeURIComponent(qTitle)}` +
      (safeDuration > 0 ? `&duration=${safeDuration}` : '')
    );
    // Фолбэк 1: поиск по artist+title без duration.
    if (!result) {
      result = pickLyricsVariant(
        await lrclibList(
          `/api/search?track_name=${encodeURIComponent(qTitle)}` +
          `&artist_name=${encodeURIComponent(qArtist)}`
        ),
        safeDuration
      );
    }
    // Фолбэк 2: свободный поиск строкой — спасает при неверном разбиении
    // «исполнитель — трек» и нестандартных названиях.
    if (!result) {
      result = pickLyricsVariant(
        await lrclibList(`/api/search?q=${encodeURIComponent(`${qArtist} ${qTitle}`.trim())}`),
        safeDuration
      );
    }
    lyricsCache.set(key, result);
    if (lyricsCache.size > 60) lyricsCache.delete(lyricsCache.keys().next().value);
    if (!app.isPackaged) {
      console.log(`[VK Wave · Lyrics] ${result ? (result.synced ? 'синхронизированный текст найден' : 'только простой текст') : 'текст не найден'}`);
    }
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
  applySettingsToWindow();
  broadcastSettings();
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
    // Стартуем сразу с сохранённой темы, чтобы не мигать дефолтным тёмным.
    backgroundColor: settings.theme.background || '#141414',
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
            color: settings.theme.background || '#141414',
            symbolColor: isLightColor(settings.theme.background) ? '#1c1c1c' : '#ffffff',
            height: TITLEBAR_HEIGHT
          }
        }
      : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      partition: 'persist:vkwave',
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      autoplayPolicy: 'no-user-gesture-required',
      spellcheck: false
    }
  });

  // Новое окно — применяем все настройки заново.
  appliedMainSettings = null;

  const startHidden = process.argv.includes('--hidden') || settings.startInTray;
  mainWindow.once('ready-to-show', () => {
    if (!startHidden) {
      mainWindow.show();
      mainWindow.focus();
    }
  });
  setTimeout(() => {
    if (mainWindow && !mainWindow.isDestroyed() && !mainWindow.isVisible() && !startHidden) {
      mainWindow.show();
      mainWindow.focus();
    }
  }, 1200);

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

    mainWindow.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.log('[VK Wave] did-fail-load:', errorCode, errorDescription, validatedURL);
  });
  mainWindow.webContents.on('did-finish-load', injectTitleBarStyles);

  // Полная навигация уничтожает вставленный CSS, но ключ insertCSS остаётся
  // в main-процессе. Сбрасываем его, иначе «Только музыка» исчезает после F5.
  mainWindow.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
    if (isMainFrame && !isInPlace) musicOnlyCssKey = null;
  });

  // Переходы на сторонние сайты открываем в системном браузере.
  mainWindow.webContents.on('will-navigate', (event, url) => {
    if (isVkUrl(url)) return;
    event.preventDefault();
    openExternalSafe(url);
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
    openExternalSafe(url);
    return { action: 'deny' };
  });

  // Renderer может упасть (например, из-за нехватки памяти) — поднимаем окно.
  mainWindow.webContents.on('render-process-gone', (_event, details) => {
    if (isQuitting || details.reason === 'clean-exit') return;
    console.log('[VK Wave] Renderer упал:', details.reason, '— перезагружаю страницу.');
    setTimeout(() => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.reload();
    }, 1000);
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

  mainWindow.loadURL(VK_MUSIC_URL).catch(() => {});
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

/** Страницы, которые нельзя ломать редиректом «Только музыка». */
const MUSIC_ONLY_BYPASS_PATHS = /^\/(login|oauth|authorize|join|away|dev|api|download|faq|support)\b/i;
const VK_MAIN_HOSTS = new Set(['vk.com', 'www.vk.com', 'm.vk.com', 'vk.ru', 'www.vk.ru', 'm.vk.ru']);

function enforceMusicOnly(url) {
  if (!settings.musicOnly || redirectingToMusic) return;
  let parsed;
  try {
    parsed = new URL(url);
  } catch (_) {
    return;
  }
  // Субдомены (login.vk.com, id.vk.com, oauth.vk.com) и внешние хосты
  // не трогаем — иначе сломаем авторизацию и OAuth-попапы.
  if (!VK_MAIN_HOSTS.has(parsed.hostname.toLowerCase())) return;
  // Музыкальный раздел (включая альбомы и страницы артистов) — можно.
  if (/^\/(music|artist|audio)/i.test(parsed.pathname)) return;
  // Служебные страницы VK (логин, OAuth, поддержка) — можно.
  if (MUSIC_ONLY_BYPASS_PATHS.test(parsed.pathname) || /\.php$/i.test(parsed.pathname)) return;
  // Вход и внутренние редиректы VK иногда идут на корень с ?act=login,
  // ?oauth=... или ?u=...&to=<base64-путь> — не ломаем их.
  if (/[?&](?:act=login|login|oauth|authorize|to|u)\b/i.test(parsed.search)) return;

  redirectingToMusic = true;
  mainWindow.webContents
    .loadURL(VK_MUSIC_URL)
    .catch(() => {})
    .finally(() => {
      redirectingToMusic = false;
    });
}

function applyMusicOnly() {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (settings.musicOnly && !musicOnlyCssKey) {
    mainWindow.webContents
      .insertCSS(MUSIC_ONLY_CSS, { cssOrigin: 'user' })
      .then((key) => {
        if (!mainWindow || mainWindow.isDestroyed()) return;
        // Пока вставляли, тумблер могли выключить.
        if (!settings.musicOnly) {
          mainWindow.webContents.removeInsertedCSS(key).catch(() => {});
          return;
        }
        musicOnlyCssKey = key;
      })
      .catch(() => {
        musicOnlyCssKey = null;
      });
  } else if (!settings.musicOnly && musicOnlyCssKey) {
    mainWindow.webContents.removeInsertedCSS(musicOnlyCssKey).catch(() => {});
    musicOnlyCssKey = null;
  }
}

/** Применяет main-часть настроек: цвет рамки, mica/acrylic, musicOnly, автозапуск. */
function applySettingsToWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const prev = appliedMainSettings;
  const themeChanged = !prev || prev.background !== settings.theme.background;

  if (themeChanged) {
    try {
      mainWindow.setBackgroundColor(settings.theme.background || '#141414');
    } catch (_) {
      /* доступно не на всех платформах */
    }
    try {
      mainWindow.setTitleBarOverlay({
        color: settings.theme.background || '#141414',
        symbolColor: isLightColor(settings.theme.background) ? '#1c1c1c' : '#ffffff',
        // height обязателен: без него Electron сбрасывает высоту оверлея
        // на дефолтную, и кнопки окна разъезжаются с полосой 34px.
        height: TITLEBAR_HEIGHT
      });
    } catch (_) {
      /* titleBarOverlay доступен не на всех платформах */
    }
  }

  if (!prev || prev.backgroundMaterial !== settings.backgroundMaterial) {
    applyBackgroundMaterial();
  }

  if (!settings.trayCover) {
    if (trayCoverEnabled !== false) {
      trayCoverEnabled = false;
      trayCoverRequest += 1; // отменяем возможный незавершённый запрос обложки
      resetTrayIcon();
    }
  } else if (trayCoverEnabled !== true) {
    trayCoverEnabled = true;
    if (lastTrack) updateTrayIcon(lastTrack).catch(() => {});
  }

  if (!prev || prev.musicOnly !== settings.musicOnly) applyMusicOnly();
  if (
    !prev ||
    prev.autoLaunch !== settings.autoLaunch ||
    prev.startInTray !== settings.startInTray
  ) {
    applyAutoLaunch();
  }

  appliedMainSettings = {
    background: settings.theme.background,
    backgroundMaterial: settings.backgroundMaterial,
    trayCover: settings.trayCover,
    musicOnly: settings.musicOnly,
    autoLaunch: settings.autoLaunch,
    startInTray: settings.startInTray
  };
}

/** Не даём системе приостановить приложение, пока играет музыка. */
function syncPlaybackPower(isPlaying) {
  try {
    if (isPlaying && powerBlockId === null) {
      powerBlockId = powerSaveBlocker.start('prevent-app-suspension');
    } else if (!isPlaying && powerBlockId !== null) {
      powerSaveBlocker.stop(powerBlockId);
      powerBlockId = null;
    }
  } catch (_) {
    /* блокировщик недоступен на этой платформе */
  }
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

  // Инвалидируем любой предыдущий запрос, даже если новый трек без обложки
  // или иконка выключена: иначе медленный старый ответ перетрёт актуальное.
  const request = ++trayCoverRequest;
  if (!settings.trayCover) {
    resetTrayIcon();
    return;
  }
  if (!track || !track.coverUrl) {
    resetTrayIcon();
    return;
  }

  const url = track.coverUrl;
  if (trayCoverCache.has(url)) {
    tray.setImage(trayCoverCache.get(url));
    return;
  }
  if (coverRecentlyFailed(url)) {
    resetTrayIcon();
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
    if (request !== trayCoverRequest || !settings.trayCover) return;
    if (!response.ok) {
      markCoverFailed(url);
      resetTrayIcon();
      return;
    }
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) {
      markCoverFailed(url);
      resetTrayIcon();
      return;
    }
    const image = nativeImage.createFromBuffer(Buffer.from(await response.arrayBuffer()));
    if (request !== trayCoverRequest || !settings.trayCover) return;
    if (image.isEmpty()) {
      markCoverFailed(url);
      resetTrayIcon();
      return;
    }
    const trayImage = image.resize({ width: 16, height: 16 });
    trayCoverCache.set(url, trayImage);
    if (trayCoverCache.size > 30) {
      trayCoverCache.delete(trayCoverCache.keys().next().value);
    }
    tray.setImage(trayImage);
  } catch (_) {
    markCoverFailed(url);
    resetTrayIcon();
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

  // Меню зависит только от состояния «играет/пауза» и трека. Пересобирать
  // его на каждый keepalive-апдейт незачем.
  const menuKey = `${playing}|${lastTrack ? lastTrack.artist : ''}|${lastTrack ? lastTrack.title : ''}`;
  if (menuKey === trayMenuKey) return;
  trayMenuKey = menuKey;

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
      {
        label: settings.discordRpc ? 'Discord: включен' : 'Discord: выключен',
        click: () => {
          settings = mergeSettings(settings, { discordRpc: !settings.discordRpc });
          scheduleSaveSettings();
          syncDiscord();
      applyGlobalShortcuts();
      broadcastSettings();
          trayMenuKey = null;
          updateTray();
        }
      },
      {
        label: 'Копировать трек',
        enabled: !!(lastTrack && lastTrack.title),
        click: () => {
          if (lastTrack && lastTrack.title) {
            clipboard.writeText(`${lastTrack.artist} — ${lastTrack.title}`);
          }
        }
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

    autoUpdater.on('update-downloaded', () => {
      try {
        if (Notification.isSupported()) {
          new Notification({
            title: WINDOW_TITLE,
            body: 'Обновление скачано. Установится при следующем выходе.'
          }).show();
        }
      } catch (_) {
        /* уведомления недоступны */
      }
    });

    const check = () => {
      autoUpdater.checkForUpdates().catch(() => {});
    };

    check();
    setInterval(check, SIX_HOURS_MS);
  } catch (_) {
    /* electron-updater недоступен — обновления вручную с GitHub */
  }
}

/* --------------------------- Discord: вкл/выкл ---------------------------- */

/** Тумблер Rich Presence из панели: включает/выключает клиент на лету. */
function syncDiscord() {
  if (settings.discordRpc && !discord) {
    discord = new DiscordPresence();
    if (lastTrack) discord.update(lastTrack);
    discord.start();
  } else if (!settings.discordRpc && discord) {
    try {
      discord.destroy();
    } catch (_) {
      /* клиент уже отключён */
    }
    discord = null;
  }
}

/* ------------------------------- Запуск app ------------------------------ */

const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  app.on('second-instance', () => showMainWindow());

  app.whenReady().then(() => {
    try { app.setAppUserModelId(process.execPath); } catch (_) {}

    loadSettings();
    applyAutoLaunch();
    applyAutoDayNight(); // старт в правильной половине суток

    // Разрешаем только нужные странице разрешения (медиа, фулскрин, уведомления).
    const vkSession = session.fromPartition('persist:vkwave');
    const allowedPermissions = new Set([
      'media',
      'fullscreen',
      'notifications',
      'pointerLock',
      'clipboard-sanitized-write'
    ]);
    vkSession.setPermissionRequestHandler((_wc, permission, callback) => {
      callback(allowedPermissions.has(permission));
    });
    vkSession.setPermissionCheckHandler((_wc, permission) => allowedPermissions.has(permission));

    installTrackerBlocklist(vkSession);

    // Сводка о треке из preload-перехватчика.
    ipcMain.on('track-update', (_event, track) => {
      if (!track || typeof track !== 'object' || (!track.title && !track.artist)) return;
      const prevTrack = lastTrack;
      if (settings.trackNotifications && track.isPlaying) {
        const titleChanged = !prevTrack || prevTrack.title !== track.title || prevTrack.artist !== track.artist;
        if (titleChanged) {
          try {
            showWindowsToast(track.artist || 'VK Музыка', track.title || 'Неизвестный трек', path.join(__dirname, 'assets', 'logo.png'));
          } catch (_) {}
        }
      }
      lastTrack = track;
      syncPlaybackPower(!!track.isPlaying);
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
      const coverUrl = track.coverUrl;
      if (coverUrl && (settings.ambientCover || settings.accentFromCover)) {
        fetchCoverDataUrl(coverUrl)
          .then((dataUrl) => {
            // Пока скачивали, трек мог смениться — не красим окно старой обложкой.
            if (!lastTrack || lastTrack.coverUrl !== coverUrl) return;
            if (!dataUrl || !mainWindow || mainWindow.isDestroyed()) return;
            if (settings.ambientCover) {
              mainWindow.webContents.send('cover-image', dataUrl);
            }
            if (settings.accentFromCover) {
              return extractCoverAccent(coverUrl).then((hex) => {
                if (
                  hex &&
                  lastTrack &&
                  lastTrack.coverUrl === coverUrl &&
                  mainWindow &&
                  !mainWindow.isDestroyed()
                ) {
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
    
    // Компактный режим (мини-плеер)
    
    // Выбор картинки для фона окна
    
    // Скачивание трека (MP3)
    ipcMain.handle('audio:download', async (_event, info) => {
      if (!info || !info.url) return { success: false, error: 'Нет URL аудио' };
      const rawArtist = (info.artist || 'Неизвестный исполнитель').replace(/[/\\?%*:|"<>]/g, '_');
      const rawTitle = (info.title || 'Трек').replace(/[/\\?%*:|"<>]/g, '_');
      const defaultFilename = `${rawArtist} — ${rawTitle}.mp3`;
      
      const { canceled, filePath } = await dialog.showSaveDialog(mainWindow, {
        title: 'Сохранить трек',
        defaultPath: path.join(app.getPath('downloads'), defaultFilename),
        filters: [{ name: 'Аудио MP3', extensions: ['mp3'] }]
      });
      if (canceled || !filePath) return { success: false, canceled: true };

      try {
        const response = await fetch(info.url, {
          headers: {
            'User-Agent': app.userAgentFallback,
            'Referer': 'https://vk.com/'
          }
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        fs.writeFileSync(filePath, buffer);
        if (Notification.isSupported()) {
          new Notification({
            title: 'VK Wave · Загрузка завершена',
            body: `Трек сохранён: ${defaultFilename}`,
            icon: path.join(__dirname, 'assets', 'logo.png')
          }).show();
        }
        return { success: true, filePath };
      } catch (err) {
        return { success: false, error: err.message };
      }
    });

    ipcMain.handle('dialog:choose-image', async () => {
      if (!mainWindow || mainWindow.isDestroyed()) return null;
      const res = await dialog.showOpenDialog(mainWindow, {
        title: 'Выберите изображение для фона',
        properties: ['openFile'],
        filters: [{ name: 'Изображения', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif'] }]
      });
      if (res.canceled || !res.filePaths.length) return null;
      try {
        const filePath = res.filePaths[0];
        const data = fs.readFileSync(filePath);
        const ext = path.extname(filePath).slice(1).toLowerCase();
        const mime = ext === 'png' ? 'image/png' : ext === 'gif' ? 'image/gif' : ext === 'webp' ? 'image/webp' : 'image/jpeg';
        return `data:${mime};base64,${data.toString('base64')}`;
      } catch (_) {
        return null;
      }
    });

    ipcMain.handle('window:toggle-pip', () => {
      if (!mainWindow || mainWindow.isDestroyed()) return false;
      const isPip = mainWindow.isAlwaysOnTop() && mainWindow.getSize()[0] < 450;
      if (isPip) {
        mainWindow.setAlwaysOnTop(false);
        mainWindow.setMinimumSize(940, 600);
        mainWindow.setSize(1180, 780);
        mainWindow.center();
        return false;
      } else {
        mainWindow.setMinimumSize(360, 220);
        mainWindow.setSize(380, 240);
        mainWindow.setAlwaysOnTop(true, 'floating');
        return true;
      }
    });

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

    // Буфер обмена — через main, чтобы не выдавать странице clipboard-read.
    ipcMain.handle('clipboard:write', (_event, text) => {
      if (typeof text !== 'string' || text.length > 200000) return false;
      clipboard.writeText(text);
      return true;
    });
    ipcMain.handle('clipboard:read', () => clipboard.readText());

    // Настройки из панели VK Wave (Ctrl+Shift+T / трей).
    ipcMain.handle('settings:get', () => settingsPayload());

    ipcMain.handle('settings:set', (_event, patch) => {
      const previousSettings = settings;
      settings = mergeSettings(settings, patch);
      scheduleSaveSettings();
      // Только при включении тумблера: ручной выбор темы не перебиваем.
      if (patch && patch.autoDayNight === true) applyAutoDayNight();
      applySettingsToWindow();
      syncDiscord();
      broadcastSettings();
      // Ambient включили посреди сессии — сразу отправляем текущую обложку,
      // не дожидаясь следующего трека.
      const coverUrl = lastTrack && lastTrack.coverUrl;
      const ambientJustEnabled = !previousSettings.ambientCover && settings.ambientCover;
      const accentJustEnabled = !previousSettings.accentFromCover && settings.accentFromCover;
      if (ambientJustEnabled && coverUrl) {
        fetchCoverDataUrl(coverUrl)
          .then((dataUrl) => {
            if (
              dataUrl &&
              lastTrack &&
              lastTrack.coverUrl === coverUrl &&
              mainWindow &&
              !mainWindow.isDestroyed()
            ) {
              mainWindow.webContents.send('cover-image', dataUrl);
            }
          })
          .catch(() => {});
      }
      // Акцент из обложки включили посреди трека — пересчитываем сразу.
      if (accentJustEnabled && coverUrl) {
        extractCoverAccent(coverUrl)
          .then((hex) => {
            if (
              hex &&
              lastTrack &&
              lastTrack.coverUrl === coverUrl &&
              mainWindow &&
              !mainWindow.isDestroyed()
            ) {
              mainWindow.webContents.send('cover-accent', hex);
            }
          })
          .catch(() => {});
      }
      return settingsPayload();
    });

    createWindow();
    createTray();
    syncDiscord();
    setupGlobalShortcuts();
    setupAutoUpdater();

    app.on('activate', () => showMainWindow());
  });

  app.on('window-all-closed', () => {
    if (isQuitting) app.quit();
  });

  app.on('session-end', () => { flushSettingsSave(); });

  app.on('before-quit', () => {
    try { globalShortcut.unregisterAll(); } catch (_) {}
    isQuitting = true;
    flushSettingsSave();
    if (powerBlockId !== null) {
      try {
        powerSaveBlocker.stop(powerBlockId);
      } catch (_) {
        /* уже остановлен */
      }
      powerBlockId = null;
    }
    if (discord) {
      discord.destroy();
      discord = null;
    }
  });
}
