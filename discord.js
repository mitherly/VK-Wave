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

/** Плоский объект активности → вложенный формат IPC-команды SET_ACTIVITY. */
function toRawActivity(activity) {
  const raw = {
    details: activity.details,
    state: activity.state,
    timestamps: {},
    assets: {},
    instance: activity.instance === true
  };
  if (Number.isFinite(activity.startTimestamp)) {
    raw.timestamps.start = Math.round(activity.startTimestamp);
  }
  if (Number.isFinite(activity.endTimestamp)) {
    raw.timestamps.end = Math.round(activity.endTimestamp);
  }
  if (activity.largeImageKey) {
    raw.assets.large_image = activity.largeImageKey;
    if (activity.largeImageText) raw.assets.large_text = activity.largeImageText;
  }
  if (activity.smallImageKey) {
    raw.assets.small_image = activity.smallImageKey;
    if (activity.smallImageText) raw.assets.small_text = activity.smallImageText;
  }
  if (Array.isArray(activity.buttons) && activity.buttons.length > 0) {
    raw.buttons = activity.buttons;
  }
  return raw;
}

function errText(err) {
  return err && err.message ? err.message : String(err);
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
    try {
      this.sendActivity(activity);
    } catch (err) {
      log('Ошибка при отправке присутствия:', errText(err));
    }
  }

  /**
   * Отправка присутствия через протокольную команду SET_ACTIVITY
   * (в свежих версиях @xhayper/discord-rpc нет setActivity/clearActivity —
   * только низкоуровневый client.request). С самолечением: если Discord
   * отверг маленькую иконку (внешние URL принимают не все сборки),
   * повторяем без неё.
   */
  sendActivity(activity) {
    const attempt = (withSmallImage) => {
      const flat = withSmallImage ? activity : { ...activity };
      if (!withSmallImage) {
        delete flat.smallImageKey;
        delete flat.smallImageText;
      }
      return this.client.request('SET_ACTIVITY', {
        pid: process.pid,
        activity: toRawActivity(flat)
      });
    };

    if (this.degraded) {
      attempt(false)
        .then(() => {
          if (!this.sentOnce) {
            this.sentOnce = true;
            log('Присутствие отправлено (без маленькой иконки).');
          }
        })
        .catch((err) => log('Не удалось обновить присутствие:', errText(err)));
      return;
    }

    attempt(true)
      .then(() => {
        if (!this.sentOnce) {
          this.sentOnce = true;
          log('Присутствие отправлено. Если в профиле его не видно — см. «Возможные проблемы» в README.');
        }
      })
      .catch((err) => {
        log('Не удалось обновить присутствие:', errText(err));
        this.degraded = true;
        log('Пробую без маленькой иконки (режим совместимости)…');
        attempt(false)
          .then(() => log('Отправлено в упрощённом виде — маленькая иконка отключена.'))
          .catch((err2) => log('Упрощённый вариант тоже отклонён:', errText(err2)));
      });
  }

  clear() {
    if (!this.connected) return;
    try {
      this.client.request('CLEAR_ACTIVITY', { pid: process.pid }).catch(() => {});
    } catch (_) {
      /* клиент уже отключён */
    }
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
