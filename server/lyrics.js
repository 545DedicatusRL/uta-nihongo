// 歌词获取：网易云音乐 / QQ 音乐。搜索 → 打分匹配 → 拉取歌词（原文 / 中文翻译 / 罗马音 / 逐字）。
import { readJSON, writeJSON, safeName } from './store.js';

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

async function getJSON(url, opts = {}) {
  const res = await fetch(url, {
    ...opts,
    headers: { 'User-Agent': UA, ...(opts.headers || {}) },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} ${new URL(url).host}`);
  return res.json();
}

// ---------------- 文本工具 ----------------
const HAS_JA = /[぀-ヿ]/; // 平假名 / 片假名
const HAS_CJK = /[぀-ヿ㐀-鿿]/;

export function cleanTitle(s) {
  return String(s || '')
    .replace(/[\(（\[【][^\)）\]】]*(feat|ft\.|with|ver|version|remaster|remix|single|ep|live|mix|edit|from|tv|cv|主题曲|片尾曲|片头曲|插曲)[^\)）\]】]*[\)）\]】]/gi, ' ')
    .replace(/\s+-\s+(single|ep)$/i, '')
    .replace(/\s+/g, ' ')
    .trim();
}
function norm(s) {
  return cleanTitle(s).normalize('NFKC').toLowerCase().replace(/[\s\p{P}\p{S}]/gu, '');
}
function decodeEntities(s) {
  return s
    .replace(/&apos;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

// ---------------- 搜索 ----------------
async function searchNetease(query) {
  const u = `https://music.163.com/api/cloudsearch/pc?s=${encodeURIComponent(query)}&type=1&limit=12`;
  const j = await getJSON(u, { headers: { Referer: 'https://music.163.com/' } });
  return (j.result?.songs || []).map((s) => ({
    source: 'netease',
    id: String(s.id),
    title: s.name,
    alias: [...(s.tns || []), ...(s.alia || [])],
    artists: (s.ar || []).map((a) => a.name),
    album: s.al?.name || '',
    duration: (s.dt || 0) / 1000,
    cover: s.al?.picUrl ? s.al.picUrl.replace(/^http:/, 'https:') + '?param=600y600' : '',
  }));
}

const QQ_COMM = { ct: '19', cv: '1859', uin: '0' };
async function qqCall(req) {
  const j = await getJSON('https://u.y.qq.com/cgi-bin/musicu.fcg', {
    method: 'POST',
    headers: { Referer: 'https://y.qq.com/', 'Content-Type': 'application/json' },
    body: JSON.stringify({ comm: QQ_COMM, req }),
  });
  if (j.req?.code !== 0) throw new Error(`QQ code ${j.req?.code}`);
  return j.req.data;
}
async function searchQQ(query) {
  const d = await qqCall({
    module: 'music.search.SearchCgiService',
    method: 'DoSearchForQQMusicDesktop',
    param: { grp: 1, num_per_page: 12, page_num: 1, query, search_type: 0 },
  });
  return (d.body?.song?.list || []).map((s) => ({
    source: 'qq',
    id: s.mid,
    songId: s.id,
    title: s.name || s.title,
    alias: [s.title, s.subtitle].filter(Boolean),
    artists: (s.singer || []).map((a) => a.name),
    album: s.album?.name || '',
    duration: s.interval || 0,
    cover: s.album?.mid ? `https://y.gtimg.cn/music/photo_new/T002R500x500M000${s.album.mid}.jpg` : '',
  }));
}

// Apple Music 里很多日语歌显示的是英文/罗马字曲名；用 iTunes 日区搜索反查日文原名。
async function lookupJapaneseName(track) {
  const term = `${cleanTitle(track.name)} ${track.artist || ''}`.trim();
  const u = `https://itunes.apple.com/search?term=${encodeURIComponent(term)}&country=JP&lang=ja_jp&entity=song&limit=12`;
  const j = await getJSON(u);
  let best = null;
  for (const r of j.results || []) {
    const diff = Math.abs((r.trackTimeMillis || 0) / 1000 - (track.duration || 0));
    if (track.duration && diff > 2.5) continue;
    if (!best || diff < best.diff) best = { diff, title: r.trackName, artist: r.artistName };
  }
  return best;
}

function scoreCandidate(c, track, names) {
  let score = 0;
  const ct = [norm(c.title), ...c.alias.map(norm)].filter(Boolean);
  let t = 0;
  for (const n of names.titles) {
    if (!n) continue;
    if (ct.includes(n)) t = Math.max(t, 40);
    else if (ct.some((x) => x.includes(n) || n.includes(x))) t = Math.max(t, 24);
  }
  score += t;
  const ca = c.artists.map(norm);
  if (names.artists.some((n) => n && ca.some((x) => x === n || x.includes(n) || n.includes(x)))) score += 20;
  if (track.duration) {
    const d = Math.abs(c.duration - track.duration);
    score += d <= 1.5 ? 40 : d <= 3 ? 30 : d <= 6 ? 15 : d <= 12 ? 4 : -10;
  } else score += 12;
  const inst = /(instrumental|inst\.?|off ?vocal|カラオケ|伴奏|karaoke)/i;
  if (inst.test(c.title) && !inst.test(track.name)) score -= 45;
  return score;
}

export async function findCandidates(track, manualQuery) {
  const titles = [cleanTitle(track.name)];
  const artists = [track.artist || ''];
  if (!manualQuery && !HAS_CJK.test(track.name)) {
    try {
      const jp = await lookupJapaneseName(track);
      if (jp) { titles.push(cleanTitle(jp.title)); artists.push(jp.artist); }
    } catch { /* 反查失败不影响主流程 */ }
  }
  const queries = new Set();
  if (manualQuery) queries.add(manualQuery);
  else {
    titles.forEach((t, i) => queries.add(`${t} ${artists[i] || artists[0]}`.trim()));
    queries.add(titles[titles.length - 1]);
  }
  const jobs = [];
  for (const q of queries) {
    jobs.push(searchNetease(q).catch(() => []));
    jobs.push(searchQQ(q).catch(() => []));
  }
  const seen = new Map();
  for (const list of await Promise.all(jobs)) {
    for (const c of list) {
      const k = `${c.source}:${c.id}`;
      if (!seen.has(k)) seen.set(k, c);
    }
  }
  const names = { titles: [...new Set(titles.map(norm))], artists: [...new Set(artists.map(norm))] };
  const out = [...seen.values()].map((c) => ({ ...c, score: scoreCandidate(c, track, names) }));
  // 同分时网易云优先（带罗马音，可用于假名纠错）
  out.sort((a, b) => b.score - a.score || (a.source === 'netease' ? -1 : 1));
  return out.slice(0, 16);
}

// ---------------- 解析 ----------------
const TIME_TAG = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
const META_LINE = /^(作词|作曲|编曲|作詞|編曲|制作人|词|曲|詞|歌|唄|演唱|原唱|翻唱|歌手|vocal|vocals|lyrics?|music|composer|arranger|producer|produced|mix|mixed|mixing|mastering|mastered|guitar|bass|drums|piano|keyboard|strings|chorus|混音|母带|录音|吉他|贝斯|鼓|和声|钢琴|弦乐|出品|监制|发行|企划|封面|调教|动画|绘|映像|pv|op|sp|翻译|歌词贡献者|翻译贡献者)[^:：]{0,24}[:：]/i;

function parseLRC(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    if (!raw || raw[0] === '{') continue; // 网易云的 JSON 元信息行
    const times = [];
    let m, last = 0;
    TIME_TAG.lastIndex = 0;
    while ((m = TIME_TAG.exec(raw)) && m.index === last) {
      times.push(Number(m[1]) * 60 + Number(m[2]) + (m[3] ? Number(`0.${m[3]}`) : 0));
      last = TIME_TAG.lastIndex;
    }
    if (!times.length) continue;
    const txt = decodeEntities(raw.slice(last)).replace(/　/g, ' ').trim();
    for (const t of times) out.push({ t, text: txt });
  }
  return out.sort((a, b) => a.t - b.t);
}

