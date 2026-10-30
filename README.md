<div align="center">

<img src="assets/hero.jpg" alt="VK Wave — баннер проекта" width="100%">

# 🌊 VK Wave

**Стильный десктоп-клиент для «VK Музыки» с Discord Rich Presence, медиа-клавишами и системным треем.**

![Electron](https://img.shields.io/badge/Electron-45-47848F?style=for-the-badge&logo=electron&logoColor=white)
![Discord RPC](https://img.shields.io/badge/Discord_RPC-5865F2?style=for-the-badge&logo=discord&logoColor=white)
![Windows](https://img.shields.io/badge/Windows-10%20%7C%2011-0078D6?style=for-the-badge&logo=windows&logoColor=white)
![Linux](https://img.shields.io/badge/Linux-FCC624?style=for-the-badge&logo=linux&logoColor=black)
![macOS](https://img.shields.io/badge/macOS-000000?style=for-the-badge&logo=apple&logoColor=white)
![License](https://img.shields.io/badge/License-MIT-3FB950?style=for-the-badge)

[Установка](#-быстрый-старт) • [Discord RPC](#-как-настроить-discord-rich-presence) • [Сборка .exe](#-сборка-в-exe) • [Лицензия](#-лицензия)

</div>

## 📖 О проекте

**VK Wave** — лёгкая Electron-обёртка над веб-версией **vk.com/music**, которая превращает браузерный плеер в полноценное десктопное приложение: нативное тёмное окно без белой рамки Windows, управление из системного трея, аппаратные медиа-клавиши и живой статус в Discord с обложкой трека и прогресс-баром.

## ✨ Возможности

- 🎧 **Музыка VK в отдельном окне** — никакой лишней вкладки браузера, нативное тёмное оформление с `titleBarOverlay` (#141414, белые кнопки управления окном).
- 🎮 **Discord Rich Presence** — название трека, исполнитель, обложка, иконка play/pause, живой прогресс-бар и две кнопки: «Слушать в VK Музыке» и «Скачать VK Wave».
- ⌨️ **Медиа-клавиши и оверлей Windows 10/11** — Play/Pause/Next/Prev с клавиатуры и наушников через MediaSession API Chromium, нативный медиа-оверлей ОС с обложкой.
- 📌 **Системный трей** — крестик сворачивает приложение в трей (а не закрывает), контекстное меню: Слушать/Пауза, Следующий/Предыдущий трек, Развернуть, Выход.
- 🔐 **Сохранение сессии** — cookies хранятся в изолированном разделе `persist:vkwave`, логиниться нужно всего один раз.
- 🔁 **Автопереподключение к Discord** — если клиент Discord закрыли, VK Wave сам переподключается каждые 15 секунд.
- 🚀 **Один экземпляр приложения** — повторный запуск просто разворачивает уже открытое окно.
- 🛡 **Безопасность** — `contextIsolation`, без `nodeIntegration`; внешние ссылки открываются в системном браузере.

## ⚠️ Важное примечание про подписку

VK Wave — это **удобная десктопная обёртка** с Discord RPC и системной интеграцией. Клиент **не обходит** серверные ограничения VK: рекламу, лимиты прослушиваний и прочие условия определяет сам ВК на своей стороне.

Для комфортного прослушивания без ограничений (неограниченные прослушивания, фоновый режим, офлайн) рекомендуется активная подписка **VK Музыка / VK Mix**. VK Wave лишь делает использование подписки приятнее на десктопе.

> Проект не аффилирован с ООО «ВК» и не является официальным клиентом.

## 🧩 Архитектура

```
vk-wave/
├── assets/          # hero.jpg (баннер README), logo.png / logo.ico (иконка)
├── main.js          # Главный процесс: окно, titleBarOverlay, трей, IPC, сессия
├── preload.js       # Перехватчик плеера: MediaSession + DOM + MutationObserver
├── discord.js       # Discord Rich Presence (@xhayper/discord-rpc)
├── package.json     # Зависимости и конфиг electron-builder
└── README.md
```

Как это работает: `preload.js` в изолированном контексте страницы читает состояние плеера (название, исполнитель, обложка, пауза, время) и через `ipcRenderer.send('track-update', …)` передаёт его в `main.js`, который обновляет Discord-присутствие и меню трея. Команды из трея и медиа-клавиши идут обратным путём и «нажимают» кнопки плеера VK.

## 🚀 Быстрый старт

**Требования:** [Node.js](https://nodejs.org/) 18+ и Git.

```bash
# 1. Клонируем репозиторий
git clone https://github.com/mitherly/VK-Wave.git
cd vk-wave

# 2. Устанавливаем зависимости
npm install

# 3. Запускаем
npm start
```

При первом запуске войдите в аккаунт VK в открывшемся окне — сессия сохранится, и в следующий раз VK Wave откроется сразу с музыкой.

## 🎮 Как настроить свой Discord Rich Presence

1. Зайдите на [Discord Developer Portal](https://discord.com/developers/applications) и нажмите **New Application**.
2. Задайте имя приложения — **VK Wave** (оно будет отображаться в профиле как название «игры») — и сохраните.
3. На вкладке **General Information** скопируйте **Application ID**.
4. Откройте файл `discord.js` и вставьте ID вместо заглушки:

   ```js
   const CLIENT_ID = 'ВАШ_APPLICATION_ID';
   ```

5. *(Опционально, для красивых картинок)* На вкладке **Rich Presence → Visual Assets** загрузите арты и запомните их ключи:
   - `logo` — логотип VK Wave (подойдёт `assets/logo.png`) — показывается, если у трека нет обложки;
   - `play` — иконка воспроизведения;
   - `pause` — иконка паузы.

   > Обложка текущего трека подхватывается автоматически — прямой ссылкой, загружать её не нужно.
6. Перезапустите VK Wave. **Клиент Discord должен быть запущен.**

Готово — откройте свой профиль в Discord и наслаждайтесь видом 🎶

## 📦 Сборка в .exe

Сборка выполняется через [electron-builder](https://www.electron.build/):

```bash
# Установщик NSIS (dist/VK Wave Setup 1.0.0.exe)
npm run dist

# Портативная версия (один .exe без установки)
npm run dist:portable
```

Готовый файл появится в папке `dist/`. Конфигурация сборки (иконка, цели Windows/Linux/macOS) лежит в секции `build` файла `package.json`.

## 🛠 Возможные проблемы

| Проблема | Решение |
| --- | --- |
| Статус в Discord не появляется | Убедитесь, что запущен **десктопный** клиент Discord и в `discord.js` указан верный Application ID. |
| В профиле нет обложки/иконок play-pause | Загрузите арты `logo`, `play`, `pause` в Discord Developer Portal (шаг 5 гайда выше). Обложка трека появляется автоматически после первого трека. |
| Discord закрылся — статус пропал | Это нормально: VK Wave сам переподключится в течение 15 секунд после запуска Discord. |
| Не сохраняется вход в VK | Не удаляйте папку `appdata` профиля Electron (`persist:vkwave` хранит сессию). |
| Медиа-клавиши не работают | Нажмите play в самом приложении один раз — Chromium зарегистрирует сессию в ОС. |

## 🤝 Участие в проекте

PR и идеи приветствуются! Перед пул-реквестом проверьте, что `npm start` работает, а код соответствует существующему стилю.

## 📄 Лицензия

Проект распространяется по лицензии [MIT](LICENSE).

---

<div align="center">

**VK Wave** — сделано с 🌊 и Electron. Не является официальным продуктом VK.

</div>
