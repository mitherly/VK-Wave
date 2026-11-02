'use strict';

const {
  THEME_PRESETS,
  MATERIALS,
  sanitizeTheme,
  sanitizeThemePatch
} = require('./theme');

const DEFAULT_SETTINGS = {
  musicOnly: true,   // «Только музыка»: редирект на /music + скрытие лишнего ВК
  hotkeys: true,     // Space — пауза, Ctrl+←/→ — треки, L — текст песни
  autoLaunch: false, // запускать с Windows
  startInTray: false, // стартовать свёрнутым в трей
  trayCover: true,   // иконка трея = обложка текущего трека
  blockTrackers: true, // резать рекламу/метрики ВК на подлёте
  ambientCover: true,  // размытая обложка фоном окна
  vinylMode: false,    // обложка-винил: вращается, пока играет
  accentFromCover: false, // акцент темы подмешивается из цвета обложки
  autoDayNight: false, // авто-тема: день light / ночь midnight
  discordRpc: true,    // показывать трек в Discord Rich Presence
  globalHotkeys: false,        // глобальные горячие клавиши (Ctrl+Alt+Space и т.п.)
  trackNotifications: false,   // Toast-уведомления при смене трека
  customBackground: '',        // путь или dataURL кастомной картинки фона
  secretAnimeUnlocked: false,  // разблокирована ли секретная тема
  crossfadeDuration: 0,        // кроссфейд между треками в секундах (0 - выкл, 1-5 сек)
  smartResume: true,           // запоминание позиции трека
  eqEnabled: false,            // эквалайзер
  eqPreset: 'flat',            // flat | bass | rock | vocal | electronic
  eqGains: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0], // дБ для 10 полос
  audioVisualizer: true,       // живая волна спектра в тайтлбаре
  backgroundMaterial: 'none', // none | mica | acrylic (Win11)
  theme: {
    ...THEME_PRESETS.default,
    preset: 'default'
  }
};

const BOOLEAN_SETTING_KEYS = [
  'musicOnly',
  'hotkeys',
  'autoLaunch',
  'startInTray',
  'trayCover',
  'blockTrackers',
  'ambientCover',
  'vinylMode',
  'accentFromCover',
  'autoDayNight',
  'discordRpc',
  'globalHotkeys',
  'trackNotifications',
  'secretAnimeUnlocked',
  'smartResume',
  'eqEnabled',
  'audioVisualizer'
];

function defaultSettings() {
  return { ...DEFAULT_SETTINGS, theme: { ...DEFAULT_SETTINGS.theme } };
}

/** Валидирует прочитанный с диска JSON — битый файл не должен ломать запуск. */
function normalizeSettings(raw) {
  const next = defaultSettings();
  if (!raw || typeof raw !== 'object') return next;
  for (const key of BOOLEAN_SETTING_KEYS) {
    if (typeof raw[key] === 'boolean') next[key] = raw[key];
  }
  if (MATERIALS.has(raw.backgroundMaterial)) next.backgroundMaterial = raw.backgroundMaterial;
  if (typeof raw.customBackground === 'string') next.customBackground = raw.customBackground;
  if (typeof raw.crossfadeDuration === 'number' && Number.isFinite(raw.crossfadeDuration)) {
    next.crossfadeDuration = Math.max(0, Math.min(5, Math.round(raw.crossfadeDuration)));
  }
  if (typeof raw.eqPreset === 'string') next.eqPreset = raw.eqPreset;
  if (Array.isArray(raw.eqGains) && raw.eqGains.length === 10) {
    next.eqGains = raw.eqGains.map(g => Number.isFinite(Number(g)) ? Math.max(-12, Math.min(12, Number(g))) : 0);
  }
  if (raw.theme && typeof raw.theme === 'object') {
    // Не подмешиваем дефолтные цвета: иначе они перебьют цвета пресета.
    next.theme = sanitizeTheme(raw.theme);
  }
  return next;
}

/** Применяет только известные ключи и валидные значения. */
function mergeSettings(current, patch) {
  const next = { ...current };
  if (!patch || typeof patch !== 'object') return next;

  for (const key of BOOLEAN_SETTING_KEYS) {
    if (typeof patch[key] === 'boolean') next[key] = patch[key];
  }
  if (MATERIALS.has(patch.backgroundMaterial)) {
    next.backgroundMaterial = patch.backgroundMaterial;
  }
  if (typeof patch.customBackground === 'string') {
    next.customBackground = patch.customBackground;
  }
  if (typeof patch.crossfadeDuration === 'number' && Number.isFinite(patch.crossfadeDuration)) {
    next.crossfadeDuration = Math.max(0, Math.min(5, Math.round(patch.crossfadeDuration)));
  }
  if (typeof patch.eqPreset === 'string') {
    next.eqPreset = patch.eqPreset;
  }
  if (Array.isArray(patch.eqGains) && patch.eqGains.length === 10) {
    next.eqGains = patch.eqGains.map(g => Number.isFinite(Number(g)) ? Math.max(-12, Math.min(12, Number(g))) : 0);
  }
  if (patch.theme && typeof patch.theme === 'object') {
    const themePatch = sanitizeThemePatch(patch.theme);
    const presetBase = themePatch.preset ? THEME_PRESETS[themePatch.preset] : null;
    next.theme = presetBase
      ? { ...presetBase, ...themePatch }
      : { ...current.theme, ...themePatch };
  }
  return next;
}

module.exports = {
  DEFAULT_SETTINGS,
  BOOLEAN_SETTING_KEYS,
  defaultSettings,
  normalizeSettings,
  mergeSettings
};
