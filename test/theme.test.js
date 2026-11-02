'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  THEME_PRESETS,
  isHexColor,
  isLightColor,
  sanitizeTheme,
  sanitizeThemePatch
} = require('../shared/theme');

test('все 15 пресетов на месте и содержат полный набор полей', () => {
  assert.equal(Object.keys(THEME_PRESETS).length, 15);
  for (const [name, theme] of Object.entries(THEME_PRESETS)) {
    assert.match(theme.background, /^#[0-9a-f]{6}$/i, `${name}.background`);
    assert.match(theme.cards, /^#[0-9a-f]{6}$/i, `${name}.cards`);
    assert.match(theme.accent, /^#[0-9a-f]{6}$/i, `${name}.accent`);
    assert.equal(typeof theme.radius, 'number');
  }
});

test('isHexColor принимает только #rrggbb', () => {
  assert.equal(isHexColor('#0077ff'), true);
  assert.equal(isHexColor('#0077FF'), true);
  assert.equal(isHexColor('0077ff'), false);
  assert.equal(isHexColor('#fff'), false);
  assert.equal(isHexColor('red'), false);
  assert.equal(isHexColor(null), false);
});

test('isLightColor различает светлый и тёмный фон', () => {
  assert.equal(isLightColor('#ffffff'), true);
  assert.equal(isLightColor('#edeef0'), true);
  assert.equal(isLightColor('#000000'), false);
  assert.equal(isLightColor('#141414'), false);
  assert.equal(isLightColor('#not-a-color'), false);
});

test('sanitizeThemePatch отбрасывает мусор и нормализует значения', () => {
  const clean = sanitizeThemePatch({
    preset: 'sakura',
    background: '#ABCDEF',
    cards: 'javascript:alert(1)',
    accent: 'url(evil)',
    radius: 999,
    unknown: 'ignored'
  });

  assert.deepEqual(clean, {
    preset: 'sakura',
    background: '#abcdef',
    radius: 32
  });
});

test('sanitizeThemePatch не пропускает неизвестный пресет', () => {
  assert.deepEqual(sanitizeThemePatch({ preset: 'evil-theme' }), {});
});

test('sanitizeThemePatch игнорирует пустой radius вместо превращения в 0', () => {
  assert.deepEqual(sanitizeThemePatch({ radius: null }), {});
  assert.deepEqual(sanitizeThemePatch({ radius: '' }), {});
  assert.deepEqual(sanitizeThemePatch({ radius: '12' }), { radius: 12 });
});

test('sanitizeTheme подставляет цвета выбранного пресета', () => {
  const theme = sanitizeTheme({ preset: 'sakura' });
  assert.equal(theme.preset, 'sakura');
  assert.equal(theme.background, THEME_PRESETS.sakura.background);
  assert.equal(theme.accent, THEME_PRESETS.sakura.accent);
});

test('sanitizeTheme сохраняет кастомные цвета поверх пресета', () => {
  const theme = sanitizeTheme({ preset: 'oled', accent: '#12ab34', radius: 4 });
  assert.equal(theme.preset, 'oled');
  assert.equal(theme.background, THEME_PRESETS.oled.background);
  assert.equal(theme.accent, '#12ab34');
  assert.equal(theme.radius, 4);
});

test('sanitizeTheme без аргументов возвращает дефолтную тему', () => {
  assert.deepEqual(sanitizeTheme(null), {
    ...THEME_PRESETS.default,
    preset: 'default'
  });
});
