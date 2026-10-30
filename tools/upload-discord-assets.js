'use strict';

/**
 * VK Wave — опциональная загрузка Rich Presence-ассетов в приложение Discord.
 *
 * ВАЖНО: VK Wave работает и без этого скрипта — discord.js передаёт иконки
 * напрямую внешними URL (это официально поддерживается RPC, см.
 * github.com/discord/discord-api-docs/discussions/6592). Скрипт нужен только
 * если хочется видеть арты в самом хранилище приложения (вкладка
 * Rich Presence → Art Assets портала).
 *
 * Discord не документирует API загрузки ассетов: скрипт использует
 * недокументированный эндпоинт /api/v9/applications/{id}/assets и пробует
 * несколько форматов тела (JSON с data URI → multipart с полем → multipart
 * с файлом), пока один не сработает. Эндпоинт неофициальный и может измениться.
 *
 * Требуется токен бота вашего приложения:
 *   Discord Developer Portal → ваше приложение → вкладка «Bot» → Reset Token.
 *
 * Запуск (токен НЕ коммитьте и не публикуйте нигде):
 *   Windows (cmd):  set DISCORD_BOT_TOKEN=ваш_токен && npm run upload:assets
 *   PowerShell:     $env:DISCORD_BOT_TOKEN="ваш_токен"; npm run upload:assets
 *   Linux/macOS:    DISCORD_BOT_TOKEN=ваш_токен npm run upload:assets
 *   Без переменной окружения скрипт спросит токен интерактивно.
 *
 * Повторный запуск безопасен: уже существующие ассеты пропускаются.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { CLIENT_ID } = require('../discord');

const API_BASE = `https://discord.com/api/v9/applications/${CLIENT_ID}/assets`;

/** Что загружаем: ключ в Discord → локальный файл. */
const ASSETS = [
  { key: 'logo', file: path.join(__dirname, '..', 'assets', 'logo.png') },
  { key: 'play', file: path.join(__dirname, '..', 'assets', 'play.png') },
  { key: 'pause', file: path.join(__dirname, '..', 'assets', 'pause.png') }
];

function log(...args) {
  console.log('[VK Wave · assets]', ...args);
}

async function askToken() {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => {
    rl.question('Вставьте токен бота и нажмите Enter: ', resolve);
  });
  rl.close();
  return answer.trim();
}

/**
 * Единая обёртка над fetch: возвращает { status, json } и человеческое
 * сообщение об ошибке. Body — готовый объект fetch (JSON-заголовки ставим сами
 * только для JSON-стратегий, чтобы не мешать FormData).
 */
async function request(method, url, token, body, isJson) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: { Authorization: `Bot ${token}` },
      body
    });
  } catch (err) {
    throw new Error(`Сеть недоступна (${err && err.message ? err.message : err})`);
  }

  const raw = await response.text();
  let json = null;
  try {
    json = raw ? JSON.parse(raw) : null;
  } catch (_) {
    json = null;
  }

  if (!response.ok) {
    const apiMessage = json && json.message ? json.message : raw.slice(0, 200);
    const err = new Error(`HTTP ${response.status}: ${apiMessage}`);
    err.status = response.status;
    throw err;
  }
  return json || [];
}

/** Стратегии формата тела POST — от самой простой к самой экзотичной. */
const UPLOAD_STRATEGIES = [
  {
    name: 'JSON + data URI',
    send: (token, name, dataUri) =>
      request(
        'POST',
        API_BASE,
        token,
        JSON.stringify({ name, image: dataUri }),
        true
      )
  },
  {
    name: 'multipart, image как поле (data URI)',
    send: (token, name, dataUri) => {
      const form = new FormData();
      form.append('name', name);
      form.append('image', dataUri);
      return request('POST', API_BASE, token, form, false);
    }
  },
  {
    name: 'multipart, image как файл',
    send: (token, name, dataUri, filePath) => {
      const form = new FormData();
      form.append('name', name);
      form.append(
        'image',
        new Blob([fs.readFileSync(filePath)], { type: 'image/png' }),
        path.basename(filePath)
      );
      return request('POST', API_BASE, token, form, false);
    }
  }
];

