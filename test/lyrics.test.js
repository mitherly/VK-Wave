'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { cleanLyricsQuery } = require('../shared/lyrics');

test('cleanLyricsQuery убирает feat в скобках', () => {
  assert.equal(
    cleanLyricsQuery('The Weeknd (feat. Daft Punk)'),
    'The Weeknd'
  );
});

test('cleanLyricsQuery убирает квадратные скобки и remix-суффикс', () => {
  assert.equal(
    cleanLyricsQuery('Song [Official Video] - Remix'),
    'Song'
  );
});

test('cleanLyricsQuery убирает feat без скобок', () => {
  assert.equal(
    cleanLyricsQuery('Artist feat. Another Artist'),
    'Artist'
  );
});

test('cleanLyricsQuery не ломает обычные названия', () => {
  assert.equal(cleanLyricsQuery('  Кино — Группа крови  '), 'Кино — Группа крови');
  assert.equal(cleanLyricsQuery(null), '');
});
