// 日语处理：kuromoji 分词 → 假名标注（振り仮名）→ 用歌词源的罗马音 / QQ 假名数据纠错 → 应用用户修正。
import path from 'node:path';
import kuromoji from 'kuromoji';
import { ROOT } from './store.js';
import { matchGrammar } from './grammar.js';
import { splitKanjiReading, warmKanjiReadings } from './kanji-readings.js';

let tokenizerPromise = null;
export function getTokenizer() {
  if (!tokenizerPromise) {
    tokenizerPromise = new Promise((resolve, reject) => {
      kuromoji.builder({ dicPath: path.join(ROOT, 'node_modules/kuromoji/dict') })
        .build((err, t) => {
          if (err) return reject(err);
          resolve(t);
          setTimeout(() => warmKanjiReadings(t), 0);
        });
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
      if (/^[\u3040-\u30ffー]+$/.test(text)) {
        piece = kanaPattern(toHira(text));
        if (seg.m) piece = `(?:${piece}|${kanaPattern(toHira(seg.m))})`; // 旧假名：罗马音可能照写法（hi），也可能照念法（i）
      }
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

// 分词器的词典里没有的汉字写法（騒めく、閃めく…）会被拆成「不认识的汉字 + めく」，
// 之后只拿前面那个单字去查词典，查到的是不相干的词（騒 → そう・骚体）。这里把它们合回一个动词。
const SUFFIX_VERBS = new Set(['めく', 'ぶる', 'がる', 'じみる', 'ばむ', 'づく', 'ぐむ']);
function mergeUnknownVerbs(tokens, raw) {
  for (let i = tokens.length - 2; i >= 0; i--) {
    const A = tokens[i], B = tokens[i + 1];
    if (A.raw.length !== 1 || B.raw.length !== 1) continue;
    const a = raw[A.raw[0]], b = raw[B.raw[0]];
    if (a.word_type !== 'UNKNOWN' || ![...a.surface_form].every(isKanji)) continue;
    if (b.pos !== '動詞' || !SUFFIX_VERBS.has(b.basic_form) || !/^[ぁ-ゖ]+$/.test(b.surface_form)) continue;
    tokens.splice(i, 2, { s: A.s + B.s, i0: A.i0, b: A.s + b.basic_form, pos: '动', segs: [...A.segs, ...B.segs], v: 1, u: 1, raw: [...A.raw, ...B.raw] });
  }
}
// 查词典时用的读音提示：辞书形和歌词里的写法开头相同的那一段，实际唱的是什么
// （辛い 唱的是 つら 还是 から、開いた 的 開 是 あ 还是 ひら）。同一个写法有好几个词条时靠它来选。
// 只有带汉字、而且读音已知的词才有提示。
function readingHint(tok) {
  if (![...tok.b].some(isKanji)) return '';
  // 来る 变形时词干的读音会变（き / こ），和辞书形的 くる 对不上，反而会撞上别的词（来る＝きたる）
  if (tok.b.endsWith('来る') && tok.s !== tok.b) return '';
  let n = 0;
  while (n < tok.b.length && n < tok.s.length && tok.b[n] === tok.s[n]) n++;
  let h = '', pos = 0, kanji = false;
  for (const g of tok.segs) {
    if (pos >= n) break;
    const end = pos + g.t.length;
    const hasKanji = [...g.t].some(isKanji);
    if (hasKanji) {
      if (!g.r || end > n) break; // 读音不知道，或者这一段跨过了词干：到此为止
      h += toHira(g.r);
      kanji = true;
    } else h += toHira(g.t.slice(0, Math.max(0, n - pos)));
    pos = end;
  }
  return kanji ? h : '';
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
const STOP = new Set(['する', 'いる', 'ある', 'なる', 'れる', 'られる', 'せる', 'この', 'その', 'あの', 'どの', 'こう', 'そう', 'ああ', 'どう', 'こと', 'もの', 'よう', 'ない', '僕', 'ぼく', 'ボク', 'いい', 'イイ']);
function isContentWord(t) {
  if (!/[぀-ヿ㐀-鿿]/.test(t.surface_form)) return false;
  const base = t.basic_form && t.basic_form !== '*' ? t.basic_form : t.surface_form;
  if (STOP.has(base)) return false;
  if (t.pos === '名詞') return /^(一般|サ変接続|形容動詞語幹|副詞可能|固有名詞|ナイ形容詞語幹|代名詞)$/.test(t.pos_detail_1);
  if (t.pos === '動詞' || t.pos === '形容詞') return t.pos_detail_1 === '自立';
  return t.pos === '副詞' || t.pos === '連体詞' || t.pos === '感動詞';
}

// ---------------- みたい（像…一样） ----------------
// 分词器认得「みたいな / みたいに」，但下面两种会被它当成「見る + たい」（想看）：
//   A. 口语的「みたく」：走馬灯みたく走って → み（見る）+ たく
//   B. 「夢みたいだ」：词典里有「夢みる」这个动词，于是成了 夢み + たい + だ
// 「見たい」和「みたい」都是真实的词，读音也一样，查词典分不出来，只能看前后文：
//   A. 假名写的 み + たく，前面直接是名词或动词原形（没有 を / が，也不是 て），
//      后面又不是 て / ない / なる 这类「たい 的变形还要继续」的东西 → みたい
//      （星がみたくて、やってみたくなる、みたくない 都还是「想看」）
//   B. み + たい 后面跟着 だ / です / な / に，或者到此为止——「想…」后面不会直接跟这些 → みたい
// 汉字写的「見たく」一律不动。认成 みたい 以后，它和分词器自己认出来的 みたい 是同一种词。
const toKata = (s) => s.replace(/[ぁ-ゖ]/g, (c) => String.fromCharCode(c.charCodeAt(0) + 0x60));
const mitaiTok = (surface) => ({
  surface_form: surface, basic_form: 'みたい', pos: '名詞', pos_detail_1: '非自立', pos_detail_2: '助動詞語幹', pos_detail_3: '*',
  conjugated_type: '*', conjugated_form: '*', reading: toKata(surface), pronunciation: toKata(surface), word_type: 'KNOWN',
});
const NOT_NOUN_MIRU = new Set(['試みる', '顧みる', '省みる', '鑑みる']); // 这些的 み 是动词自己的一部分，不是「名词 + みる」
function fixMitai(raw) {
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const t = raw[i], tai = raw[i + 1], next = raw[i + 2], prev = out[out.length - 1];
    const isMiTai = tai && tai.pos === '助動詞' && tai.basic_form === 'たい'
      && t.pos === '動詞' && t.surface_form.endsWith('み') && t.basic_form.endsWith('みる');
    if (isMiTai) {
      const stem = t.surface_form.slice(0, -1); // 「夢み」里的「夢」；单独的「み」则是空的
      const stemIsNoun = stem && t.basic_form === `${stem}みる` && !NOT_NOUN_MIRU.has(t.basic_form) && /^[㐀-䶿一-鿿々ァ-ヶー]+$/.test(stem);
      const afterWord = prev && (prev.pos === '名詞' || ((prev.pos === '動詞' || prev.pos === '形容詞') && prev.conjugated_form === '基本形')
        || (prev.pos === '助動詞' && /^(た|だ|ない)$/.test(prev.basic_form)));
      const goesOn = next && (next.pos === '助動詞' || (next.pos === '助詞' && /^(て|は|も)$/.test(next.surface_form)) || /^(なる|ない|無い)$/.test(next.basic_form));
      const copula = next && ((next.pos === '助動詞' && /^(だ|です)$/.test(next.basic_form)) || (next.pos === '助詞' && /^(に|な)$/.test(next.surface_form)));
      const ends = !next || next.pos === '記号';
      let hit = '';
      if (tai.surface_form === 'たく' && !stem && afterWord && !goesOn) hit = 'みたく';
      else if (tai.surface_form === 'たい' && (stem ? stemIsNoun && (copula || ends) : afterWord && copula)) hit = 'みたい';
      if (hit) {
        if (stem) {
          const r = (t.reading || '').slice(0, -1);
          out.push({ ...t, surface_form: stem, basic_form: stem, pos: '名詞', pos_detail_1: '一般', pos_detail_2: '*', conjugated_type: '*', conjugated_form: '*', reading: r, pronunciation: r });
        }
        out.push(mitaiTok(hit));
        i++;
        continue;
      }
    }
    out.push(t);
  }
  return out;
}

// ---------------- 变形的尾巴 ----------------
// 动词、形容词变形以后，分词器会把它拆成「词干 + 尾巴」：走って = 走っ + て，走らなかった = 走ら + なかっ + た，
// 食べてしまった = 食べ + て + しまっ + た。记词时把词干连同尾巴一起选中，要记的仍然是原形（走る、食べる），
// 所以这里把尾巴标出来（tok.f）。算作尾巴的：
//   助动词（た、ない、ます、たい、う、だ…）
//   接在活用形后面的助词：て / で / ば / ながら / つつ / たり / だり，以及 て 后面的 も / は
//   接尾的动词（れる / られる / せる / させる）
//   て 后面的补助动词（いる、しまう、くる、いく、みる、くれる、ください…）和它们的缩约形（てる、ちゃう、とく…）
//   样态的 そう
//   口语的 ちゃ / じゃ（行かなくちゃ、行っちゃえ）、ずに 的 に、て 后面的 ほしい、动词后面的 なさい
//   じゃない 的 じゃ（只在整段都选中时不妨碍还原，不连到前面的词上）
// 「走り続ける」这种复合动词里的后一个动词不算尾巴——它和前面合起来是另一个词。
//
// 另外给出 j：这个词和前一个词是「同一个变形」，记词时点一下就整段选中（走っ+て、走ら+なかっ+た、
// 勉強+し+た）。只有前面是会变形的词（动词、形容词、形容动词词干、サ变名词 + する）才连：
// 「夢だ」的 だ 不连到 夢 上，て 后面的 も / は 也不连（它们是另外的助词，只是选中时不妨碍还原）。
const TAIL_PARTICLES = new Set(['て', 'で', 'ば', 'ながら', 'つつ']);
const TAIL_CONTRACTED = new Set(['てる', 'でる', 'ちゃう', 'じゃう', 'とく', 'どく', 'ちまう', 'じまう']);
const TAIL_CHAU = new Set(['ちゃう', 'じゃう', 'ちまう', 'じまう']); // 这几个有时被标成独立的动词
function tailFlags(raw) {
  const out = [];
  let afterTe = false;  // 上一个是不是接续的 て / で
  let afterCha = false; // 上一个是不是口语的 ちゃ / じゃ（后面的 う / え / お 是它的词尾：ちゃう、ちゃえ、ちゃお）
  let open = false;     // 现在这一段的开头是不是会变形的词（后面的尾巴才连上去）
  raw.forEach((t, i) => {
    const s = t.surface_form, d1 = t.pos_detail_1, b = t.basic_form;
    const prev = raw[i - 1], next = raw[i + 1];
    const prevRenyo = prev?.pos === '動詞' && /^連用/.test(prev.conjugated_form || '');
    let f = false, te = false, cha = false, loose = false;
    if (i > 0) {
      if (afterCha && /^[うえお]$/.test(s)) f = true;
      else if (t.pos === '助動詞') f = true;
      else if (t.pos === '助詞') {
        if (d1 === '接続助詞' && TAIL_PARTICLES.has(s)) { f = true; te = s === 'て' || s === 'で'; }
        else if (d1 === '接続助詞' && (s === 'ちゃ' || s === 'じゃ') && (prevRenyo || prev.pos === '助動詞')) { f = true; cha = true; }
        else if (d1 === '並立助詞' && (s === 'たり' || s === 'だり')) f = true;
        else if (d1 === '係助詞' && (s === 'も' || s === 'は') && afterTe) { f = true; loose = true; }
        else if (s === 'に' && prev.pos === '助動詞' && prev.surface_form === 'ず') f = true; // 言わずに
        else if (s === 'じゃ' && next?.basic_form === 'ない') { f = true; loose = true; }     // 夢じゃない、静かじゃない
      } else if (t.pos === '動詞') {
        if (d1 === '接尾') f = true;
        else if (d1 === '非自立' && (afterTe || TAIL_CONTRACTED.has(b) || (b === 'なさる' && prevRenyo))) { f = true; te = s === 'て' || s === 'で'; }
        else if (TAIL_CHAU.has(b) && prevRenyo) f = true; // 走っ + ちゃう
      } else if (t.pos === '形容詞') {
        if (d1 === '非自立' && afterTe && (b === 'ほしい' || b === '欲しい')) f = true; // 走ってほしい
      } else if (t.pos === '名詞' && d1 === '接尾' && t.pos_detail_2 === '助動詞語幹') f = true;
    }
    // サ变名词后面的 する / できる：不是尾巴（它自己是动词），但和前面的名词是一个单位（勉強した、勉強できる）
    const suru = !f && t.pos === '動詞' && (b === 'する' || b === 'できる') && prev?.pos === '名詞' && prev.pos_detail_1 === 'サ変接続';
    const j = suru || (f && !loose && open);
    out.push({ f, j });
    if (suru) open = true;
    else if (f) open = open && !loose;
    else open = t.pos === '動詞' || t.pos === '形容詞' || (t.pos === '名詞' && d1 === '形容動詞語幹');
    afterTe = te;
    afterCha = cha;
  });
  return out;
}

// ---------------- 恋して ----------------
// 分词器会把「恋して / 恋してる」里的「恋し」当成形容词「恋しい」的词干。可形容词的词干后面不会直接跟
// て / た（那得是 恋しくて、恋しかった），所以这种只能是「名词 + する」：拆成 恋 + し（する）。
function fixSuru(raw) {
  const out = [];
  raw.forEach((t, i) => {
    const next = raw[i + 1];
    const stem = t.surface_form.slice(0, -1);
    const teTa = next && ((next.pos === '助詞' && next.pos_detail_1 === '接続助詞' && next.surface_form === 'て')
      || (next.pos === '助動詞' && next.basic_form === 'た')
      || (next.pos === '動詞' && next.pos_detail_1 === '非自立' && TAIL_CONTRACTED.has(next.basic_form)));
    if (t.pos === '形容詞' && t.conjugated_form === 'ガル接続' && t.surface_form.endsWith('し') && stem && teTa) {
      const r = (t.reading || '').slice(0, -1);
      out.push({ ...t, surface_form: stem, basic_form: stem, pos: '名詞', pos_detail_1: 'サ変接続', pos_detail_2: '*', conjugated_type: '*', conjugated_form: '*', reading: r, pronunciation: r });
      out.push({ surface_form: 'し', basic_form: 'する', pos: '動詞', pos_detail_1: '自立', pos_detail_2: '*', pos_detail_3: '*', conjugated_type: 'サ変・スル', conjugated_form: '連用形', reading: 'シ', pronunciation: 'シ', word_type: 'KNOWN' });
    } else out.push(t);
  });
  return out;
}

// ---------------- いたんだ ----------------
// 假名写的「いたんだ」分词器会当成「いたむ」（痛む / 傷む）的过去式：君がいたんだよ → 君 + が + いたん（痛む）+ だ。
// 可歌词里它几乎都是「いる + た + んだ」（在、一直…着）：真要写「痛んだ」多半会用汉字。
// 所以假名的 いたん 后面跟着 だ / で / じゃ 时拆成 い（いる）+ た + ん；只有前面明摆着是会疼、会坏的东西
// （胸がいたんだ、心がいたんで）才留给「痛む」。汉字写的不动。
// 后面是「た」的（いたんた）也算：「痛む」后面只能是 だ，这只可能是歌词把 いたんだ 打错了。
const ITAMU_SUBJECT = new Set(['胸', '心', '傷', '頭', '体', '身体', '足', '脚', '腕', '手', '指', '歯', '腹', 'お腹', '目', '耳', '喉', '背中', '腰', '傷口', '古傷', '傷跡', '髪', '肌', 'こころ', 'むね', 'きず', 'からだ']);
function fixIta(raw) {
  const out = [];
  raw.forEach((t, i) => {
    const next = raw[i + 1], prev = raw[i - 1];
    const nda = next && ((next.pos === '助動詞' && /^(だ|た)$/.test(next.basic_form)) || (next.pos === '助詞' && /^(で|じゃ)$/.test(next.surface_form)));
    if (!(t.surface_form === 'いたん' && t.basic_form === 'いたむ' && nda)) {
      // 上面拆出来的 ん 后面的 だ 是判断的「だ」，不再是「た」的浊音
      const afterN = out.length && out[out.length - 1].ita && t.pos === '助動詞' && t.basic_form === 'だ';
      return out.push(afterN ? { ...t, conjugated_type: '特殊・ダ' } : t);
    }
    const subj = prev?.pos === '助詞' && /^(が|は|も|の|って)$/.test(prev.surface_form) ? raw[i - 2] : prev;
    if (subj && subj.pos === '名詞' && ITAMU_SUBJECT.has(subj.surface_form)) return out.push(t);
    const afterTe = prev?.pos === '助詞' && prev.pos_detail_1 === '接続助詞' && /^(て|で)$/.test(prev.surface_form);
    const base = { pos_detail_2: '*', pos_detail_3: '*', word_type: 'KNOWN' };
    out.push({ ...base, surface_form: 'い', basic_form: 'いる', pos: '動詞', pos_detail_1: afterTe ? '非自立' : '自立', conjugated_type: '一段', conjugated_form: '連用形', reading: 'イ', pronunciation: 'イ' });
    out.push({ ...base, surface_form: 'た', basic_form: 'た', pos: '助動詞', pos_detail_1: '*', conjugated_type: '特殊・タ', conjugated_form: '基本形', reading: 'タ', pronunciation: 'タ' });
    out.push({ ...base, surface_form: 'ん', basic_form: 'ん', pos: '名詞', pos_detail_1: '非自立', pos_detail_2: '一般', conjugated_type: '*', conjugated_form: '*', reading: 'ン', pronunciation: 'ン', ita: 1 });
  });
  return out;
}

// ---------------- 旧假名 ----------------
// 有的歌词用旧假名写（想ひ出、言ふ、考へる）：念出来和现代写法一样，可分词器照现代写法才认得，
// 不处理的话「想ひ出」会被拆成 想（そう）+ ひ + 出，查到不相干的词。
// 所以分词前先悄悄换成现代写法（想い出），分完再把歌词原来的字换回去——显示的还是原文，只有原形和查词用现代写法。
// 现代文里 ひ / ふ / へ / ほ 紧跟在汉字后面的情况多得是（夢へ、恋ひとつ、歌ふたり），所以每一处都要验证：
// 换了以后它得和前面的汉字连成一个分词器认识的词，并且整句分出来的词更少。词数一样时，要满足下面之一才换：
//   - 原来那个词是文言活用（言ふ 的 四段）
//   - 换不换都是同一段、同一种词（考へる / 考える：分词器两种写法都收了，查词要用现代的）
//   - 实词变少了，而且那个假名原来不是某个名词的开头（奪はれた：奪 + はれる → 奪わ + れる；
//     「歌ふたり」的 ふたり 是名词，不动）
// ゐ / ゑ 现代文里不用，直接换。只做一个字换一个字的这几种，这样每个字在一句里的位置不变。
// は → わ（言はない）不做：汉字后面的 は 几乎都是助词，而「今わ」「歌わ」又恰好都是词，拿真实歌词试过会误伤。
const OLD_KANA = { ひ: 'い', ふ: 'う', へ: 'え', ほ: 'お' };
function modernSpelling(tokenizer, text) {
  let cur = text.replace(/ゐ/g, 'い').replace(/ゑ/g, 'え');
  let parsed = null;
  const content = (toks) => toks.filter((t) => t.pos === '副詞' || ((t.pos === '名詞' || t.pos === '動詞' || t.pos === '形容詞') && t.pos_detail_1 !== '接尾' && t.pos_detail_1 !== '非自立')).length;
  const tokenAt = (toks, i) => { let p = 0; for (const t of toks) { const e = p + t.surface_form.length; if (i < e) return { t, start: p }; p = e; } return null; };
  for (let i = 1; i < text.length; i++) {
    if (!OLD_KANA[text[i]] || !isKanji(text[i - 1])) continue;
    const next = cur.slice(0, i) + OLD_KANA[text[i]] + cur.slice(i + 1);
    const a = parsed || (parsed = tokenizer.tokenize(cur)), b = tokenizer.tokenize(next);
    const was = tokenAt(a, i), now = tokenAt(b, i);
    if (!was || !now || now.start >= i || now.t.word_type !== 'KNOWN') continue; // 换了也没和前面的汉字连成一个词
    let ok = b.length < a.length;
    if (!ok && b.length === a.length) {
      const classical = was.start < i && /四段|二段|文語/.test(was.t.conjugated_type || '');
      const sameWord = was.start === now.start && was.t.surface_form.length === now.t.surface_form.length && was.t.pos === now.t.pos;
      const fewer = content(b) < content(a) && !(was.start === i && was.t.pos === '名詞');
      ok = classical || sameWord || fewer;
    }
    if (ok) { cur = next; parsed = b; }
  }
  return cur;
}
// 分完词以后，把换过的字换回歌词原来的样子；seg.m 记下现代写法，和罗马音对齐时两种都认
function restoreSpelling(tokens, text) {
  for (const tok of tokens) {
    if (text.startsWith(tok.s, tok.i0)) continue;
    let p = tok.i0;
    for (const seg of tok.segs) {
      const orig = text.slice(p, p + seg.t.length);
      p += seg.t.length;
      if (orig !== seg.t) { seg.m = seg.t; seg.t = orig; }
    }
    tok.s = text.slice(tok.i0, tok.i0 + tok.s.length);
  }
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
      const modern = modernSpelling(tokenizer, line.text);
      const raw = fixIta(fixSuru(fixMitai(tokenizer.tokenize(modern))));
      const tails = tailFlags(raw);
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
        if (tails[ri].f) tok.f = 1;
        if (tails[ri].j) tok.j = 1;
        if (t.pos === '助詞' && t.pos_detail_1 === '終助詞') tok.fin = 1; // 句末的语气词（よ、ね、な、ぜ…）
        if (t.word_type === 'UNKNOWN' && [...s].some(isKanji)) tok.u = 1; // 分词器不认识的词：查到的词条要和读音对得上才用
        if (/^\s+$/.test(s)) tok.sp = 1;
        i0 += s.length;
        return tok;
      });
      if (modern !== line.text) restoreSpelling(tokens, line.text);
      mergeUnknownVerbs(tokens, raw);
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
      for (const tok of tokens) {
        for (const g of tok.segs) delete g.m;
        // 逐字歌词：多个汉字的注音段把读音按字拆开（宝物 → たから｜もの），前端用它让每个字各自抬起
        if (line.ct) for (const g of tok.segs) { const rs = g.r && splitKanjiReading(tokenizer, g.t, g.r); if (rs) g.rs = rs; }
        tok.r = tok.segs.map((g) => (g.r !== undefined ? g.r : toHira(g.t))).join('');
        const h = tok.v ? readingHint(tok) : '';
        if (h) tok.h = h;
      }

      // 语法点是在原始分词上匹配的，合并过词之后把下标换算过来
      const rawToTok = [];
      tokens.forEach((tok, ti) => { for (const ri of tok.raw) rawToTok[ri] = ti; delete tok.raw; });
      const rawAt = [0];
      for (const t of raw) rawAt.push(rawAt[rawAt.length - 1] + t.surface_form.length);
      // text 取歌词原文里的那一段（分词用的可能是换成现代写法的字）
      const grammar = matchGrammar(raw).map((g) => ({ ...g, text: line.text.slice(rawAt[g.start], rawAt[g.end]), start: rawToTok[g.start], end: rawToTok[g.end - 1] + 1 }));
      return { ...line, tokens, grammar };
    }),
  };
}
