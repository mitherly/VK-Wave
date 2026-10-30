'use strict';

/**
 * VK Wave — опциональная загрузка Rich Presence-ассетов в приложение Discord.
 *
 * ВАЖНО: VK Wave работает и без этого скрипта — discord.js передаёт иконки
 * напрямую внешними URL (это официально поддерживается RPC, см.
 * github.com/discord/discord-api-docs/discussions/6592), а при заданном
 * DISCORD_BOT_TOKEN приложение заливает ассеты в портал автоматически.
 * Скрипт нужен, чтобы сделать это вручную/отдельно.
 *
 * Discord не документирует API ассетов: используется эндпоинт
 * /api/v9/applications/{id}/assets с актуальным двухшаговым флоу:
 *   1) POST /assets/upload → пресдейл-ссылка (upload_url + upload_filename);
 *   2) PUT байтов файла в GCP-бакет Discord;
 *   3) POST /assets с { key, uploaded_filename } — регистрация ассета.
 * Эндпоинт неофициальный и может измениться.
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

/** Дискорд-ассеты через REST (недокументированный эндпоинт v9). */
async function apiRequest(method, url, token, body) {
  let response;
  try {
    response = await fetch(url, {
      method,
      headers: {
        Authorization: `Bot ${token}`,
        ...(body ? { 'Content-Type': 'application/json' } : {})
      },
      body: body ? JSON.stringify(body) : undefined
    });
  } catch (err) {
    throw new Error(`Сеть недоступна (${err && err.message ? err.message : err})`);
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

/** Двухшаговая загрузка: пресдейл → PUT в бакет → регистрация ассета. */
async function uploadAsset(token, name, image) {
  const filename = `${name}.${image.ext}`;

  // Шаг 1: пресдейл-ссылка.
  const uploadResponse = await apiRequest('POST', `${API_BASE}/upload`, token, {
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
  return apiRequest('POST', API_BASE, token, {
    key: name,
    uploaded_filename: attachment.upload_filename
  });
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

  let existing = [];
  try {
    existing = await apiRequest('GET', API_BASE, token);
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
    try {
      await uploadAsset(token, asset.key, fileToImage(asset.file));
      log(`✓ ${asset.key}: загружен из ${path.basename(asset.file)}`);
      uploaded += 1;
      await sleep(400);
    } catch (err) {
      log(`✗ ${asset.key}: ${err.message}`);
      failed += 1;
    }
  }

  log(`Готово. Загружено: ${uploaded}, пропущено: ${skipped}, ошибок: ${failed}.`);
  log('Проверить можно на вкладке Rich Presence → Art Assets портала разработчика.');
  if (failed > 0) process.exitCode = 1;
}

main();
