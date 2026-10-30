'use strict';

/**
 * VK Wave — интеграция Discord Rich Presence (@xhayper/discord-rpc).
 *
 *  • Details  — название трека, State — исполнитель.
 *  • Large Image — прямая ссылка на обложку (фолбэк — ассет «logo»).
 *  • Small Image — иконка play/pause с подписью «Воспроизводится»/«Пауза».
 *  • Timestamps — прогресс-бар трека (старт/конец), на паузе таймер убирается.
 *  • Buttons — «Слушать в VK Музыке» и «Скачать VK Wave (GitHub)».
 *  • Если клиент Discord не запущен — переподключение каждые 15 секунд.
 *
 * Ассеты «logo», «play», «pause» нужно один раз загрузить в приложение
 * на Discord Developer Portal (см. README → «Как настроить Discord Rich Presence»).
 */

const { Client } = require('@xhayper/discord-rpc');

/** ← Application ID из Discord Developer Portal (см. README). */
const CLIENT_ID = '1565753930418233544';

const RECONNECT_INTERVAL_MS = 15 * 1000;
const LOGO_ASSET_KEY = 'logo';
const GITHUB_REPO_URL = 'https://github.com/mitherly/VK-Wave/releases/latest';

const BUTTONS = [
  {
    label: 'Слушать в VK Музыке',
    url: 'https://vk.com/music'
  },
  {
    label: 'Скачать VK Wave (GitHub)',
    url: GITHUB_REPO_URL
  }
];

const isClientIdMissing = !CLIENT_ID || CLIENT_ID === 'YOUR_DISCORD_CLIENT_ID';

function log(...args) {
  console.log('[VK Wave · Discord]', ...args);
}

/** Собирает SetActivity из сводки трека, присылаемой preload-перехватчиком. */
function buildActivity(track) {
  if (!track || (!track.title && !track.artist)) return null;

  const title = track.title || 'Неизвестный трек';
  const artist = track.artist || 'VK Музыка';

  const activity = {
    details: title,
    state: artist,
    largeImageKey: track.coverUrl || LOGO_ASSET_KEY,
    largeImageText: `${title} — ${artist}`.slice(0, 128),
    smallImageKey: track.isPlaying ? 'play' : 'pause',
    smallImageText: track.isPlaying ? 'Воспроизводится' : 'Пауза',
    instance: false,
    buttons: BUTTONS
  };

  if (
    track.isPlaying &&
    Number.isFinite(track.currentTime) &&
    track.currentTime >= 0
  ) {
    const startTimestamp = Date.now() - track.currentTime * 1000;
    activity.startTimestamp = startTimestamp;
    if (
      Number.isFinite(track.duration) &&
      track.duration > 0 &&
      track.currentTime < track.duration
    ) {
      activity.endTimestamp = startTimestamp + track.duration * 1000;
    }
  }

  return activity;
}

class DiscordPresence {
  constructor() {
    this.client = new Client({ clientId: CLIENT_ID });
    this.connected = false;
    this.connecting = false;
    this.reconnectTimer = null;
    this.lastTrack = null;

    this.client.on('ready', () => {
      this.connected = true;
      this.connecting = false;
      log('Подключено к Discord RPC.');
      // Догоняем профиль актуальным треком после (пере)подключения.
      if (this.lastTrack) this.update(this.lastTrack);
    });

    this.client.on('disconnected', () => {
      this.connected = false;
      this.connecting = false;
      this.scheduleReconnect('Соединение с Discord потеряно');
    });
  }

  start() {
    if (isClientIdMissing) {
      log(
        'CLIENT_ID не настроен. Откройте discord.js и замените YOUR_DISCORD_CLIENT_ID ' +
          'на Application ID вашего приложения (инструкция — в README.md).'
      );
      return;
    }
    this.connect();
  }

  async connect() {
    if (this.connected || this.connecting) return;
    this.connecting = true;
    try {
      await this.client.login({ clientId: CLIENT_ID });
      // Дальше сработает событие 'ready'.
    } catch (_) {
      this.connecting = false;
      this.scheduleReconnect('Клиент Discord не запущен или недоступен');
    }
  }

  /** Повтор подключения каждые 15 секунд, пока Discord не поднимется. */
  scheduleReconnect(reason) {
    if (this.reconnectTimer) return;
    if (reason) log(`${reason} — повторная попытка через 15 секунд.`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, RECONNECT_INTERVAL_MS);
  }

  update(track) {
    this.lastTrack = track;
    if (!this.connected || isClientIdMissing) return;
    const activity = buildActivity(track);
    if (!activity) return;
    this.client.setActivity(activity).catch((err) => {
      log('Не удалось обновить присутствие:', err && err.message ? err.message : err);
    });
  }

  clear() {
    if (!this.connected) return;
    this.client.clearActivity().catch(() => {});
  }

  destroy() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.connected = false;
    try {
      this.client.destroy();
    } catch (_) {
      /* клиент уже отключён */
    }
  }
}

module.exports = { DiscordPresence, buildActivity };
