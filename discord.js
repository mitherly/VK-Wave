'use strict';

/**
 * VK Wave — интеграция Discord Rich Presence (@xhayper/discord-rpc).
 *
 *  • Тип активности — LISTENING: в профиле пишется «Слушает VK Wave»,
 *    а не «Играет в…». Если сборка Discord не знает этот тип —
 *    автоматически откатываемся на обычное «Играет».
 *  • Details — название трека, State — исполнитель.
 *  • Large Image — обложка трека (фолбэк — логотип), Small Image —
 *    иконка play/pause со всплывающим текстом.
 *  • Timestamps — прогресс-бар трека, на паузе таймер убирается.
 *  • Buttons — «Слушать в VK Музыке» и «Скачать VK Wave (GitHub)».
 *  • Если клиент Discord не запущен — переподключение каждые 15 секунд.
 *
 * Картинки, максимально надёжно:
 *   заданы DISCORD_CLIENT_SECRET (+ опционально DISCORD_BOT_TOKEN) — VK Wave
 *   получает Bearer-токен приложения (client_credentials) и грузит logo/play/pause
 *   и обложку каждого трека в хранилище классическим телом {name, image} —
 *   это самый надёжный маршрут. Запасной путь — двухшаговый presign-флоу с
 *   токеном бота. Без секретов — прямые URL (официально поддержаны Discord,
 *   но прокси может капризничать, а CDN ВК блокирует загрузки прокси Discord).
 *
 * Свежие версии @xhayper/discord-rpc не имеют setActivity/clearActivity —
 * работаем через протокольные client.request('SET_ACTIVITY'|'CLEAR_ACTIVITY').
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { Client } = require('@xhayper/discord-rpc');

/** ← Application ID из Discord Developer Portal (см. README). */
const CLIENT_ID = '1565753930418233544';

const OAUTH_TOKEN_URL = 'https://discord.com/api/oauth2/token';

/** ActivityType.LISTENING — в профиле будет «Слушает VK Wave». */
const ACTIVITY_TYPE_LISTENING = 2;

const RECONNECT_INTERVAL_MS = 15 * 1000;
const GITHUB_REPO_URL = 'https://github.com/mitherly/VK-Wave/releases/latest';
const ASSETS_API = `https://discord.com/api/v9/applications/${CLIENT_ID}/assets`;

/* Discord RPC принимает внешние URL прямо в полях ассетов (официально
 * подтверждено мейнтейнерами в discord-api-docs#6592) — иконки лежат в
 * репозитории и работают без загрузки чего-либо в портал. */
const LOGO_IMAGE_URL = 'https://raw.githubusercontent.com/mitherly/VK-Wave/main/assets/logo.png';
const PLAY_IMAGE_URL = 'https://raw.githubusercontent.com/mitherly/VK-Wave/main/assets/play.png';
const PAUSE_IMAGE_URL = 'https://raw.githubusercontent.com/mitherly/VK-Wave/main/assets/pause.png';

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

function errText(err) {
  return err && err.message ? err.message : String(err);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function sha1Short(value) {
  return crypto.createHash('sha1').update(String(value)).digest('hex').slice(0, 12);
}

/* Недокументированный REST-эндпоинт ассетов приложения (v9). */
async function apiRequest(method, url, auth, body) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: auth,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    throw new Error(`Сеть недоступна (${errText(err)})`);
  }
  const raw = await response.text();
  let payload = null;
  try {
    payload = raw ? JSON.parse(raw) : null;
  } catch (_) {
    payload = null;
  }
  if (!response.ok) {
    const apiMessage = payload && payload.message ? payload.message : raw.slice(0, 200);
    const err = new Error(`HTTP ${response.status}: ${apiMessage}`);
    err.status = response.status;
    throw err;
  }
  return payload || [];
}

function fileToImage(file) {
  return {
    buffer: fs.readFileSync(file),
    contentType: 'image/png',
    ext: 'png'
  };
}

function bufferToDataUri(image) {
  return `data:${image.contentType};base64,${image.buffer.toString('base64')}`;
}

