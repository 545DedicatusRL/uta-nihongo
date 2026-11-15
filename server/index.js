// 唱歌学日语 — 本地服务：静态页面 + API（只监听本机）
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import {
  ROOT, getSettings, saveSettings, getSongMeta, saveSongMeta,
  getUserDict, saveUserDict, getVocab, saveVocab,
} from './store.js';
import * as music from './music.js';
import { findCandidates, pickBest, fetchLyrics } from './lyrics.js';
import { analyzeLyrics, getTokenizer } from './japanese.js';
import { ensureDesktopShortcut } from './shortcut.js';
import { lookupWords, annotateWithAI, getAICache, aiAvailable, describeAIError } from './annotate.js';

const PORT = Number(process.env.PORT) || 3939;
const PUBLIC = path.join(ROOT, 'public');
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

// ---------------- 小工具 ----------------
function send(res, status, body, type = 'application/json; charset=utf-8') {
  const data = typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(data);
}
function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => { buf += c; if (buf.length > 2e6) req.destroy(); });
    req.on('end', () => { try { resolve(buf ? JSON.parse(buf) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });
}
const songKey = (track) => track.pid || 'h' + crypto.createHash('sha1').update(`${track.name}|${track.artist}`).digest('hex').slice(0, 16);
const slimCand = (c) => c && { source: c.source, id: c.id, songId: c.songId, title: c.title, artists: c.artists, album: c.album, duration: c.duration, cover: c.cover, score: c.score, flags: c.flags, auto: c.auto };

// ---------------- 歌曲载入：歌词 → 分词注音 → 语法/AI 标注 ----------------
function attachAI(lines, ai) {
  if (!ai) return;
  for (const line of lines) {
    const a = ai.byText[line.text];
    if (!a) continue;
    const range = (text) => {
      const at = line.text.indexOf(text);
      if (at < 0) return null;
      let start = -1, end = -1;
      line.tokens.forEach((tok, ti) => {
        if (tok.i0 < at + text.length && tok.i0 + tok.s.length > at) { if (start < 0) start = ti; end = ti + 1; }
      });
      return start < 0 ? null : { start, end };
    };
    line.ai = {
      grammar: a.grammar.map((g) => ({ n: g.pattern, lv: g.level, zh: g.explanation, text: g.text, ...range(g.text) })).filter((g) => g.start !== undefined),
      vocab: a.vocab.map((v) => ({ text: v.text, b: v.base, r: v.reading, lv: v.level, zh: v.meaning, ...range(v.text) })).filter((v) => v.start !== undefined),
    };
  }
}

async function loadSong(track, { refresh = false } = {}) {
  const key = songKey(track);
  const meta = getSongMeta(key);
  let cand = meta.source;
  let lyrics = null;
  let error = null;
  try {
    if (!cand || refresh) {
      const cands = await findCandidates(track);
      const best = await pickBest(cands);
      if (best) { cand = { ...slimCand(best), auto: true }; saveSongMeta(key, { source: cand }); }
      else cand = null;
    }
    if (cand) lyrics = await fetchLyrics(cand, refresh);
  } catch (e) { error = e.message; }

  const out = { key, track, source: cand, offset: meta.offset || 0, lines: [], error, aiAvailable: aiAvailable(), ai: false };
  if (!lyrics || !lyrics.lines.length) return out;
  out.flags = lyrics.flags;
  if (lyrics.flags.japanese) {
    const res = await analyzeLyrics(lyrics.lines, { kana: lyrics.kana, meta, userDict: getUserDict() });
    out.lines = res.lines;
    out.stats = res.stats;
    const ai = getAICache(`${cand.source}-${cand.id}`);
    if (ai) { attachAI(out.lines, ai); out.ai = true; }
  } else {
    out.lines = lyrics.lines.map((l) => ({ ...l, tokens: [{ s: l.text, i0: 0, b: l.text, pos: '', segs: [{ t: l.text }] }], grammar: [] }));
  }
  return out;
}

// ---------------- API 路由 ----------------
const sseClients = new Set();
music.player.on('state', (s) => {
  if (!sseClients.size) return;
  const msg = `data: ${JSON.stringify({ ...s, lag: Date.now() - s.ts })}\n\n`;
  for (const res of sseClients) res.write(msg);
});

const routes = {
  'GET /api/events': (req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-store', Connection: 'keep-alive' });
    res.write(`data: ${JSON.stringify(music.player.state)}\n\n`);
    sseClients.add(res);
    req.on('close', () => sseClients.delete(res));
  },
  'GET /api/library': async (req, res, q) => send(res, 200, await music.getLibrary(q.get('playlist') || '', q.has('refresh'))),
  'GET /api/playlists': async (req, res) => send(res, 200, await music.getPlaylists()),
  'GET /api/artwork': async (req, res, q) => {
    if (process.env.UTA_NO_MUSIC) return send(res, 404, { error: 'no music' });
    const art = await music.getArtwork(q.get('pid') || '', q.has('current'));
    if (!art) return send(res, 404, { error: 'no artwork' });
    res.writeHead(200, { 'Content-Type': art.type, 'Cache-Control': 'max-age=86400' });
    fs.createReadStream(art.file).pipe(res);
  },
  'POST /api/control': async (req, res) => {
    const { cmd, a, b } = await readBody(req);
    await music.control(cmd, a ?? '', b ?? '');
    send(res, 200, { ok: true });
  },

  'GET /api/song': async (req, res, q) => {
    const track = { pid: q.get('pid') || '', name: q.get('name') || '', artist: q.get('artist') || '', album: q.get('album') || '', duration: Number(q.get('duration')) || 0 };
    send(res, 200, await loadSong(track, { refresh: q.has('refresh') }));
  },
  'GET /api/candidates': async (req, res, q) => {
    const track = { name: q.get('name') || '', artist: q.get('artist') || '', duration: Number(q.get('duration')) || 0 };
    const cands = await findCandidates(track, q.get('q') || '');
    await Promise.all(cands.slice(0, 8).map(async (c) => {
      try { c.flags = (await fetchLyrics(c)).flags; } catch { /* 忽略单个失败 */ }
    }));
    send(res, 200, cands.map(slimCand));
  },
  'POST /api/song/source': async (req, res) => {
    const { key, cand } = await readBody(req);
    saveSongMeta(key, { source: cand ? { ...cand, auto: false } : null });
    send(res, 200, { ok: true });
  },
  'POST /api/song/offset': async (req, res) => {
    const { key, offset } = await readBody(req);
    saveSongMeta(key, { offset: Math.round(Number(offset) * 100) / 100 || 0 });
    send(res, 200, { ok: true });
  },
  'POST /api/song/reading': async (req, res) => {
    // scope: here（仅此处）/ song（本曲全部）/ global（所有歌曲）；reading 为 null 表示恢复自动
    const { key, scope, lineText, ti, si, seg, reading } = await readBody(req);
    const meta = getSongMeta(key);
    const posKey = `${lineText}#${ti}#${si}`;
    const readings = { ...meta.readings };
    const wordReadings = { ...meta.wordReadings };
    if (reading === null) {
      delete readings[posKey];
      delete wordReadings[seg];
      const d = getUserDict();
      if (seg in d) { delete d[seg]; saveUserDict(d); }
    } else if (scope === 'global') {
      saveUserDict({ ...getUserDict(), [seg]: reading });
      delete readings[posKey];
      delete wordReadings[seg];
    } else if (scope === 'song') {
      wordReadings[seg] = reading;
      delete readings[posKey];
    } else readings[posKey] = reading;
    saveSongMeta(key, { readings, wordReadings });
    send(res, 200, { ok: true });
  },

  'POST /api/dict': async (req, res) => {
    const { words, cachedOnly } = await readBody(req);
    send(res, 200, await lookupWords((words || []).slice(0, 40), !!cachedOnly));
  },
  'POST /api/ai/annotate': async (req, res) => {
    const { source, lines } = await readBody(req);
    if (!aiAvailable()) return send(res, 400, { error: '还没有配置 Claude API Key（设置 → AI 讲解）' });
    try {
      await annotateWithAI(`${source.source}-${source.id}`, lines);
      send(res, 200, { ok: true });
    } catch (e) {
      send(res, 502, { error: describeAIError(e) });
    }
  },

  'GET /api/vocab': (req, res) => send(res, 200, getVocab()),
  'POST /api/vocab': async (req, res) => {
    const entry = await readBody(req);
    const list = getVocab();
    const item = { id: crypto.randomUUID(), addedAt: Date.now(), ...entry };
    list.unshift(item);
    saveVocab(list);
    send(res, 200, item);
  },
  'POST /api/vocab/update': async (req, res) => {
    const { id, ...patch } = await readBody(req);
    const list = getVocab().map((v) => (v.id === id ? { ...v, ...patch } : v));
    saveVocab(list);
    send(res, 200, { ok: true });
  },
  'POST /api/vocab/delete': async (req, res) => {
    const { id } = await readBody(req);
    saveVocab(getVocab().filter((v) => v.id !== id));
    send(res, 200, { ok: true });
  },
  'GET /api/vocab.csv': (req, res) => {
    const esc = (s) => `"${String(s ?? '').replace(/"/g, '""')}"`;
    const rows = [['单词', '读音', '释义', '例句（歌词）', '例句翻译', '歌曲', '歌手'].map(esc).join(',')];
    for (const v of getVocab()) rows.push([v.word, v.reading, v.meaning, v.line, v.zh, v.song?.name, v.song?.artist].map(esc).join(','));
    res.writeHead(200, { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="vocab.csv"' });
    res.end('﻿' + rows.join('\n'));
  },

  'GET /api/settings': (req, res) => {
    const s = getSettings();
    send(res, 200, { model: s.model, hasKey: !!s.apiKey, keyTail: s.apiKey ? s.apiKey.slice(-4) : '', envKey: !!process.env.ANTHROPIC_API_KEY });
  },
  'POST /api/settings': async (req, res) => {
    const body = await readBody(req);
    const patch = {};
    if (typeof body.apiKey === 'string') patch.apiKey = body.apiKey.trim();
    if (typeof body.model === 'string' && body.model.trim()) patch.model = body.model.trim();
    saveSettings(patch);
    send(res, 200, { ok: true });
  },
};

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const handler = routes[`${req.method} ${url.pathname}`];
  if (handler) {
    try { await handler(req, res, url.searchParams); }
    catch (e) { if (!res.headersSent) send(res, 500, { error: e.message }); else res.end(); }
    return;
  }
  if (req.method !== 'GET') return send(res, 404, { error: 'not found' });
  const rel = path.normalize(decodeURIComponent(url.pathname)).replace(/^(\.\.[/\\])+/, '');
  let file = path.join(PUBLIC, rel === '/' || rel === '\\' ? 'index.html' : rel);
  if (!file.startsWith(PUBLIC) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
  res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(file).pipe(res);
});

server.listen(PORT, '127.0.0.1', () => {
  console.log(`唱歌学日语 已启动： http://localhost:${PORT}`);
  if (!process.env.UTA_NO_MUSIC) music.startWatcher(); // UTA_NO_MUSIC=1：不连接 Apple Music（调试界面用）
  if (!process.env.UTA_NO_MUSIC && !process.env.UTA_NO_SHORTCUT) {
    ensureDesktopShortcut()
      .then((r) => {
        if (r === 'created') console.log('已在桌面创建快捷方式「唱歌学日语」，以后双击它即可启动。');
        else if (r === 'updated') console.log('桌面快捷方式已更新到当前程序位置。');
      })
      .catch((e) => console.error('桌面快捷方式创建失败（下次启动会重试）：', e.message));
  }
  getTokenizer().catch((e) => console.error('词典加载失败：', e.message));
});
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => { music.stopWatcher(); process.exit(0); });
