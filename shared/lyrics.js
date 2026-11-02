'use strict';

/** Чистим мусор из названий, который сбивает поиск LRCLIB. */
function cleanLyricsQuery(value) {
  return String(value || '')
    .replace(/\s*\((?:feat|ft|with|prod)[^)]*\)/gi, '')
    .replace(/\s*\[[^\]]*\]/g, '')
    .replace(/\s*[-–—]\s*(?:remix|cover|live|acoustic|radio edit|instrumental).*$/i, '')
    .replace(/\s+(?:feat|ft)\.?\s+.*$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}

module.exports = { cleanLyricsQuery };
