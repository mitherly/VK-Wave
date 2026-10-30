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
  session
} = require('electron');
const path = require('path');
const fs = require('fs');

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
  hotkeys: true,     // Space — пауза, Ctrl+←/→ — треки
  autoLaunch: false, // запускать с Windows
  startInTray: false, // стартовать свёрнутым в трей
  theme: {
    preset: 'default', // default | oled | midnight | light | custom
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

/* --------------------------------- Окно --------------------------------- */

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1180,
    height: 780,
    minWidth: 940,
    minHeight: 600,
    show: false,
    title: WINDOW_TITLE,
    backgroundColor: '#141414',
    autoHideMenuBar: true,
    icon: path.join(__dirname, 'assets', 'logo.png'),
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#141414',
      symbolColor: '#ffffff',
      height: TITLEBAR_HEIGHT
    },
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
      sendPlayerCommand('settings-toggle');
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
      content: '';
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: ${TITLEBAR_HEIGHT}px;
      background: var(--vkwave-bg, #141414);
      z-index: 2147483647;
      -webkit-app-region: drag;
    }
  `;
  mainWindow.webContents.insertCSS(css, { cssOrigin: 'user' }).catch(() => {});
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

/** Применяет main-часть настроек: цвет рамки, musicOnly, автозапуск. */
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
  applyMusicOnly();
  applyAutoLaunch();
}

/* --------------------------------- Трей --------------------------------- */

function createTray() {
  const icon = nativeImage
    .createFromPath(path.join(__dirname, 'assets', 'logo.png'))
    .resize({ width: 16, height: 16 });
  tray = new Tray(icon);
  tray.setToolTip(WINDOW_TITLE);
  tray.on('click', () => showMainWindow());
  updateTray();
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
      { label: 'Настройки', click: () => sendPlayerCommand('settings-toggle') },
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

    // Сводка о треке из preload-перехватчика.
    ipcMain.on('track-update', (_event, track) => {
      if (!track || typeof track !== 'object' || (!track.title && !track.artist)) return;
      lastTrack = track;
      if (discord) discord.update(track);
      updateTray();
    });

    // Настройки из панели VK Wave (Ctrl+Shift+T / трей).
    ipcMain.handle('settings:get', () => settings);

    ipcMain.handle('settings:set', (_event, patch) => {
      settings = mergeSettings(settings, patch);
      saveSettings();
      applySettingsToWindow();
      BrowserWindow.getAllWindows().forEach((win) => {
        if (!win.isDestroyed()) win.webContents.send('settings-updated', settings);
      });
      return settings;
    });

    createWindow();
    createTray();

    discord = new DiscordPresence();
    discord.start();

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
