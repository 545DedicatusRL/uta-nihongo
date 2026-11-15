// 日语处理：kuromoji 分词 → 假名标注（振り仮名）→ 用歌词源的罗马音 / QQ 假名数据纠错 → 应用用户修正。
import path from 'node:path';
import kuromoji from 'kuromoji';
import { ROOT } from './store.js';
import { matchGrammar } from './grammar.js';

let tokenizerPromise = null;
export function getTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath: path.join(ROOT, 'node_modules/kuromoji/dict') })
        .build((err, t) => (err ? reject(err) : resolve(t)));
    });
  }
  return tokenizerPromise;
}

// ---------------- 字符工具 ----------------
const KANJI = /[㐀-䶿一-鿿々〆]/;
const KANA = /[぀-ヿー]/;
const isKanji = (c) => KANJI.test(c);
export const toHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------------- 假名 ↔ 罗马字 ----------------
const K2R = {};
{
  const rows = {
    '': 'あいうえお', k: 'かきくけこ', s: 'さしすせそ', t: 'たちつてと', n: 'なにぬねの', h: 'はひふへほ',
    m: 'まみむめも', r: 'らりるれろ', g: 'がぎぐげご', z: 'ざじずぜぞ', d: 'だぢづでど', b: 'ばびぶべぼ', p: 'ぱぴぷぺぽ',
  };
  const V = 'aiueo';
  for (const c in rows) [...rows[c]].forEach((k, i) => { K2R[k] = c + V[i]; });
  Object.assign(K2R, {
    し: 'shi', ち: 'chi', つ: 'tsu', ふ: 'fu', じ: 'ji', ぢ: 'ji', づ: 'zu',
    や: 'ya', ゆ: 'yu', よ: 'yo', わ: 'wa', を: 'wo', ん: 'n', ゔ: 'vu',
    ゐ: 'i', ゑ: 'e',
  });
  const y = { き: 'ky', ぎ: 'gy', し: 'sh', じ: 'j', ち: 'ch', ぢ: 'j', に: 'ny', ひ: 'hy', び: 'by', ぴ: 'py', み: 'my', り: 'ry' };
  for (const k in y) { K2R[k + 'ゃ'] = y[k] + 'a'; K2R[k + 'ゅ'] = y[k] + 'u'; K2R[k + 'ょ'] = y[k] + 'o'; }
  Object.assign(K2R, {
    ふぁ: 'fa', ふぃ: 'fi', ふぇ: 'fe', ふぉ: 'fo', てぃ: 'ti', でぃ: 'di', とぅ: 'tu', どぅ: 'du',
    うぃ: 'wi', うぇ: 'we', うぉ: 'wo', ゔぁ: 'va', ゔぃ: 'vi', ゔぇ: 've', ゔぉ: 'vo',
    しぇ: 'she', じぇ: 'je', ちぇ: 'che', つぁ: 'tsa', つぉ: 'tso', いぇ: 'ye',
  });
}
// 匹配歌词源罗马音时允许的异写
const ALT = {
  は: '(?:ha|wa)', へ: '(?:he|e)', を: '(?:wo|o)', し: '(?:shi|si)', ち: '(?:chi|ti)', つ: '(?:tsu|tu)',
  ふ: '(?:fu|hu)', じ: '(?:ji|zi)', ぢ: '(?:ji|zi|di)', づ: '(?:zu|du)', ん: "(?:nn|n|m)",
  しゃ: '(?:sha|sya)', しゅ: '(?:shu|syu)', しょ: '(?:sho|syo)',
  じゃ: '(?:ja|jya|zya)', じゅ: '(?:ju|jyu|zyu)', じょ: '(?:jo|jyo|zyo)',
  ちゃ: '(?:cha|tya)', ちゅ: '(?:chu|tyu)', ちょ: '(?:cho|tyo)',
};
const SMALL = { ぁ: 'a', ぃ: 'i', ぅ: 'u', ぇ: 'e', ぉ: 'o', ゃ: 'ya', ゅ: 'yu', ょ: 'yo', ゎ: 'wa' };