async function fetchImage(url) {
  try {
    const response = await fetch(url);
    if (!response.ok) return null;
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.startsWith('image/')) return null;
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length === 0 || buffer.length > 8 * 1024 * 1024) return null;
    const ext = contentType.includes('png')
      ? 'png'
      : contentType.includes('gif')
        ? 'gif'
        : contentType.includes('webp')
          ? 'webp'
          : 'jpg';
    return { buffer, contentType, ext };
  } catch (_) {
    return null;
  }
}

/** Собирает плоский объект активности из сводки трека. */
function buildActivity(track, images) {
  if (!track || (!track.title && !track.artist)) return null;

  const title = track.title || 'Неизвестный трек';
  const artist = track.artist || 'VK Музыка';

  /** «0:33 / 2:15» — нижняя строка карточки. */
  const formatTime = (seconds) => {
    const total = Math.max(0, Math.floor(Number(seconds) || 0));
    const minutes = Math.floor(total / 60);
    const secs = String(total % 60).padStart(2, '0');
    return `${minutes}:${secs}`;
  };
  const hasDuration = Number.isFinite(track.duration) && track.duration > 0;

  const activity = {
    details: title,
    state: artist,
    largeImageKey: (images && images.large) || LOGO_IMAGE_URL,
    largeImageText: hasDuration
      ? `${formatTime(track.currentTime)} / ${formatTime(track.duration)}`
      : `${title} — ${artist}`.slice(0, 128),
    smallImageKey: (images && images.small) || (track.isPlaying ? PLAY_IMAGE_URL : PAUSE_IMAGE_URL),
    smallImageText: track.isPlaying ? 'Воспроизводится' : 'Пауза',
    instance: false,
    buttons: BUTTONS
  };

  if (track.isPlaying && Number.isFinite(track.currentTime) && track.currentTime >= 0) {
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
function toRawActivity(activity, listening) {
  const raw = {
    type: listening ? ACTIVITY_TYPE_LISTENING : 0,
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

class DiscordPresence {
  constructor() {
    this.client = new Client({ clientId: CLIENT_ID });
    this.connected = false;
    this.connecting = false;
    this.reconnectTimer = null;
    this.lastTrack = null;
    this.sentOnce = false;      // успешная отправка уже логировалась
    this.loggedLoginError = false;

    // Портальные ассеты: включаются, если задан DISCORD_BOT_TOKEN.
    this.botToken = (process.env.DISCORD_BOT_TOKEN || '').trim();
    this.clientSecret = (process.env.DISCORD_CLIENT_SECRET || '').trim();
    this.portalKeysPromise = null;
    this.appTokenCache = null; // { token, expiresAt } — client_credentials
    this.uploadedCoverNames = new Map(); // url → имя ассета в портале

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
    if (this.clientSecret) {
      log('DISCORD_CLIENT_SECRET задан — обложки и иконки пойдут через Bearer (client_credentials).');
    }
    if (this.botToken) {
      log('DISCORD_BOT_TOKEN задан — запасной путь загрузки (presign-флоу).');
    }
    if (!this.clientSecret && !this.botToken) {
      log('Секреты не заданы — картинки идут внешними URL (см. README про «?» вместо обложки).');
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
        log('Подключение не удалось:', errText(err));
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

  /** Bearer-токен приложения через client_credentials (нужен CLIENT_SECRET). */
  async ensureAppToken() {
    if (!this.clientSecret) return null;
    if (this.appTokenCache && Date.now() < this.appTokenCache.expiresAt) {
      return this.appTokenCache.token;
    }
    try {
      const params = new URLSearchParams({
        client_id: CLIENT_ID,
        client_secret: this.clientSecret,
        grant_type: 'client_credentials',
        scope: 'identify'
      });
      const response = await fetch(OAUTH_TOKEN_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: params.toString()
      });
      const data = await response.json().catch(() => null);
      if (!response.ok || !data || !data.access_token) {
        throw new Error(
          `HTTP ${response.status}: ${data && data.message ? data.message : 'нет access_token'}`
        );
      }
      const expiresIn = Number(data.expires_in) || 604800;
      this.appTokenCache = {
        token: data.access_token,
        expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000
      };
      log('Получен Bearer-токен приложения (client_credentials).');
      return this.appTokenCache.token;
    } catch (err) {
      log('client_credentials не удался:', errText(err));
      return null;
    }
  }

  /** logo/play/pause → хранилище приложения (один раз за запуск). */
  async ensurePortalKeys() {
    if (!this.botToken && !this.clientSecret) return null;
    if (this.portalKeysPromise) return this.portalKeysPromise;
    this.portalKeysPromise = (async () => {
      const errors = [];

      // Путь 1 — Bearer-токен приложения (client_credentials) и классическое
      // тело {name, image}: маршрут владельца приложения, самый надёжный.
      const appToken = await this.ensureAppToken();
      if (appToken) {
        try {
          const existing = await apiRequest('GET', ASSETS_API, `Bearer ${appToken}`);
          const names = new Set(existing.map((asset) => asset.name));
          for (const key of ['logo', 'play', 'pause']) {
            if (names.has(key)) continue;
            const file = path.join(__dirname, 'assets', `${key}.png`);
            if (!fs.existsSync(file)) continue;
            await apiRequest('POST', ASSETS_API, `Bearer ${appToken}`, {
              name: key,
              image: bufferToDataUri(fileToImage(file))
            });
            await sleep(300);
          }
          log('Ассеты портала готовы (Bearer): logo, play, pause.');
          return { logo: 'logo', play: 'play', pause: 'pause' };
        } catch (err) {
          errors.push(`Bearer: ${errText(err)}`);
        }
      }

      // Путь 2 — двухшаговый presign-флоу с токеном бота.
      if (this.botToken) {
        try {
          let existing = [];
          try {
            existing = await apiRequest('GET', ASSETS_API, `Bot ${this.botToken}`);
          } catch (_) {
            existing = await apiRequest('GET', ASSETS_API, this.botToken); // без префикса
          }
          const names = new Set(existing.map((asset) => asset.name));
          for (const key of ['logo', 'play', 'pause']) {
            if (names.has(key)) continue;
            const file = path.join(__dirname, 'assets', `${key}.png`);
            if (!fs.existsSync(file)) continue;
            await this.uploadAsset(key, fileToImage(file));
            await sleep(300);
          }
          log('Ассеты портала готовы (presign): logo, play, pause.');
          return { logo: 'logo', play: 'play', pause: 'pause' };
        } catch (err) {
          errors.push(`presign: ${errText(err)}`);
        }
      }

      log('Ассеты портала недоступны (использую внешние URL):', errors.join(' | ') || 'нет доступных путей');
      return null;
    })();
    return this.portalKeysPromise;
  }

  /**
   * Загрузка ассета — запасной путь через presign-флоу Discord:
   *  1) POST /assets/upload → пресдейл-ссылка (upload_url + upload_filename);
   *  2) PUT байтов файла напрямую в GCP-бакет Discord;
   *  3) POST /assets с { key, uploaded_filename } — регистрация ассета.
   */
  async uploadAsset(name, image) {
    const filename = `${name}.${image.ext}`;

    // Шаг 1: пресдейл-ссылка.
    const uploadResponse = await apiRequest('POST', `${ASSETS_API}/upload`, `Bot ${this.botToken}`, {
      files: [{ filename, file_size: image.buffer.length }]
    });
    const attachments = uploadResponse && uploadResponse.attachments;
    const attachment = Array.isArray(attachments) ? attachments[0] : null;
    if (!attachment || !attachment.upload_url || !attachment.upload_filename) {
      throw new Error('Discord не вернул upload_url для ассета');
    }

    // Шаг 2: байты файла — напрямую в хранилище Discord.
    const putResponse = await fetch(attachment.upload_url, {
      method: 'PUT',
      headers: { 'Content-Type': image.contentType },
      body: Buffer.from(image.buffer)
    });
    if (!putResponse.ok) {
      throw new Error(`Загрузка файла в хранилище: HTTP ${putResponse.status}`);
    }

    // Шаг 3: регистрируем ассет под ключом name.
    return apiRequest('POST', ASSETS_API, `Bot ${this.botToken}`, {
      key: name,
      uploaded_filename: attachment.upload_filename
    });
  }

  /** Обложка трека → ассет «cover_<hash>» в хранилище (дедуп по URL). */
  async uploadCoverAsAsset(url) {
    if ((!this.botToken && !this.clientSecret) || !url) return null;
    if (this.uploadedCoverNames.has(url)) return this.uploadedCoverNames.get(url);
    try {
      const image = await fetchImage(url);
      if (!image) return null;
      const name = `cover_${sha1Short(url)}`;
      const errors = [];

      const appToken = await this.ensureAppToken();
      if (appToken) {
        try {
          await apiRequest('POST', ASSETS_API, `Bearer ${appToken}`, {
            name,
            image: bufferToDataUri(image)
          });
          this.uploadedCoverNames.set(url, name);
          return name;
        } catch (err) {
          errors.push(`Bearer: ${errText(err)}`);
        }
      }

      if (this.botToken) {
        try {
          await this.uploadAsset(name, image);
          this.uploadedCoverNames.set(url, name);
          return name;
        } catch (err) {
          errors.push(`presign: ${errText(err)}`);
        }
      }

      log('Обложка не загрузилась в портал (использую внешнюю ссылку):', errors.join(' | '));
      return null;
    } catch (err) {
      log('Обложка не загрузилась в портал (использую внешнюю ссылку):', errText(err));
      return null;
    }
  }

  /** Решает, какими ключами показывать картинки. */
  async resolveImages(track) {
    const images = {
      large: track.coverUrl || null,
      small: track.isPlaying ? PLAY_IMAGE_URL : PAUSE_IMAGE_URL
    };
    const portal = await this.ensurePortalKeys();
    if (portal) {
      images.small = track.isPlaying ? portal.play : portal.pause;
      if (!images.large) images.large = portal.logo;
    }
    const coverKey = await this.uploadCoverAsAsset(track.coverUrl);
    if (coverKey) images.large = coverKey;
    return images;
  }

  async update(track) {
    this.lastTrack = track;
    if (!this.connected || isClientIdMissing) return;
    try {
      const images = await this.resolveImages(track);
      const activity = buildActivity(track, images);
      if (!activity) return;
      this.sendActivity(activity);
    } catch (err) {
      log('Ошибка при отправке присутствия:', errText(err));
    }
  }

  /**
   * Отправка присутствия цепочкой вариантов: полный → без маленькой
   * иконки (если сборка Discord её не приняла) → без типа «Слушает»
   * (если сборка не знает LISTENING). Останавливаемся на первом принятом.
   */
  sendActivity(activity) {
    const stripSmall = (source) => {
      const copy = { ...source };
      delete copy.smallImageKey;
      delete copy.smallImageText;
      return copy;
    };

    let variants;
    if (this.degraded) {
      const flat = stripSmall(activity);
      variants = [
        { flat, listening: true },
        { flat, listening: false }
      ];
    } else {
      variants = [{ flat: activity, listening: true }];
      if (activity.smallImageKey) {
        variants.push({ flat: stripSmall(activity), listening: true });
      }
      variants.push({ flat: stripSmall(activity), listening: false });
    }

    const attempt = (index) => {
      if (index >= variants.length) {
        log('Discord отклонил все варианты присутствия.');
        return Promise.resolve();
      }
      const variant = variants[index];
      return this.client
        .request('SET_ACTIVITY', {
          pid: process.pid,
          activity: toRawActivity(variant.flat, variant.listening)
        })
        .then(() => {
          if (!this.sentOnce) {
            this.sentOnce = true;
            const mode = variant.listening ? '«Слушает VK Wave»' : '«Играет в VK Wave»';
            log(
              `Присутствие отправлено (${mode}). Обложка:`,
              variant.flat.largeImageKey ? String(variant.flat.largeImageKey).slice(0, 90) : 'нет'
            );
          }
        })
        .catch((err) => {
          const message = errText(err);
          if (index === 0 && !this.degraded && activity.smallImageKey) {
            this.degraded = true;
            log('Маленькая иконка отклонена — пробую без неё:', message);
          } else {
            log(`Вариант ${index + 1} отклонён (${message}) — пробую следующий…`);
          }
          return attempt(index + 1);
        });
    };

    attempt(0).catch((err) => log('Не удалось обновить присутствие:', errText(err)));
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

module.exports = { DiscordPresence, buildActivity };
