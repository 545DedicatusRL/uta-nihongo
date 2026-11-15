// 简单的 JSON 文件持久化：所有用户数据都放在 data/ 目录下。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const DATA = process.env.UTA_DATA || path.join(ROOT, 'data');

for (const d of ['', 'songs', 'lyrics', 'artwork', 'ai']) {
  fs.mkdirSync(path.join(DATA, d), { recursive: true });
}

export function dataPath(...rel) {
  return path.join(DATA, ...rel);
}

export function readJSON(rel, fallback) {
  try {
    return JSON.parse(fs.readFileSync(dataPath(rel), 'utf8'));
  } catch {
    return fallback;
  }
}

export function writeJSON(rel, obj) {
  const file = dataPath(rel);
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 1));
  fs.renameSync(tmp, file);
}

// 文件名安全化（歌曲 key、歌词源 id 等）
export function safeName(s) {
  return String(s).replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 80);
}

// ---- 设置 ----
const DEFAULT_SETTINGS = { apiKey: '', model: 'claude-opus-5-5' };
export function getSettings() {
  return { ...DEFAULT_SETTINGS, ...readJSON('settings.json', {}) };
}
export function saveSettings(patch) {
  const next = { ...getSettings(), ...patch };
  writeJSON('settings.json', next);
  return next;
}

// ---- 每首歌的元数据：时间偏移、歌词源选择、读音修正 ----
// hiddenAnn：这首歌里被用户关掉的标注（'v:单词' / 'g:语法点'）
// senses：这首歌里用户手动指定的义项（'v:单词' → 义项原文）
const DEFAULT_SONG = { offset: 0, source: null, readings: {}, wordReadings: {}, hiddenAnn: [], senses: {} };
export function getSongMeta(key) {
  return { ...DEFAULT_SONG, ...readJSON(`songs/${safeName(key)}.json`, {}) };
}
export function saveSongMeta(key, patch) {
  const next = { ...getSongMeta(key), ...patch };
  writeJSON(`songs/${safeName(key)}.json`, next);
  return next;
}

// ---- 全局读音词典（用户修正过的「汉字 → 读音」）----
export function getUserDict() {
  return readJSON('userdict.json', {});
}
export function saveUserDict(d) {
  writeJSON('userdict.json', d);
}

// ---- 词汇书 ----
export function getVocab() {
  return readJSON('vocab.json', []);
}
export function saveVocab(list) {
  writeJSON('vocab.json', list);
}
