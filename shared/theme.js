'use strict';

/**
 * VK Wave — единый источник тем и валидации настроек.
 *
 * Модуль используется главным процессом и тестами. Preload живёт в sandbox
 * (Electron 45 включает его по умолчанию) и не может require'ить локальные
 * файлы, поэтому получает THEME_PRESETS из main через IPC вместе с настройками.
 */

const THEME_PRESETS = Object.freeze({
  default: { background: '#141414', cards: '#1d1d22', accent: '#0077ff', radius: 16 },
  oled: { background: '#000000', cards: '#101014', accent: '#0077ff', radius: 14 },
  midnight: { background: '#0e1322', cards: '#172033', accent: '#5b8cff', radius: 18 },
  light: { background: '#edeef0', cards: '#ffffff', accent: '#0077ff', radius: 16 },
  sakura: { background: '#201622', cards: '#2b1f30', accent: '#ff7eb6', radius: 20 },
  anime: { background: '#120d1c', cards: '#1d152e', accent: '#ff4db8', radius: 18 },

  emerald: { background: '#0d1a13', cards: '#142520', accent: '#2ecc8f', radius: 16 },
  lavender: { background: '#171225', cards: '#221b33', accent: '#a78bfa', radius: 18 },
  amber: { background: '#1f1810', cards: '#2b2318', accent: '#ffb14a', radius: 16 },
  cyberpunk: { background: '#0b0f14', cards: '#131a24', accent: '#00ffd5', radius: 12 },
  ocean: { background: '#0b1b2a', cards: '#12283d', accent: '#38bdf8', radius: 18 },
  graphite: { background: '#161719', cards: '#1f2124', accent: '#8e9aab', radius: 10 },
  coffee: { background: '#191210', cards: '#241a15', accent: '#c98a5e', radius: 16 },
  neon: { background: '#0d0a14', cards: '#161022', accent: '#e34fd0', radius: 14 },
  halloween: { background: '#150d08', cards: '#221510', accent: '#ff7a1a', radius: 14 }
});

const THEME_PRESET_NAMES = new Set(['custom', ...Object.keys(THEME_PRESETS)]);
const HEX_COLOR_RE = /^#[0-9a-f]{6}$/i;

function isHexColor(value) {
  return typeof value === 'string' && HEX_COLOR_RE.test(value.trim());
}

/** Светлый ли фон — от этого зависит цвет текста и символов в title bar. */
function isLightColor(hexColor) {
  if (!isHexColor(hexColor)) return false;
  const int = parseInt(hexColor.trim().slice(1), 16);
  const r = (int >> 16) & 255;
  const g = (int >> 8) & 255;
  const b = int & 255;
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255 > 0.6;
}

/**
 * Валидирует присланный из renderer патч темы. Возвращает только известные
 * поля с корректными значениями — остальное молча отбрасывается.
 */
function sanitizeThemePatch(input) {
  const clean = {};
  if (!input || typeof input !== 'object') return clean;

  if (typeof input.preset === 'string' && THEME_PRESET_NAMES.has(input.preset)) {
    clean.preset = input.preset;
  }
  for (const key of ['background', 'cards', 'accent']) {
    if (isHexColor(input[key])) clean[key] = input[key].trim().toLowerCase();
  }
  const rawRadius = input.radius;
  const hasRadius =
    (typeof rawRadius === 'number' && Number.isFinite(rawRadius)) ||
    (typeof rawRadius === 'string' && rawRadius.trim() !== '' && Number.isFinite(Number(rawRadius)));
  if (hasRadius) {
    clean.radius = Math.min(32, Math.max(0, Math.round(Number(rawRadius))));
  }
  return clean;
}

/** Полная тема: патч + значения пресета (или дефолт) для недостающих полей. */
function sanitizeTheme(input) {
  const patch = sanitizeThemePatch(input);
  const presetName = patch.preset && THEME_PRESETS[patch.preset] ? patch.preset : 'default';
  return {
    ...THEME_PRESETS.default,
    ...THEME_PRESETS[presetName],
    ...patch,
    preset: patch.preset || presetName
  };
}

const MATERIALS = new Set(['none', 'mica', 'acrylic']);

module.exports = {
  THEME_PRESETS,
  THEME_PRESET_NAMES,
  MATERIALS,
  isHexColor,
  isLightColor,
  sanitizeTheme,
  sanitizeThemePatch
};
