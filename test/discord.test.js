'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { buildActivity, CLIENT_ID } = require('../discord');

const track = {
  title: 'Группа крови',
  artist: 'Кино',
  coverUrl: 'https://example.com/cover.jpg',
  isPlaying: true,
  currentTime: 33,
  duration: 135
};

test('CLIENT_ID экспортируется (нужен tools/upload-discord-assets.js)', () => {
  assert.match(String(CLIENT_ID), /^\d{17,20}$/);
});

test('buildActivity заполняет трек, картинки и таймстемпы', () => {
  const activity = buildActivity(track, {
    large: 'cover_abc',
    small: 'play'
  });

  assert.equal(activity.details, 'Группа крови');
  assert.equal(activity.state, 'Кино');
  assert.equal(activity.largeImageKey, 'cover_abc');
  assert.equal(activity.smallImageKey, 'play');
  assert.equal(activity.largeImageText, '0:33 / 2:15');
  assert.ok(Number.isFinite(activity.startTimestamp));
  assert.ok(Number.isFinite(activity.endTimestamp));
  assert.ok(activity.endTimestamp > activity.startTimestamp);
});

test('buildActivity на паузе не ставит таймстемпы', () => {
  const activity = buildActivity({ ...track, isPlaying: false }, { large: 'cover_abc' });
  assert.equal(activity.startTimestamp, undefined);
  assert.equal(activity.endTimestamp, undefined);
  assert.equal(activity.smallImageText, undefined);
});

test('buildActivity не ставит несуществующие ассеты (никаких «?»)', () => {
  const activity = buildActivity(track, { large: null, small: null });
  assert.equal(activity.largeImageKey, undefined);
  assert.equal(activity.smallImageKey, undefined);
  assert.equal(activity.largeImageText, undefined);
});

test('buildActivity использует внешнюю обложку как largeImageKey', () => {
  const activity = buildActivity(track, { large: track.coverUrl, small: null });
  assert.equal(activity.largeImageKey, track.coverUrl);
});

test('buildActivity возвращает null для пустого трека', () => {
  assert.equal(buildActivity(null), null);
  assert.equal(buildActivity({}), null);
});
