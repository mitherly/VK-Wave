'use strict';

/**
 * VK Wave — интеграция Discord Rich Presence (@xhayper/discord-rpc).
 *
 *  • Details  — название трека, State — исполнитель.
 *  • Large Image — прямая ссылка на обложку (фолбэк — логотип из репозитория).
 *  • Small Image — иконка play/pause (URL из репозитория) с подписью
 *    «Воспроизводится»/«Пауза».
 *  • Timestamps — прогресс-бар трека (старт/конец), на паузе таймер убирается.
 *  • Buttons — «Слушать в VK Музыке» и «Скачать VK Wave (GitHub)».
 *  • Если клиент Discord не запущен — переподключение каждые 15 секунд.
 *
 * Внешние URL в ассетах поддерживаются самим Discord RPC, поэтому
 * дополнительная настройка портала не требуется. Загрузить арты в хранилище
 * приложения (по желанию) можно скриптом tools/upload-discord-assets.js.
 */

const { Client } = require('@xhayper/discord-rpc');

/** ← Application ID из Discord Developer Portal (см. README). */
const CLIENT_ID = '1565753930418233544';

const RECONNECT_INTERVAL_MS = 15 * 1000;
/* Discord RPC принимает внешние URL прямо в полях ассетов (официально
 * подтверждено мейнтейнерами в discord-api-docs#6592) — поэтому иконки
 * лежат в репозитории и работают без загрузки чего-либо в портал. */
const LOGO_IMAGE_URL = 'https://raw.githubusercontent.com/mitherly/VK-Wave/main/assets/logo.png';
const PLAY_IMAGE_URL = 'https://raw.githubusercontent.com/mitherly/VK-Wave/main/assets/play.png';
const PAUSE_IMAGE_URL = 'https://raw.githubusercontent.com/mitherly/VK-Wave/main/assets/pause.png';
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
    largeImageKey: track.coverUrl || LOGO_IMAGE_URL,
    largeImageText: `${title} — ${artist}`.slice(0, 128),
    smallImageKey: track.isPlaying ? PLAY_IMAGE_URL : PAUSE_IMAGE_URL,
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
    this.sentOnce = false;      // успешная отправка уже логировалась
    this.loggedLoginError = false; // ошибка подключения уже логировалась
    this.degraded = false;      // Discord не принял маленькую иконку — шлём без неё

    this.client.on('ready', () => {
      this.connected = true;
      this.connecting = false;
      this.loggedLoginError = false;
      log(
        'Подключено к Discord RPC как',
        this.client.user && this.client.user.username ? this.client.user.username : 'приложение'
      );
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
    } catch (err) {
      this.connecting = false;
      if (!this.loggedLoginError) {
        this.loggedLoginError = true;
        log('Подключение не удалось:', err && err.message ? err.message : err);
      }
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
    this.sendActivity(activity);
  }

  /** Отправка присутствия с самолечением: если Discord отверг маленькую
   * иконку (внешние URL принимают не все сборки), повторяем без неё. */
  sendActivity(activity) {
    if (this.degraded && activity.smallImageKey) {
      delete activity.smallImageKey;
      delete activity.smallImageText;
    }

    this.client
      .setActivity(activity)
      .then(() => {
        if (!this.sentOnce) {
          this.sentOnce = true;
          log('Присутствие отправлено. Если в профиле его не видно — см. «Возможные проблемы» в README.');
        }
      })
      .catch((err) => {
        log('Не удалось обновить присутствие:', err && err.message ? err.message : err);
        if (!this.degraded && activity.smallImageKey) {
          this.degraded = true;
          log('Пробую без маленькой иконки (режим совместимости)…');
          const fallback = { ...activity };
          delete fallback.smallImageKey;
          delete fallback.smallImageText;
          this.client
            .setActivity(fallback)
            .then(() => log('Отправлено в упрощённом виде — маленькая иконка отключена.'))
            .catch((err2) =>
              log('Упрощённый вариант тоже отклонён:', err2 && err2.message ? err2.message : err2)
            );
        }
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

module.exports = { CLIENT_ID, DiscordPresence, buildActivity };
