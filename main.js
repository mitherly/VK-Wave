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

const { DiscordPresence } = require('./discord');

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

  mainWindow.once('ready-to-show', () => mainWindow.show());

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
      background: #141414 !important;
    }
    body::before {
      content: '';
      position: fixed;
      top: 0;
      left: 0;
      right: 0;
      height: ${TITLEBAR_HEIGHT}px;
      background: #141414;
      z-index: 2147483647;
      -webkit-app-region: drag;
    }
  `;
  mainWindow.webContents.insertCSS(css, { cssOrigin: 'user' }).catch(() => {});
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