// 网易云逐字歌词：[行起始ms,行时长ms](字起始ms,字时长ms,0)字(…)字
function parseYRC(text) {
  const out = [];
  for (const raw of String(text || '').split(/\r?\n/)) {
    const head = /^\[(\d+),(\d+)\]/.exec(raw);
    if (!head) continue;
    const words = [];
    const re = /\((\d+),(\d+),\d+\)([^(]*)/g;
    let m;
    while ((m = re.exec(raw))) {
      if (m[3] !== '') words.push({ t: Number(m[1]) / 1000, d: Number(m[2]) / 1000, text: m[3].replace(/　/g, ' ') });
    }
    if (words.length) out.push({ t: Number(head[1]) / 1000, d: Number(head[2]) / 1000, words });
  }
  return out;
}

function nearest(entries, t, tol) {
  let best = null;
  for (const e of entries) {
    const d = Math.abs(e.t - t);
    if (d <= tol && (!best || d < Math.abs(best.t - t))) best = e;
  }
  return best;
}

function buildLines(lrc, trans, roma, yrc) {
  const lines = [];
  for (let i = 0; i < lrc.length; i++) {
    const e = lrc[i];
    const next = lrc[i + 1];
    if (!e.text || META_LINE.test(e.text)) continue;
    const line = { t: e.t, end: next ? next.t : e.t + 8, text: e.text };
    const tr = nearest(trans, e.t, 0.6);
    if (tr && tr.text && tr.text !== '//' && tr.text !== e.text) line.zh = tr.text.replace(/^\/\/|\/\/$/g, '').trim();
    const ro = nearest(roma, e.t, 0.6);
    if (ro && ro.text) line.roma = ro.text;
    lines.push(line);
  }
  // 首行如果是「曲名 - 歌手」形式的标题行，去掉
  if (lines.length > 3 && lines[0].t < 1.5 && /\s-\s/.test(lines[0].text) && !lines[0].zh) lines.shift();
  // 结束时间不超过下一句开始；过长的（间奏）截断，方便前端显示间奏
  for (const l of lines) if (l.end - l.t > 14) l.end = l.t + 14;

  // 把逐字时间挂到对应的行上
  if (yrc.length) {
    const key = (s) => s.replace(/\s/g, '');
    for (const l of lines) {
      const y = yrc.find((y) => Math.abs(y.t - l.t) < 3 && key(y.words.map((w) => w.text).join('')) === key(l.text));
      if (!y) continue;
      l.text = y.words.map((w) => w.text).join('').trimEnd();
      l.t = y.t;
      l.end = Math.max(y.t + y.d, y.words[y.words.length - 1].t + y.words[y.words.length - 1].d);
      // 每个字符的起止时间
      const ct = [];
      for (const w of y.words) {
        // 按 UTF-16 码元索引，和分词结果的下标保持一致
        const n = w.text.length;
        for (let k = 0; k < n; k++) ct.push([w.t + (w.d * k) / n, w.t + (w.d * (k + 1)) / n]);
      }
      l.ct = ct.slice(0, l.text.length).map(([a, b]) => [Math.round(a * 1000) / 1000, Math.round(b * 1000) / 1000]);
    }
  }
  return lines;
}

// ---------------- 拉取 ----------------
async function fetchNetease(id) {
  const u = `https://music.163.com/api/song/lyric/v1?id=${id}&cp=false&tv=0&lv=0&rv=0&kv=0&yv=0&ytv=0&yrv=0`;
  const j = await getJSON(u, { headers: { Referer: 'https://music.163.com/' } });
  const lrc = parseLRC(j.lrc?.lyric);
  return { lines: buildLines(lrc, parseLRC(j.tlyric?.lyric), parseLRC(j.romalrc?.lyric), parseYRC(j.yrc?.lyric)) };
}

async function fetchQQ(mid, songId) {
  const d = await qqCall({
    module: 'music.musichallSong.PlayLyricInfo',
    method: 'GetPlayLyricInfo',
    param: { songMID: mid, songID: songId || 0, trans: 1, roma: 0, qrc: 0, crypt: 0, lrc_t: 0, trans_t: 0, roma_t: 0, type: 0, ct: 19, cv: 1859 },
  });
  const b64 = (s) => Buffer.from(s || '', 'base64').toString('utf8');
  const lyricText = b64(d.lyric);
  const transText = b64(d.trans);
  const lrc = parseLRC(lyricText);
  const out = { lines: buildLines(lrc, parseLRC(transText), [], []) };
  // QQ 的翻译里常带 [kana:1よる1か…]：按歌词中汉字出现顺序给出的读音（数字 = 覆盖的汉字个数）
  const kana = /\[kana:([^\]]*)\]/.exec(transText) || /\[kana:([^\]]*)\]/.exec(lyricText);
  if (kana && kana[1]) out.kana = { raw: kana[1], allText: lrc.map((e) => e.text) };
  return out;
}

