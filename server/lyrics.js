// 歌词获取：网易云音乐 / QQ 音乐。搜索 → 打分匹配 → 拉取歌词（原文 / 中文翻译 / 罗马音 / 逐字）。
import { execFile } from 'node:child_process';
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
// 标题里的附加说明：括号里的、「 - 」后面的。分两种：
//   feat：合作者名单（feat. 宵崎奏, 朝比奈まふゆ & 鏡音レン）→ 按人名拆开、排好序，写法不同（, / & / 、）也能对上
//   ver：其余的（Movie Ver.、Cover、From THE FIRST TAKE、Reloaded…）
// 返回 { feat, ver }：各是一个规整过的字符串，没有就是 ''
function titleTags(title) {
  const feat = [], ver = [];
  const take = (g) => {
    const m = /^\s*(?:feat(?:uring)?|ft|with)[.．]?\s+(.+)$/i.exec(g);
    if (m) feat.push(...m[1].split(/\s*(?:,|，|、|&|＆|\/|×|\s+and\s+|\s+x\s+)\s*/i).map(norm).filter(Boolean));
    else if (norm(g)) ver.push(norm(g));
  };
  let rest = String(title || '').replace(/[\(（\[【]([^\)）\]】]*)[\)）\]】]/g, (_, g) => { take(g); return ' '; });
  const dash = rest.split(/\s+[-–—]\s+/);
  for (const g of dash.slice(1)) take(g);
  return { feat: feat.sort().join('|'), ver: ver.sort().join('|') };
}
// 两个专辑名有没有「一定的重合」：最长的相同片段够长（汉字假名 2 个字、字母数字 5 个），而且占短的那个名字的四成以上
function albumOverlap(a, b) {
  a = norm(a); b = norm(b);
  if (!a || !b) return false;
  let best = 0, end = 0, prev = new Array(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    const cur = new Array(b.length + 1).fill(0);
    for (let j = 1; j <= b.length; j++) if (a[i - 1] === b[j - 1]) { cur[j] = prev[j - 1] + 1; if (cur[j] > best) { best = cur[j]; end = i; } }
    prev = cur;
  }
  const common = a.slice(end - best, end);
  const need = HAS_CJK.test(common) ? 2 : 5;
  return best >= need && best >= Math.min(a.length, b.length) * 0.4;
}
// 繁体 → 简体（一次转一批）。用系统自带的转换，不另带字表；转不了（不是 macOS、超时）就原样返回
function toSimplified(list) {
  return new Promise((resolve) => {
    const script = "ObjC.import('Foundation'); function run(argv) { return $(argv[0]).stringByApplyingTransformReverse('Hant-Hans', false).js; }";
    execFile('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, list.join('\n')], { timeout: 4000 }, (err, out) => {
      const got = err ? [] : String(out).replace(/\n$/, '').split('\n');
      resolve(got.length === list.length ? got : list);
    });
  });
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

// Apple Music 里很多日语歌显示的是英文 / 罗马字的歌名、歌手名；到 iTunes 反查日文原名。
// 日区只有日文名，没法拿英文名去对；所以分两步：
//   1. 先在英文区（美区，没有再试港区）按「歌名相同 + 时长差 1.5 秒内」认准这首歌，歌手也对得上的优先；
//      再拿它的 id 去日区取日文的歌名、歌手、专辑。同一首歌在各区的 id 一般是一样的
//   2. 日区没有这个 id（发行版本不同）：在日区搜，只要「同一个歌手（歌手 id 各区通用）+ 时长差 6 秒内」里最接近的
//   3. 英文区连歌手都没认出来：退回老办法，日区搜索结果里时长差 2.5 秒内最接近的（没有别的佐证，可能挑错）
const itunes = (path) => getJSON(`https://itunes.apple.com/${path}`);
async function lookupJapaneseName(track) {
  const title = cleanTitle(track.name), dur = track.duration || 0;
  const term = encodeURIComponent(`${title} ${track.artist || ''}`.trim());
  const secs = (r) => (r.trackTimeMillis || 0) / 1000;
  const sameArtist = (r) => { const x = norm(r.artistName), y = norm(track.artist); return !!x && !!y && (x === y || x.includes(y) || y.includes(x)); };
  const pack = (r) => ({ title: r.trackName, artist: r.artistName, album: r.collectionName || '' });
  const japanese = (r) => HAS_CJK.test(`${r.trackName}${r.artistName}`);
  const artistIds = new Set();
  for (const cc of ['US', 'HK']) {
    let list = [];
    try { list = (await itunes(`search?term=${term}&country=${cc}&entity=song&limit=25`)).results || []; } catch { continue; }
    for (const r of list) if (sameArtist(r) && r.artistId) artistIds.add(r.artistId);
    const hits = list.filter((r) => norm(r.trackName) === norm(title) && (!dur || Math.abs(secs(r) - dur) <= 1.5));
    hits.sort((x, y) => sameArtist(y) - sameArtist(x));
    if (!hits.length) continue;
    try {
      const got = (await itunes(`lookup?id=${hits.slice(0, 8).map((r) => r.trackId).join(',')}&country=JP&lang=ja_jp`)).results || [];
      const byId = new Map(got.map((r) => [r.trackId, r]));
      const jp = hits.map((r) => byId.get(r.trackId)).find((r) => r && japanese(r));
      if (jp) return pack(jp);
    } catch { /* 往下走 */ }
    break;
  }
  const list = (await itunes(`search?term=${term}&country=JP&lang=ja_jp&entity=song&limit=25`)).results || [];
  const closest = (pool, tol) => pool.filter((r) => !dur || Math.abs(secs(r) - dur) <= tol).sort((x, y) => Math.abs(secs(x) - dur) - Math.abs(secs(y) - dur))[0];
  const jp = artistIds.size ? closest(list.filter((r) => artistIds.has(r.artistId)), 6) : closest(list, 2.5);
  return jp && japanese(jp) ? pack(jp) : null;
}

