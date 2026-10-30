'use strict';

/**
 * VK Wave — автоматическая загрузка Rich Presence-ассетов в приложение Discord.
 *
 * Загружает assets/logo.png, assets/play.png и assets/pause.png в хранилище
 * ассетов вашего приложения (ключи: «logo», «play», «pause») через Discord API,
 * чтобы не кликать их вручную на вкладке Rich Presence → Art Assets.
 *
 * Требуется токен бота вашего приложения:
 *   1. Discord Developer Portal → ваше приложение → вкладка «Bot»
 *      (https://discord.com/developers/applications/1565753930418233544/bot)
 *   2. Reset Token → скопировать токен.
 *
 * Запуск (токен НЕ коммитьте и не публикуйте нигде):
 *   Windows (cmd):  set DISCORD_BOT_TOKEN=ваш_токен && npm run upload:assets
 *   PowerShell:     $env:DISCORD_BOT_TOKEN="ваш_токен"; npm run upload:assets
 *   Linux/macOS:    DISCORD_BOT_TOKEN=ваш_токен npm run upload:assets
 *
 * Повторный запуск безопасен: уже существующие ассеты пропускаются.
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline');

const { CLIENT_ID } = require('../discord');

const API_BASE = `https://discord.com/api/v10/applications/${CLIENT_ID}/assets`;

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

/** Discord API возвращает JSON; оборачиваем ошибки в понятные сообщения. */
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

  let existing = [];
  try {
    existing = await apiRequest('GET', API_BASE, token);
  } catch (err) {
    if (err.status === 401) {
      log('Ошибка 401: токен неверный или сброшен. Возьмите свежий на вкладке «Bot» портала.');
    } else if (err.status === 403) {
      log('Ошибка 403: бот не имеет доступа к ассетам этого приложения. Убедитесь, что токен именно от приложения ' + CLIENT_ID + '.');
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
      const image = toDataUri(asset.file);
      await apiRequest('POST', API_BASE, token, { name: asset.key, image });
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