export async function fetchLyrics(cand, refresh = false) {
  const file = `lyrics/${cand.source}-${safeName(cand.id)}.json`;
  if (!refresh) {
    const hit = readJSON(file, null);
    if (hit) return hit;
  }
  const data = cand.source === 'qq' ? await fetchQQ(cand.id, cand.songId) : await fetchNetease(cand.id);
  const text = data.lines.map((l) => l.text).join('');
  data.flags = {
    lines: data.lines.length,
    japanese: HAS_JA.test(text),
    trans: data.lines.filter((l) => l.zh).length >= Math.max(1, data.lines.length * 0.3),
    roma: data.lines.some((l) => l.roma) || !!data.kana,
    words: data.lines.some((l) => l.ct),
  };
  if (data.lines.length) writeJSON(file, data);
  return data;
}

// 自动挑选：在分数靠前的候选里，优先「有歌词 + 有翻译」，其次逐字、罗马音
export async function pickBest(candidates) {
  const top = candidates.filter((c) => c.score >= 44).slice(0, 5);
  let best = null;
  await Promise.all(top.map(async (c) => {
    try {
      const ly = await fetchLyrics(c);
      c.flags = ly.flags;
    } catch (e) { c.error = e.message; }
  }));
  for (const c of top) {
    if (!c.flags || !c.flags.lines) continue;
    const v = c.score + (c.flags.trans ? 14 : 0) + (c.flags.words ? 6 : 0) + (c.flags.roma ? 3 : 0) + (c.flags.japanese ? 4 : 0);
    if (!best || v > best.v) best = { v, c };
  }
  return best ? best.c : null;
}