// 打分（满分大致 100 出头）：
//   歌名 完全相同 +40 / 互相包含 +24；歌手 相同或互相包含 +20；时长 差 1.5 秒内 +40，再往外 +30 / +15 / +4 / −10
//   feat 名单或版本说明和这首歌的完全一致 +15；专辑名有一定重合 +6
//   条目的歌名、歌手全是英文 −5（日语歌在网易云 / QQ 上的正主一般带日文，全英文的多半是翻唱、英文版）；伴奏版 −45
//   条目的歌名带着这首歌没有的版本说明（English Version、Cover、Remastered、Live…）−12
//   纯中文的歌：繁体、简体当成一样（names.simp 是事先转好的简体写法）
// 版本说明里出现这些词的才算「另一个版本」：括号里也常常只是中文译名、动画名，那些不扣分
const VERSION_WORD = /ver|remaster|remix|cover|live|acoustic|instrumental|inst|english|demo|edit|mix|piano|tvsize|short|翻唱|翻自|现场|現場|伴奏|钢琴|鋼琴|英文|カバー|弾き語り|ライブ/i;
function scoreCandidate(c, track, names) {
  let score = 0;
  const simp = (x) => names.simp?.get(x) || x;
  const ct = [norm(c.title), norm(simp(c.title)), ...c.alias.map(norm)].filter(Boolean);
  let t = 0;
  for (const n of names.titles) {
    if (!n) continue;
    if (ct.includes(n)) t = Math.max(t, 40);
    else if (ct.some((x) => x.includes(n) || n.includes(x))) t = Math.max(t, 24);
  }
  score += t;
  const ca = [...c.artists.map(norm), ...c.artists.map((x) => norm(simp(x)))].filter(Boolean);
  if (names.artists.some((n) => n && ca.some((x) => x === n || x.includes(n) || n.includes(x)))) score += 20;
  const tags = [c.title, ...c.alias].map(titleTags);
  if (names.tags.some((t) => tags.some((x) => (t.feat && t.feat === x.feat) || (t.ver && t.ver === x.ver)))) score += 15;
  if (names.albums.some((a) => albumOverlap(a, c.album))) score += 6;
  if (!/[^\x00-\x7f]/.test(c.title + c.artists.join(''))) score -= 5;
  const own = titleTags(c.title).ver;
  if (own && VERSION_WORD.test(own) && !names.tags.some((t) => t.ver === own)) score -= 12;
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
  const rawTitles = [track.name], albums = [track.album || ''];
  // 歌名本身（去掉 feat 之类的括号以后）没有日文、汉字的才反查：「kokoronashi (feat. 宵崎奏…)」括号里有汉字，歌名却是罗马字
  // 歌名已经是日文、歌手却是罗马字的（言って。 / Yorushika）也反查：为的是拿到日文的歌手名
  if (!manualQuery && (!HAS_CJK.test(cleanTitle(track.name)) || !HAS_CJK.test(track.artist || ''))) {
    try {
      const jp = await lookupJapaneseName(track);
      if (jp) { titles.push(cleanTitle(jp.title)); artists.push(jp.artist); rawTitles.push(jp.title); albums.push(jp.album); }
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
  const names = {
    titles: [...new Set(titles.map(norm))], artists: [...new Set(artists.map(norm))],
    tags: rawTitles.map(titleTags), albums: albums.filter(Boolean),
  };
  // 纯中文的歌（歌名、歌手里有汉字、没有假名）：Apple Music 里常是繁体，网易云 / QQ 是简体。都转成简体再比一遍
  const own = `${track.name}${track.artist || ''}`;
  if (/[㐀-鿿]/.test(own) && !HAS_JA.test(own)) {
    const list = [...new Set([...titles, ...artists, ...[...seen.values()].flatMap((c) => [c.title, ...c.artists])].filter((x) => /[㐀-鿿]/.test(x)))];
    const got = await toSimplified(list);
    names.simp = new Map(list.map((x, i) => [x, got[i]]));
    names.titles = [...new Set([...names.titles, ...titles.map((x) => norm(names.simp.get(x) || x))])];
    names.artists = [...new Set([...names.artists, ...artists.map((x) => norm(names.simp.get(x) || x))])];
  }
  const out = [...seen.values()].map((c) => ({ ...c, score: scoreCandidate(c, track, names) }));
  // 同分时网易云排在 QQ 前面（带罗马音，可用于假名纠错）；同一个来源里保持它自己搜索结果的先后（一般正主排最前）
  out.sort((a, b) => b.score - a.score || (a.source === b.source ? 0 : a.source === 'netease' ? -1 : 1));
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

// 自动挑选：在分数靠前的候选里，优先「有歌词 + 有翻译」，其次逐字、罗马音。
// 逐字 +10：要压过「专辑名重合」的 +6——同一首歌的两个条目，宁可要有逐字的那个
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
    const v = c.score + (c.flags.trans ? 14 : 0) + (c.flags.words ? 10 : 0) + (c.flags.roma ? 3 : 0) + (c.flags.japanese ? 4 : 0);
    if (!best || v > best.v) best = { v, c };
  }
  return best ? best.c : null;
}
