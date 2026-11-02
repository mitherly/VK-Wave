'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  defaultSettings,
  normalizeSettings,
  mergeSettings
} = require('../shared/settings');
const { THEME_PRESETS } = require('../shared/theme');

test('defaultSettings возвращает свежую копию', () => {
  const a = defaultSettings();
  const b = defaultSettings();
  assert.deepEqual(a, b);
  assert.notEqual(a, b);
  assert.notEqual(a.theme, b.theme);
});

test('normalizeSettings переживает мусор вместо JSON-объекта', () => {
  assert.deepEqual(normalizeSettings(null), defaultSettings());
  assert.deepEqual(normalizeSettings('oops'), defaultSettings());
  assert.deepEqual(normalizeSettings([]), defaultSettings());
});

test('normalizeSettings принимает только валидные значения', () => {
  const settings = normalizeSettings({
    musicOnly: false,
    discordRpc: false,
    autoLaunch: 'yes',
    backgroundMaterial: 'evil',
    theme: { preset: 'sakura' }
  });

  assert.equal(settings.musicOnly, false);
  assert.equal(settings.discordRpc, false);
  assert.equal(settings.autoLaunch, false);
  assert.equal(settings.backgroundMaterial, 'none');
  assert.equal(settings.theme.preset, 'sakura');
  assert.equal(settings.theme.background, THEME_PRESETS.sakura.background);
});

test('mergeSettings игнорирует неизвестные ключи и неверные типы', () => {
  const current = defaultSettings();
  const next = mergeSettings(current, {
    musicOnly: false,
    hotkeys: 'false',
    backgroundMaterial: 'acid',
    hacker: true
  });

  assert.equal(next.musicOnly, false);
  assert.equal(next.hotkeys, current.hotkeys);
  assert.equal(next.backgroundMaterial, current.backgroundMaterial);
  assert.equal(next.hacker, undefined);
});

test('mergeSettings переключает пресет вместе с его цветами', () => {
  const current = defaultSettings();
  const next = mergeSettings(current, { theme: { preset: 'emerald' } });

  assert.deepEqual(next.theme, {
    ...THEME_PRESETS.emerald,
    preset: 'emerald'
  });
  // исходный объект не мутирован
  assert.equal(current.theme.preset, 'default');
});

test('mergeSettings сохраняет кастомные цвета при preset=custom', () => {
  const current = defaultSettings();
  const next = mergeSettings(current, {
    theme: { preset: 'custom', accent: '#12ab34', radius: 4 }
  });

  assert.equal(next.theme.preset, 'custom');
  assert.equal(next.theme.accent, '#12ab34');
  assert.equal(next.theme.radius, 4);
  assert.equal(next.theme.background, current.theme.background);
});

test('mergeSettings отбрасывает CSS-инъекции в цветах', () => {
  const current = defaultSettings();
  const next = mergeSettings(current, {
    theme: { preset: 'custom', background: 'url(javascript:alert(1))' }
  });

  assert.equal(next.theme.background, current.theme.background);
});