// 假名串 → 匹配罗马音的正则片段
function kanaPattern(hira) {
  let out = '';
  for (let i = 0; i < hira.length; i++) {
    const two = hira.slice(i, i + 2);
    if (K2R[two]) { out += ALT[two] || K2R[two]; i++; continue; }
    const c = hira[i];
    if (c === 'っ') out += '[a-z]?';
    else if (c === 'ー') out += '[aiueo]?';
    else if (SMALL[c]) out += `(?:${SMALL[c]})?`;
    else if (K2R[c]) out += ALT[c] || K2R[c];
    else out += '[a-z]?';
  }
  return out;
}
// 假名 → 标准罗马字（用于比较）
function kanaToRomaji(hira) {
  let out = '';
  for (let i = 0; i < hira.length; i++) {
    const two = hira.slice(i, i + 2);
    if (K2R[two]) { out += K2R[two]; i++; continue; }
    const c = hira[i];
    if (c === 'っ') { const nx = K2R[hira.slice(i + 1, i + 3)] || K2R[hira[i + 1]] || ''; out += nx[0] || ''; }
    else if (c === 'ー') out += out.slice(-1);
    else out += K2R[c] || SMALL[c] || '';
  }
  return out;
}
const R2K = {};
for (const k in K2R) if (!R2K[K2R[k]]) R2K[K2R[k]] = k;
Object.assign(R2K, {
  si: 'し', ti: 'ち', tu: 'つ', hu: 'ふ', zi: 'じ', sya: 'しゃ', syu: 'しゅ', syo: 'しょ', tya: 'ちゃ', tyu: 'ちゅ', tyo: 'ちょ',
  jya: 'じゃ', jyu: 'じゅ', jyo: 'じょ', zya: 'じゃ', zyu: 'じゅ', zyo: 'じょ', ji: 'じ', zu: 'ず', wo: 'を', di: 'ぢ', du: 'づ',
});
const VOWEL = /[aiueo]/;
function romajiToKana(r) {
  let out = '';
  let i = 0;
  while (i < r.length) {
    const c = r[i], nx = r[i + 1];
    if (c === 'n' && (nx === undefined || (!VOWEL.test(nx) && nx !== 'y'))) { out += 'ん'; i += nx === 'n' && !VOWEL.test(r[i + 2] || '') && r[i + 2] !== 'y' ? 2 : 1; continue; }
    if (c === 'm' && nx && /[bpm]/.test(nx)) { out += 'ん'; i++; continue; }
    if (nx && c === nx && !VOWEL.test(c)) { out += 'っ'; i++; continue; }
    if (c === 't' && r.slice(i + 1, i + 3) === 'ch') { out += 'っ'; i++; continue; }
    let hit = false;
    for (const len of [3, 2, 1]) {
      const k = R2K[r.slice(i, i + len)];
      if (k) { out += k; i += len; hit = true; break; }
    }
    if (!hit) return null;
  }
  return out;
}
// 归一化罗马字后比较，抹平常见写法差异
function canon(r) {
  return r
    .replace(/['\-]/g, '').replace(/sy/g, 'sh').replace(/si/g, 'shi').replace(/ty/g, 'ch').replace(/ti/g, 'chi')
    .replace(/tu/g, 'tsu').replace(/(^|[^sc])hu/g, '$1fu').replace(/zy|jy/g, 'j').replace(/zi|di/g, 'ji')
    .replace(/du/g, 'zu').replace(/m([bp])/g, 'n$1').replace(/nn/g, 'n').replace(/oo/g, 'ou').replace(/wo/g, 'o');
}
function normalizeSourceRomaji(s) {
  return s.toLowerCase()
    .replace(/ā/g, 'aa').replace(/ī/g, 'ii').replace(/ū/g, 'uu').replace(/ē/g, 'ee').replace(/ō/g, 'ou')
    .normalize('NFKD').replace(/[^a-z]/g, '');
}

// ---------------- 振り仮名切分 ----------------
// 「食べる」+「たべる」→ [{t:'食', r:'た'}, {t:'べる'}]
function splitFurigana(surface, reading) {
  if (![...surface].some(isKanji)) return [{ t: surface }];
  if (!reading) return [{ t: surface }];
  const runs = [];
  for (const ch of surface) {
    const type = isKanji(ch) ? 'K' : KANA.test(ch) ? 'H' : 'O';
    const last = runs[runs.length - 1];
    if (last && last.type === type) last.t += ch;
    else runs.push({ type, t: ch });
  }
  if (runs.some((r) => r.type === 'O')) return [{ t: surface, r: reading }];
  const re = new RegExp('^' + runs.map((r) => (r.type === 'K' ? '(.+?)' : escapeRe(toHira(r.t)))).join('') + '$');
  const m = re.exec(reading);
  if (!m) return [{ t: surface, r: reading }];
  let g = 1;
  return runs.map((r) => (r.type === 'K' ? { t: r.t, r: m[g++] } : { t: r.t }));
}

// ---------------- 罗马音纠错 ----------------
// 把一行歌词变成正则：假名 → 固定罗马字，汉字 → 捕获组；与歌词源的罗马音对齐后，
// 捕获组里就是「实际唱的读音」，和词典读音不一致时以罗马音为准。
function correctWithRomaji(tokens, roma) {
  const none = { n: 0, merges: [] };
  const src = normalizeSourceRomaji(roma);
  if (!src || src.length > 400) return none;
  const groups = []; // 每组：相邻的汉字段 [{ seg, ti }]
  const parts = [];  // 正则片段；汉字组先占位
  let open = null;
  tokens.forEach((tok, ti) => {
    for (const seg of tok.segs) {
      if ([...seg.t].some(isKanji)) {
        if (!open) { open = []; groups.push(open); parts.push(open); }
        open.push({ seg, ti });
        continue;
      }
      const text = seg.t.normalize('NFKC');
      let piece = '';
      if (/^[\u3040-\u30ffー]+$/.test(text)) piece = kanaPattern(toHira(text));
      else {
        for (const ch of text) {
          if (KANA.test(ch)) piece += kanaPattern(toHira(ch));
          else if (/[a-z]/i.test(ch)) piece += ch.toLowerCase();
          else if (/[0-9]/.test(ch)) piece += '[a-z]*?';
        }
      }
      if (piece) { parts.push(piece); open = null; }
    }
  });
  if (!groups.length) return none;
  // 每个汉字组优先尝试词典读音，对不上时才退回「任意罗马字」，避免前后错位
  const pattern = '^' + parts.map((p) => {
    if (typeof p === 'string') return p;
    const known = p.map((x) => (x.seg.r ? kanaPattern(toHira(x.seg.r)) : null));
    return known.every(Boolean) ? `(${known.join('')}|[a-z]+?)` : '([a-z]+?)';
  }).join('') + '$';
  let m;
  try { m = new RegExp(pattern).exec(src); } catch { return none; }
  if (!m) return none;

  const changes = [];
  const merges = [];
  groups.forEach((members, gi) => {
    const segs = members.map((x) => x.seg);
    const cap = m[gi + 1];
    const cur = segs.map((s) => kanaToRomaji(toHira(s.r || ''))).join('');
    if (canon(cur) === canon(cap)) return;
    if (segs.length === 1) { changes.push([segs[0], cap]); return; }
    // 相邻的多个汉字段：把读音与词典一致的首尾剥掉，只剩一个不一致时修正它
    let lo = 0, hi = segs.length - 1, rest = canon(cap);
    while (lo < hi) {
      const r = canon(kanaToRomaji(toHira(segs[lo].r || '')));
      if (r && rest.startsWith(r)) { rest = rest.slice(r.length); lo++; } else break;
    }
    while (hi > lo) {
      const r = canon(kanaToRomaji(toHira(segs[hi].r || '')));
      if (r && rest.endsWith(r)) { rest = rest.slice(0, -r.length); hi--; } else break;
    }
    if (lo === hi && rest) { changes.push([segs[lo], rest]); return; }
    // 否则（如「二人」被拆成 二+人）：整词合并成一个注音单位
    const part = members.slice(lo, hi + 1);
    const whole = part.every((x) => tokens[x.ti].segs.length === 1) && part.every((x, k) => k === 0 || x.ti === part[k - 1].ti + 1);
    const kana = romajiToKana(rest);
    if (whole && kana) merges.push({ from: part[0].ti, to: part[part.length - 1].ti, r: kana });
  });
  let n = merges.length;
  for (const [seg, romaji] of changes) {
    const kana = romajiToKana(romaji);
    const kanjiCount = [...seg.t].filter(isKanji).length;
    if (!kana || kana.length > kanjiCount * 5 + 2) continue;
    if (seg.r && seg.r !== kana) seg.auto = seg.r;
    seg.r = kana;
    seg.src = 'roma';
    n++;
  }
  return { n, merges };
}

// 把 tokens[from..to] 合并成一个词；返回合并后的 token
function mergeTokens(tokens, from, to, reading, src) {
  const group = tokens.slice(from, to + 1);
  const s = group.map((t) => t.s).join('');
  const seg = { t: s, r: reading };
  if (src) { seg.src = src; seg.auto = group.map((t) => t.segs.map((g) => g.r || '').join('')).join(''); }
  const merged = { s, i0: group[0].i0, b: s, pos: '名', segs: [seg], v: 1, raw: group.flatMap((t) => t.raw) };
  tokens.splice(from, group.length, merged);
  return merged;
}

// 分词器常拆错的熟字训
const COMPOUND = { 二人: 'ふたり', 一人: 'ひとり', 二十歳: 'はたち', 一日: 'いちにち', 一言: 'ひとこと', 何処: 'どこ', 何故: 'なぜ', 何時: 'いつ', 此処: 'ここ', 其処: 'そこ', 彼方: 'かなた' };
function mergeCompounds(tokens) {
  for (let i = 0; i < tokens.length - 1; i++) {
    for (const len of [3, 2]) {
      if (i + len > tokens.length) continue;
      const s = tokens.slice(i, i + len).map((t) => t.s).join('');
      if (COMPOUND[s]) { mergeTokens(tokens, i, i + len - 1, COMPOUND[s]); break; }
    }
  }
}

// ---------------- QQ 音乐的 [kana:…] 读音 ----------------
// 返回 Map<行文本, [{ i: 行内字符下标, n: 覆盖汉字数, r: 读音 }]>，数量对不上则返回 null
export function parseQQKana(kana) {
  if (!kana?.raw) return null;
  const entries = [];
  const re = /(\d)([^\d]+)/g;
  let m;
  while ((m = re.exec(kana.raw))) entries.push({ n: Number(m[1]), r: toHira(m[2].trim()) });
  const total = entries.reduce((a, e) => a + e.n, 0);
  const positions = [];
  kana.allText.forEach((text, li) => {
    for (let i = 0; i < text.length; i++) if (isKanji(text[i])) positions.push({ li, i });
  });
  if (!total || positions.length !== total) return null;
  const map = new Map();
  let p = 0;
  for (const e of entries) {
    const first = positions[p];
    const text = kana.allText[first.li];
    if (!map.has(text)) map.set(text, { li: first.li, list: [] });
    const slot = map.get(text);
    if (slot.li === first.li) slot.list.push({ i: first.i, n: e.n, r: e.r });
    p += e.n;
  }
  return new Map([...map].map(([k, v]) => [k, v.list]));
}
function correctWithQQKana(tokens, list) {
  let n = 0;
  for (const tok of tokens) {
    let pos = tok.i0;
    for (const seg of tok.segs) {
      const start = pos, end = pos + seg.t.length;
      pos = end;
      if (![...seg.t].every(isKanji)) continue;
      const inside = list.filter((e) => e.i >= start && e.i < end);
      const covered = inside.reduce((a, e) => a + e.n, 0);
      if (!inside.length || covered !== seg.t.length) continue;
      const r = inside.map((e) => e.r).join('');
      if (r && r !== seg.r) { if (seg.r) seg.auto = seg.r; seg.r = r; seg.src = 'qq'; n++; }
    }
  }
  return n;
}

// ---------------- 词性 ----------------
const POS_ZH = { 名詞: '名', 動詞: '动', 形容詞: '形', 副詞: '副', 助詞: '助', 助動詞: '助动', 連体詞: '连体', 接続詞: '接续', 感動詞: '感叹', 接頭詞: '接头', 記号: '', フィラー: '' };
const STOP = new Set(['する', 'いる', 'ある', 'なる', 'れる', 'られる', 'せる', 'この', 'その', 'あの', 'どの', 'こう', 'そう', 'ああ', 'どう', 'こと', 'もの', 'よう', 'ない', '僕', 'ぼく', 'ボク']);
function isContentWord(t) {
  if (!/[぀-ヿ㐀-鿿]/.test(t.surface_form)) return false;
  const base = t.basic_form && t.basic_form !== '*' ? t.basic_form : t.surface_form;
  if (STOP.has(base)) return false;
  if (t.pos === '名詞') return /^(一般|サ変接続|形容動詞語幹|副詞可能|固有名詞|ナイ形容詞語幹|代名詞)$/.test(t.pos_detail_1);
  if (t.pos === '動詞' || t.pos === '形容詞') return t.pos_detail_1 === '自立';
  return t.pos === '副詞' || t.pos === '連体詞' || t.pos === '感動詞';
}

// ---------------- 主入口 ----------------
// lines: [{ t, end, text, zh?, roma?, ct? }]；opts: { kana, meta, userDict }
export async function analyzeLyrics(lines, opts = {}) {
  const tokenizer = await getTokenizer();
  const qq = parseQQKana(opts.kana);
  const meta = opts.meta || {};
  const userDict = opts.userDict || {};
  const stats = { roma: 0, qq: 0, user: 0 };

  return {
    stats,
    lines: lines.map((line) => {
      const raw = tokenizer.tokenize(line.text);
      let i0 = 0;
      const tokens = raw.map((t, ri) => {
        const s = t.surface_form;
        const reading = t.reading && t.reading !== '*' ? toHira(t.reading) : '';
        const tok = {
          s, i0,
          b: t.basic_form && t.basic_form !== '*' ? t.basic_form : s,
          pos: POS_ZH[t.pos] ?? '',
          segs: splitFurigana(s, reading),
          raw: [ri],
        };
        if (isContentWord(t)) tok.v = 1;
        if (/^\s+$/.test(s)) tok.sp = 1;
        i0 += s.length;
        return tok;
      });
      mergeCompounds(tokens);

      if (line.roma) {
        const res = correctWithRomaji(tokens, line.roma);
        for (const mg of res.merges.sort((a, b) => b.from - a.from)) mergeTokens(tokens, mg.from, mg.to, mg.r, 'roma');
        stats.roma += res.n;
      }
      const qlist = qq && qq.get(line.text);
      if (qlist) stats.qq += correctWithQQKana(tokens, qlist);

      // 用户修正：全局词典 < 本曲词典 < 具体位置
      tokens.forEach((tok, ti) => tok.segs.forEach((seg, si) => {
        if (![...seg.t].some(isKanji)) return;
        const u = meta.readings?.[`${line.text}#${ti}#${si}`] ?? meta.wordReadings?.[seg.t] ?? userDict[seg.t];
        if (u !== undefined && u !== seg.r) {
          if (seg.r && !seg.auto) seg.auto = seg.r;
          seg.r = u;
          seg.src = 'user';
          stats.user++;
        }
      }));
      for (const tok of tokens) tok.r = tok.segs.map((g) => (g.r !== undefined ? g.r : toHira(g.t))).join('');

      // 语法点是在原始分词上匹配的，合并过词之后把下标换算过来
      const rawToTok = [];
      tokens.forEach((tok, ti) => { for (const ri of tok.raw) rawToTok[ri] = ti; delete tok.raw; });
      const grammar = matchGrammar(raw).map((g) => ({ ...g, start: rawToTok[g.start], end: rawToTok[g.end - 1] + 1 }));
      return { ...line, tokens, grammar };
    }),
  };
}