function toDataUri(filePath) {
  const data = fs.readFileSync(filePath);
  if (data.length > 8 * 1024 * 1024) {
    throw new Error(`${path.basename(filePath)} больше 8 МБ — Discord такое не примет`);
  }
  return `data:image/png;base64,${data.toString('base64')}`;
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const argToken = process.argv.find((arg) => arg.startsWith('--token='));
  let token = process.env.DISCORD_BOT_TOKEN || (argToken ? argToken.slice('--token='.length) : '');
  token = (token || '').trim();

  if (!token) {
    log('DISCORD_BOT_TOKEN не задан — спросим в интерактивном режиме.');
    token = await askToken();
  }
  if (!token) {
    log('Токен пустой — выходим.');
    process.exitCode = 1;
    return;
  }

  log(`Приложение: ${CLIENT_ID}`);
  log('Rich Presence работает и без загрузки — скрипт нужен только для хранилища портала.');

  let existing = [];
  try {
    existing = await request('GET', API_BASE, token);
  } catch (err) {
    if (err.status === 401) {
      log('Ошибка 401: токен неверный или сброшен. Возьмите свежий на вкладке «Bot» портала.');
    } else if (err.status === 403) {
      log(`Ошибка 403: бот не имеет доступа к ассетам приложения ${CLIENT_ID}. Проверьте, что токен именно от него.`);
    } else {
      log('Не удалось получить список ассетов:', err.message);
    }
    process.exitCode = 1;
    return;
  }

  const existingNames = new Set(existing.map((asset) => asset.name));
  log(`В приложении уже ${existing.length} ассет(ов): ${[...existingNames].join(', ') || '—'}`);

  let uploaded = 0;
  let skipped = 0;
  let failed = 0;
  let workingStrategy = 0; // найденный формат переиспользуем для остальных файлов

  for (const asset of ASSETS) {
    if (!fs.existsSync(asset.file)) {
      log(`✗ ${asset.key}: файл не найден (${asset.file})`);
      failed += 1;
      continue;
    }
    if (existingNames.has(asset.key)) {
      log(`• ${asset.key}: уже загружен, пропускаю.`);
      skipped += 1;
      continue;
    }

    const dataUri = toDataUri(asset.file);
    let done = false;

    for (let s = workingStrategy; s < UPLOAD_STRATEGIES.length; s += 1) {
      const strategy = UPLOAD_STRATEGIES[s];
      try {
        await strategy.send(token, asset.key, dataUri, asset.file);
        log(`✓ ${asset.key}: загружен (${strategy.name})`);
        workingStrategy = s;
        uploaded += 1;
        done = true;
        await sleep(400);
        break;
      } catch (err) {
        if (err.status === 401 || err.status === 403) {
          log(`✗ ${asset.key}: ${err.message} — дальше пробовать нет смысла.`);
          process.exitCode = 1;
          return;
        }
        if (s === UPLOAD_STRATEGIES.length - 1) {
          log(`✗ ${asset.key}: ни один формат не принят (последняя ошибка: ${err.message}).`);
          log('  Эндпоинт неофициальный — Discord мог его изменить. Арты в RPC всё равно работают');
          log('  через внешние URL, а в портал их можно загрузить вручную (Rich Presence → Art Assets).');
        } else {
          log(`· ${asset.key}: формат «${strategy.name}» отклонён (${err.message}), пробую следующий…`);
        }
      }
    }

    if (!done) failed += 1;
  }

  log(`Готово. Загружено: ${uploaded}, пропущено: ${skipped}, ошибок: ${failed}.`);
  if (failed > 0) process.exitCode = 1;
}

main();
