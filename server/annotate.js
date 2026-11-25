// 词汇 / 语法标注的数据来源：
//   1. Jisho.org 公开 API：单词的读音、JLPT 级别、英文释义（免费，无需密钥，结果缓存在本地）
//   2. 有道词典（日汉）：中文释义（免费，无需密钥，结果缓存在本地）
//   3. Claude API（可选，需在设置里填 API Key）：整首歌的中文词汇释义 + 语法讲解
import Anthropic from '@anthropic-ai/sdk';
import { readJSON, writeJSON, getSettings, safeName } from './store.js';

// ---------------- Jisho ----------------
let dictCache = null;
let dirty = false;
function cache() {
  if (!dictCache) dictCache = readJSON('dict-cache-v2.json', {});
  return dictCache;
}
setInterval(() => {
  if (dirty) { dirty = false; writeJSON('dict-cache-v2.json', dictCache); }
}, 4000).unref();

// 清除缓存时用：把内存里的词典缓存也清掉（磁盘上的文件由调用方删除）
export function resetDictCache() { dictCache = {}; dirty = false; }

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

const toHira = (s) => String(s || '').replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const hasKanji = (s) => /[㐀-䶿一-鿿々〆]/.test(s);
const isKata = (s) => /^[ァ-ヶー]+$/.test(s) && /[ァ-ヶ]/.test(s);

// 读音只比假名：片假名当平假名，中间的点、空格之类不算
const normR = (r) => toHira(r).replace(/[^ぁ-ゖー]/g, '');

// 有道日汉词典：按一个写法（或读音）查，返回查到的全部词条
// [{ entry, forms: 这一条的各种写法, r: 读音, kanji: 释义里注明的汉字写法, zh, zhs }]
async function youdaoList(word) {
  const res = await polite('youdao', 120, `https://dict.youdao.com/suggest?num=5&ver=3.0&doctype=json&cache=false&le=ja&q=${encodeURIComponent(word)}`, 8000);
  if (!res.ok) throw new Error(`Youdao HTTP ${res.status}`);
  const j = await res.json();
  const out = [];
  for (const e of j.data?.entries || []) {
    if (e.fromDict !== '日汉' || !e.explain) continue;
    // 「【名词】眨眼；瞬间。闪烁。『…』是『…』的可能形。」→ 去掉词性标记和用法备注，按句号切成义项。
    // 词典里义项的先后并不总是按常用程度排（落ちる 的「掉、落」排在最后），所以全部保留：
    // zhs 是全部义项，交给界面按歌词语境挑；zh 是没有语境可用时的默认显示（前两个）。
    const body = e.explain.replace(/【[^】]*】/g, '');
    const senses = body.split(/[。]/).map((x) => x.trim()).filter((x) => x && !/[『「]/.test(x) && x.length <= 40);
    // 另一种写法的词条：「［声などが］人声嘈杂；［小声で］嘁嘁喳喳；［木の葉などが］沙沙作响． 町中が…（例句）」
    // 只取第一句，按分号切，去掉方括号里的日文语境说明，带假名的（例句）不要
    if (!senses.length) {
      senses.push(...body.split(/[。．]/)[0].split(/[；;]/)
        .map((x) => x.replace(/[［\[][^］\]]*[］\]]/g, '').trim())
        .filter((x) => x && !/[ぁ-ゖァ-ヺ『「]/.test(x) && x.length <= 40));
    }
    if (!senses.length) continue;
    // 假名词头的词条用空格分义项：「人，人类 别人，他人 社会上的人，一般人」
    if (senses.length === 1 && /\s/.test(senses[0]) && !/[a-zA-Z]/.test(senses[0])) senses.splice(0, 1, ...senses[0].split(/\s+/).filter(Boolean));
    // show 形如「瞬き | またたき ⓪」「まま | 儘 ⓪」「はな | 花/華 ["②"]」
    const forms = [...new Set([e.entry, ...String(e.show || '').replace(/\[[^\]]*\]|[⓪①②③④⑤⑥⑦⑧⑨]/g, '').split('|')]
      .flatMap((x) => x.split('/')).map((x) => x.trim()).filter(Boolean))];
    const r = forms.find((x) => /^[぀-ヿー]+$/.test(x)) || '';
    const kanji = [...e.explain.matchAll(/汉字：「([^」]+)」/g)].flatMap((m) => m[1].split(/[・、\/／]/)).map((x) => x.trim());
    out.push({ entry: e.entry, forms, r, kanji, zh: senses.slice(0, 2).join('；'), zhs: senses.slice(0, 8) });
  }
  return out;
}
// 假名写的词同音词多（まま、なれる…）：优先选汉字写法与 Jisho 一致的那条（prefer）
function pickYoudao(list, word, prefer) {
  const mine = list.filter((e) => e.entry === word || e.forms.includes(word));
  return (prefer && mine.find((e) => e.entry === prefer || e.forms.includes(prefer))) || mine.find((e) => e.entry === word) || mine[0] || null;
}
// 带汉字的词：中文释义要和读音对得上才用。同一个写法常有几个读音不同的词（辛い：からい / つらい），
// 直接查单个汉字还常常只查到同形的中文词条（花、空）。
//   readings = 这个词条的读音；lists(f) = 按 f 查到的全部词条；
//   allowBare = 都对不上时，可以退回用没标读音的同名词条（原来的做法；同形词的其他读音不能这样）
async function chineseByReading(forms, readings, lists, allowBare) {
  const mine = new Set(readings.map(normR).filter(Boolean));
  for (const f of forms) {
    const hit = (await lists(f)).find((x) => (x.entry === f || x.forms.includes(f)) && mine.has(normR(x.r)));
    if (hit) return hit;
  }
  // 换成用读音查，找写法里有这个词的那一条
  const byReading = async (test) => {
    for (const r of readings.slice(0, 2)) {
      const hit = (await lists(toHira(r))).find((x) => mine.has(normR(x.r)) && test(x, r));
      if (hit) return hit;
    }
    return null;
  };
  const exact = await byReading((x) => forms.some((f) => x.forms.includes(f) || x.kanji.includes(f)));
  if (exact) return exact;
  // 假名词头的词条（なつ【名词】夏天）：读音一样，中文释义里又有这个词的汉字，算对上
  const chars = [...forms[0]].filter((ch) => hasKanji(ch));
  const kana = await byReading((x, r) => normR(x.entry) === normR(r) && chars.some((ch) => x.zh.includes(ch)));
  if (kana) return kana;
  // 没标读音的同名词条（私、上 这类单字常见）：没法核对，但通常是对的
  if (allowBare) {
    const bare = (await lists(forms[0])).find((x) => x.entry === forms[0] && !x.r);
    if (bare) return bare;
  }
  return null; // 对不上读音的一律不用：宁可只显示英文释义，也不显示别的词的中文释义
}

// 假名词的同音词条 m（個々）的中文释义：先在「按假名查到的那些词条」里找写法对得上的，找不到再按它的汉字写法去查
async function chineseOfHomophone(word, m, lists) {
  const forms = [m.w, ...(m.alts || [])];
  const list = await lists(word);
  // 写法按常用程度一个一个试（慣れる 排在 馴れる 前面），不能谁先出现用谁
  for (const f of forms) { const hit = list.find((x) => x.entry === f || x.forms.includes(f)); if (hit) return hit; }
  // 假名词头的词条里注明了「汉字：…」：只注了这一个写法的才算数（かみ 那条把 上 / 長官 / 神 的释义都堆在一起）
  const noted = list.find((x) => x.kanji.length === 1 && x.kanji[0] === m.w);
  return noted || chineseByReading(forms, [m.r], lists, false);
}

// 按假名查到的「假名词头」那一条（はし、いる、わたし）能不能当作 kanjiForm 这个词的释义。它没写是哪个汉字，
// 多数时候就是最常用的那个词（いる → 在、わたし → 我），但也可能是另一个同音词的（はし 那条讲的是「端」）。不用它的情况：
//   - 它自己注明了汉字写法，里面却没有我们要的这个（かみ 那条注的是 上 / 長官 / 神，没有 紙）
//   - 它的释义和同一批结果里某个同音词条的释义明显是一回事（はし 那条和「端」那条都是「头、端、边」）
// 另外，这一条常把几个同音词的义项堆在一起（つま：头绪 / 前衣襟 / 妻子 / 山墙）：里面有带着这个词的汉字的义项（妻子）就把它提到最前面。
const hanOf = (x) => new Set([...x.zhs.slice(0, 2).join('').replace(/（[^）]*）|\([^)]*\)/g, '')].filter((ch) => /[\u4e00-\u9fff]/.test(ch)));
function kanaEntryFor(list, word, kanjiForm) {
  const mine = list.find((x) => x.entry === word);
  if (!mine || (mine.kanji.length && !mine.kanji.includes(kanjiForm))) return null;
  const own = [...kanjiForm].filter((ch) => hasKanji(ch));
  const hits = mine.zhs.filter((x) => own.some((ch) => x.includes(ch)));
  if (hits.length) return { ...mine, zh: hits.slice(0, 2).join('；'), zhs: [...hits, ...mine.zhs.filter((x) => !hits.includes(x))] };
  const a = hanOf(mine);
  for (const x of list) {
    if (x === mine || normR(x.r) !== normR(word)) continue;
    const b = hanOf(x);
    const both = [...b].filter((ch) => a.has(ch)).length;
    if (both && both / Math.min(a.size, b.size) >= 0.5) return null;
  }
  return mine;
}

// 两个词典都是免费的公开接口，问得太急会被限流（HTTP 429）：每个接口的请求之间留一点间隔，
// 被限流了就等一等再试，还不行才放弃（这个词下次再查）
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const nextAt = {};
async function polite(name, gap, url, timeout) {
  for (let attempt = 0; ; attempt++) {
    const now = Date.now();
    const at = Math.max(now, nextAt[name] || 0);
    nextAt[name] = at + gap;
    if (at > now) await sleep(at - now);
    const res = await fetch(url, { headers: { 'User-Agent': UA }, signal: AbortSignal.timeout(timeout) });
    if (res.status !== 429 || attempt >= 2) return res;
    nextAt[name] = Math.max(nextAt[name], Date.now() + 2500 * (attempt + 1)); // 其他正在排队的请求也跟着往后让
  }
}

async function jisho(word) {
  const res = await polite('jisho', 220, `https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(word)}`, 9000);
  if (!res.ok) throw new Error(`Jisho HTTP ${res.status}`);
  const j = await res.json();
  const data = j.data || [];
  const exact = data.filter((d) => d.japanese.some((x) => x.word === word || (!x.word && x.reading === word) || x.reading === word));
  const head = (d) => d.japanese[0].word === word || d.japanese[0].reading === word;
  let pick = exact.find(head) || exact[0] || null;
  if (!pick) return { miss: 1 };
  // 假名写的词同音词多，Jisho 排第一的不一定是歌词里这个（ここ：排第一的是「個々」N1，其实是「此処」N5）。
  // 排第一的那条平时是写汉字的话，在常用的同音词里换一条更合适的：
  //   - 「通常只写假名」的那条，只要不比原来那条难（くも：「蜘蛛」虽然通常写假名，但「雲」更基础，不换）
  //   - 没有的话，明显更基础的那条（いま：排第一的是「居間」N3，换成「今」N5）
  const kana = !hasKanji(word);
  const basic = (d) => Math.max(0, ...(d.jlpt || []).map((x) => Number(x.replace(/\D/g, '')) || 0)); // N5 = 5 最基础，没有级别 = 0
  const kanaWord = (d) => !d.japanese[0].word || d.senses.slice(0, 2).some((x) => (x.tags || []).includes('Usually written using kana alone'));
  if (kana && !kanaWord(pick)) {
    const cands = exact.filter((d) => d !== pick && head(d) && d.is_common);
    const alt = cands.find((d) => kanaWord(d) && basic(d) >= Math.max(basic(pick), 1))
      || cands.filter((d) => basic(d) > basic(pick)).sort((x, y) => basic(y) - basic(x))[0];
    if (alt) pick = alt;
  }
  // 排第一的那条有汉字写法、而且不常用，同音词里却有一条「根本没有汉字写法」的常用词：歌词里写假名的多半是后者。
  // ほら：排第一的是「法螺」（吹牛 / 海螺，不常用，只是标了「通常写假名」所以上面那一步不换），
  // 其实是感叹词 ほら（看、瞧）。没有汉字写法的词条不会进下面的同音词名单，这里不换的话界面上连改选都选不到
  if (kana && pick.japanese[0].word && !pick.is_common) {
    const plain = exact.find((d) => d !== pick && head(d) && d.is_common && !d.japanese[0].word);
    if (plain) pick = plain;
  }
  const entry = (d) => {
    const jp = d.japanese.find((x) => x.word === word) || d.japanese[0];
    const levels = (d.jlpt || []).map((s) => Number(s.replace(/\D/g, ''))).filter(Boolean);
    // 同一个词条的其他读音（運命：うんめい / さだめ）——意思相同，只是读法不同
    const rs = [...new Set(d.japanese.filter((x) => x.word === word && x.reading && x.reading !== jp.reading).map((x) => x.reading))].slice(0, 4);
    return {
      ...(rs.length ? { rs } : {}),
      w: jp.word || jp.reading,
      r: jp.reading || '',
      lv: levels.length ? `N${Math.max(...levels)}` : '',
      common: !!d.is_common,
      uk: kanaWord(d) ? 1 : 0, // 平常只写假名（或者根本没有汉字写法）
      en: d.senses.slice(0, 3).map((s) => s.english_definitions.slice(0, 3).join(', ')),
      pos: (d.senses[0]?.parts_of_speech || []).slice(0, 2),
      // 同一个词的其他写法（常用写法排在前面），查中文释义时用来回退
      alts: [...new Set(d.japanese.map((x) => x.word).filter((x) => x && x !== word))].slice(0, 3),
    };
  };
  const out = entry(pick);
  // 同一个写法、读音不同的其他词条（辛い：からい / つらい，開く：あく / ひらく）也留着，
  // 之后按歌词里实际唱的读音来选，不用再联网
  if (hasKanji(word)) {
    const seen = new Set([out.r, ...(out.rs || [])].map(toHira));
    const more = [];
    for (const d of exact) {
      if (d === pick || !d.japanese.some((x) => x.word === word)) continue;
      const m = entry(d);
      if (!m.r || seen.has(toHira(m.r))) continue;
      for (const r of [m.r, ...(m.rs || [])]) seen.add(toHira(r));
      more.push(m);
      if (more.length >= 3) break;
    }
    if (more.length) out.more = more;
  } else {
    // 假名写的词：同音的其他词条（ここ：個々、はし：橋 / 箸 / 端）也留着，界面上可以改选；只留常用的或有级别的
    out.kv = KV;
    const seen = new Set([out.w]);
    const more = [];
    for (const d of exact) {
      // 要是「主要读音就是这个假名」的词条（九 也能读 ここ、嘴 也能读 はし，那种不算）；没有汉字写法的分不出谁是谁，也不要
      if (d === pick || !(d.is_common || (d.jlpt || []).length) || !head(d)) continue;
      const m = entry(d);
      if (!m.w || m.w === word || seen.has(m.w)) continue;
      seen.add(m.w);
      more.push(m);
      if (more.length >= 3) break;
    }
    if (more.length) out.more = more;
  }
  return out;
}

// ---- 按读音选词条 ----
const CV = 3; // 缓存里带了这个标记的条目，才保证已经把「其他读音的词条」一起存下来了
const KV = 2; // 假名写的词：带了这个标记的条目，才是按「通常只写假名」挑过、并且存了同音词条的
// 2 比 1 多了一条规则（不常用的汉字词让位给没有汉字写法的常用词，见 jisho）。旧的 1 里只有「选中的是不常用的汉字词」
// 那些可能受影响，只重查它们，其余的照旧用，不必把所有假名词都重查一遍
const kanaFresh = (e) => e.kv === KV || (e.kv === 1 && (e.common || !hasKanji(e.w || '')));
// 词条的读音和提示对不对得上：2 = 完全一样，1 = 以它开头（提示只有词干那一段），0 = 对不上
const fitRank = (r, h) => { const x = toHira(r); return !x || !h ? 0 : x === h ? 2 : x.startsWith(h) ? 1 : 0; };
function select(e, h) {
  const { more, rs, ...main } = e;
  if (!h || e.miss) return main;
  let best = main, bestR = main.r, rank = -1;
  for (const cand of [e, ...(more || [])]) {
    for (const r of [cand.r, ...(cand.rs || [])]) {
      const k = fitRank(r, h);
      if (k > rank) { best = cand; bestR = r; rank = k; }
    }
  }
  const { more: _m, rs: _r, ...flat } = best;
  return { ...flat, r: rank > 0 ? bestR : main.r, ...(rank > 0 ? {} : main), fit: rank > 0 };
}
// 这条缓存要不要重新查：没有中文释义那一步的旧缓存；或者是带着读音提示来查、缓存却还是旧格式
// （旧格式只存了一个词条，同一个写法的其他读音没存下来）。每个词只会重查这一次。
// 假名写的词还要看 KV（见上）。
const stale = (e, h, w) => e.zhs === undefined || (!e.miss && ((!!h && e.cv !== CV) || (!!w && !hasKanji(w) && !kanaFresh(e))));

// 人称代词在词典里排在前面的是同形的另一个义项（僕＝仆人、君＝君主）；那些义项本身没错，
// 但歌词里几乎总是代词，所以这里直接给出代词义
const ZH_FIX = {
  僕: '我（男性自称）', ぼく: '我（男性自称）', ボク: '我（男性自称）',
  君: '你（对平辈或晚辈）', きみ: '你（对平辈或晚辈）', キミ: '你（对平辈或晚辈）', 俺: '我（男性自称，较随意）',
  // 指示词：词典里是一大段语法说明（「近称指示代名词；指说话人现在所在的地方」）
  ここ: '这里，这儿', そこ: '那里，那儿', あそこ: '那边，那儿', どこ: '哪里，哪儿',
};
const withFix = (w, e) => (ZH_FIX[w] && e && !e.miss ? { ...e, zh: ZH_FIX[w], zhs: [ZH_FIX[w]] } : e);

// 可能形和使役形：分词器把「許せる」「歌わす」当成独立的词，词典里收的却是「許す」「歌う」。
// 光看词形分不出来——「開ける」「届ける」「進める」长得一样，却是另外的词——所以让词典来判断：
//   可能形（え段 + る）：词典里没有这个词，或者词典的解释就是「能…」（to be able to…），而把 え段 换成 う段
//                        之后是个查得到的动词 → 用那个动词（許せる → 許す、走れる → 走る、見れる → 見る）
//   使役形（あ段 + す / せる）：词典里没有这个词，换成 う段 之后是个查得到的动词（歌わす → 歌う）
// 词典里本来就有、解释也不是「能…」的（開ける、笑える、泣かせる）不动。
const E2U = { え: 'う', け: 'く', げ: 'ぐ', せ: 'す', て: 'つ', ね: 'ぬ', べ: 'ぶ', め: 'む', れ: 'る' };
const A2U = { わ: 'う', か: 'く', が: 'ぐ', さ: 'す', た: 'つ', な: 'ぬ', ば: 'ぶ', ま: 'む', ら: 'る' };
const ABLE = /^(to be able to|to be possible to|can )/i;
function derivedFrom(w, e) {
  let m = w.match(/^(.+)([えけげせてねべめれ])る$/);
  if (m && (e.miss || ABLE.test(e.en?.[0] || ''))) return { w: m[1] + E2U[m[2]], kind: 'pot', cut: m[2] };
  m = w.match(/^(.+)([わかがさたなばまら])(?:せる|す)$/);
  if (m && e.miss) return { w: m[1] + A2U[m[2]], kind: 'caus', cut: m[2] };
  return null;
}
// 读音提示是「词干」那一段（ゆるせ）：去掉变掉的那个假名以后（ゆる）才对得上原形（ゆるす）
const hintFor = (h, cut) => { const at = h.lastIndexOf(cut); return at > 0 ? h.slice(0, at) : ''; };

// 批量查询（带并发限制 + 本地缓存）。onlyCached=true 时不发网络请求。
// words 里的每一项是「词」或「词|读音提示」（见 japanese.js 的 readingHint）；返回值按原样的键给回去。
// onlyCached 时，需要重新查的旧条目也先给回去，带上 stale 标记，界面先用着，再联网补。
export async function lookupWords(words, onlyCached = false) {
  const c = cache();
  const out = {};
  const keys = [...new Set(words)].map((key) => { const at = key.indexOf('|'); return at < 0 ? { key, w: key, h: '' } : { key, w: key.slice(0, at), h: key.slice(at + 1) }; });
  const todo = new Map(); // 词 → 要不要连 Jisho 也重新查
  for (const { w, h } of keys) {
    const e = c[w];
    if (e && !stale(e, h, w)) continue;
    if (!onlyCached) todo.set(w, todo.get(w) || !e || e.zhs !== undefined);
  }
  const fill = async (list) => {
    let i = 0;
    const worker = async () => {
      while (i < list.length) {
        const [w, fresh] = list[i++];
        try {
          const e = fresh ? await jisho(w) : c[w];
          // 中文释义：先按原词查，再试其他写法；失败（网络问题）时不写进缓存，下次重试
          const lists = new Map();
          const listFor = async (f) => { if (!lists.has(f)) lists.set(f, await youdaoList(f)); return lists.get(f); };
          const forms = [w, ...(e.alts || [])];
          let zh = null;
          if (hasKanji(w) && !e.miss && e.r) zh = await chineseByReading(forms, [e.r, ...(e.rs || [])], listFor, true);
          else if (e.kv && !e.miss && e.w && hasKanji(e.w)) {
            // 假名词、选中的词条有汉字写法（はし → 橋）：按那个写法找中文释义。找不到时才用按假名查到的那一条，
            // 而且要看着不像是别的同音词的释义（见 kanaEntryFor），不然宁可只显示英文
            zh = await chineseOfHomophone(w, e, listFor) || kanaEntryFor(await listFor(w), w, e.w);
          } else for (const f of forms) { zh = pickYoudao(await listFor(f), f, e.w !== w ? e.w : undefined); if (zh) break; }
          if (zh) {
            e.zh = zh.zh;
            e.zhs = zh.zhs;
            if (e.miss) { delete e.miss; e.w = w; e.r = zh.r; e.lv = ''; e.en = []; }
          } else { e.zh = ''; e.zhs = []; }
          for (const m of e.more || []) {
            // 汉字词的其他读音：还是查这个写法，按读音对；假名词的同音词条：按那一条的汉字写法找
            const hit = e.kv ? await chineseOfHomophone(w, m, listFor) : await chineseByReading([w], [m.r, ...(m.rs || [])], listFor, false);
            m.zh = hit ? hit.zh : '';
            m.zhs = hit ? hit.zhs : [];
          }
          e.cv = CV;
          c[w] = e;
          dirty = true;
        } catch { /* 网络失败：不缓存，下次重试 */ }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  };
  await fill([...todo]);
  // 可能形 / 使役形：要用到原形的词条，没查过的这时候补查
  const via = new Map();
  const more = new Map();
  for (const { key, w, h } of keys) {
    const e = c[w];
    const dv = e && e.zhs !== undefined ? derivedFrom(w, e) : null;
    if (!dv) continue;
    dv.h = hintFor(h, dv.cut);
    via.set(key, dv);
    const e2 = c[dv.w];
    if (!onlyCached && (!e2 || stale(e2, dv.h, dv.w))) more.set(dv.w, more.get(dv.w) || !e2 || e2.zhs !== undefined);
  }
  if (more.size) await fill([...more]);
  // 片假名写的词：歌词常把和语词写成片假名（ココロ、ナミダ），照片假名查不到，或者查到的是另一个不相干的词
  // （アイ：查到的是字母 I / eye，其实是「愛」；ウソ：查到的是一种鸟，其实是「嘘」）。这时再按平假名查一次：
  //   - 照片假名查不到 → 用平假名查到的（太生僻的不算，见下面）；
  //   - 两边都有 → 默认信片假名的那条（サイコ = psycho，不是「最古」）。只有片假名那条不是常用词、
  //     而平假名那条是有级别的基础词、而且平常是写汉字的（アイ → 愛、ソラ → 空、ウソ → 嘘）才换成平假名的。
  //     平常就写假名的词（だいぶ）不换：真想写它不会特意写成片假名，ダイブ 还是 dive；
  //   - 没选上的那一边作为候选一起给界面：界面会按这一行的中文翻译自动挑，也可以手动改选。
  // 片假名那条本身就是常用词的（テレビ、キス、ママ）不用再查。
  const kata = new Map();
  const more2 = new Map();
  for (const { key, w } of keys) {
    const e = c[w];
    if (!isKata(w) || !e || e.zhs === undefined || !(e.miss || !e.common)) continue;
    const hw = toHira(w);
    kata.set(key, hw);
    const e2 = c[hw];
    // 「平常写不写汉字」（uk）是后来才存的：两边都有、要靠它来定的时候，旧缓存里没有就重新查这一个词
    const need = !e2 || stale(e2, '', hw) || (!e.miss && !e2.miss && e2.uk === undefined);
    if (!onlyCached && need) more2.set(hw, more2.get(hw) || !e2 || e2.zhs !== undefined);
  }
  if (more2.size) await fill([...more2]);
  // 查过了还是没有这个标记的（Jisho 里没有、只有中文词典里有的词）：记成「不知道 = 不换」，免得每次都重查
  for (const hw of more2.keys()) { const x = c[hw]; if (x && x.uk === undefined) { x.uk = 1; dirty = true; } }
  const asHoms = (e) => (e.miss ? [] : [e, ...(e.kv ? e.more || [] : [])]).filter((m) => m.zh || m.en?.length).map((m) => ({ w: m.w, r: m.r, lv: m.lv, zh: m.zh || '', zhs: m.zhs || [], en: m.en || [] }));
  for (const { key, w, h } of keys) {
    const e = c[w];
    if (!e) continue;
    const old = stale(e, h, w);
    if (old && !onlyCached && e.zhs === undefined) continue; // 这次没查成：不给半截的结果
    out[key] = withFix(w, select(e, h));
    // 假名词的同音词条：一起给界面，改选义项时能选到（各带各的写法和级别）
    const homs = e.kv ? (e.more || []).filter((m) => m.zh || m.en?.length).map((m) => ({ w: m.w, r: m.r, lv: m.lv, zh: m.zh || '', zhs: m.zhs || [], en: m.en || [] })) : [];
    if (homs.length) out[key] = { ...out[key], homs };
    if (old && onlyCached) out[key] = { ...out[key], stale: 1 };
    const hw = kata.get(key);
    if (hw) {
      const e2 = c[hw];
      if (e2 && e2.zhs !== undefined && !e2.miss) {
        // 照片假名查不到时也不是什么都收：平假名那条得是常用词、有级别，或者平常就写假名（よすが）；
        // 生僻的汉字词（フロウ → 不老）多半只是碰巧同音，宁可不显示
        const native = e.miss ? (e2.common || !!e2.lv || e2.uk !== 0) : (!e.common && e2.common && !!e2.lv && e2.uk === 0);
        if (native) out[key] = { ...withFix(w, withFix(hw, select(e2, ''))), homs: [...asHoms(e2).slice(1), ...asHoms(e)], kana: hw };
        else out[key] = { ...out[key], homs: [...(out[key].homs || []), ...asHoms(e2)] };
      } else if (onlyCached && (!e2 || e2.zhs === undefined)) out[key] = { ...out[key], stale: 1 }; // 平假名那边还没查过：联网后再补
    }
    const dv = via.get(key);
    if (!dv) continue;
    const e2 = c[dv.w];
    if (e2 && !e2.miss && e2.zhs !== undefined && (e2.pos || []).some((p) => /verb/i.test(p))) {
      // 给回原形的词条，带上是从哪个词、按哪种变形找过来的
      out[key] = { ...withFix(dv.w, select(e2, dv.h)), via: dv.kind, from: w };
    } else if (onlyCached && (!e2 || e2.zhs === undefined)) out[key] = { ...out[key], stale: 1 }; // 原形还没查过：先这样，联网后再补
  }
  return out;
}

// ---------------- Claude ----------------
const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['lines'],
  properties: {
    lines: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['i', 'grammar', 'vocab'],
        properties: {
          i: { type: 'integer', description: '输入里的行号' },
          grammar: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['pattern', 'level', 'text', 'explanation'],
              properties: {
                pattern: { type: 'string', description: '语法点的一般形式，如「〜てしまう」' },
                level: { type: 'string', enum: ['N5', 'N4', 'N3', 'N2', 'N1', ''] },
                text: { type: 'string', description: '该语法点在本行歌词里对应的原文片段，必须是该行的连续子串' },
                explanation: { type: 'string', description: '简体中文说明：含义 + 在这句歌词里的用法，40 字以内' },
              },
            },
          },
          vocab: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['text', 'base', 'reading', 'level', 'meaning'],
              properties: {
                text: { type: 'string', description: '歌词里出现的形式，必须是该行的连续子串' },
                base: { type: 'string', description: '辞书形' },
                reading: { type: 'string', description: '辞书形的平假名读音' },
                level: { type: 'string', enum: ['N5', 'N4', 'N3', 'N2', 'N1', ''] },
                meaning: { type: 'string', description: '简体中文释义，贴合这句歌词的语境，15 字以内' },
              },
            },
          },
        },
      },
    },
  },
};

const SYSTEM = `你是一位面向中文母语者的日语老师，正在为「听歌学日语」应用给歌词做标注。
用户会给你一首日语歌的歌词（每行带行号，可能附带中文翻译作参考）。请逐行标出值得学习的语法点和词汇。

要求：
- 每行最多 3 个语法点、4 个词汇；这一行没有值得讲的内容就返回空数组，不要硬凑。
- 语法点：助动词、接续形式、句型、惯用表达、文语/口语缩略形等。は、が、を、の、に 这类最基础的助词不用标。
- 词汇：实词（名词、动词、形容词、副词）。级别按 JLPT 估计；N5 的基础词（私、行く、見る 等）可以跳过。
- 歌词常用特殊读法（如「運命」读さだめ、「瞬間」读とき）；reading 只写辞书形的标准读音。
- text 字段必须原样取自该行歌词，不要改写。
- 所有说明用简体中文，简洁。`;

export function aiAvailable() {
  return !!(getSettings().apiKey || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
}

export function getAICache(sourceKey) {
  return readJSON(`ai/${safeName(sourceKey)}.json`, null);
}

// lines: [{ text, zh }]；返回 { byText: { 行文本: { grammar, vocab } }, model }
export async function annotateWithAI(sourceKey, lines) {
  const settings = getSettings();
  const client = settings.apiKey ? new Anthropic({ apiKey: settings.apiKey }) : new Anthropic();
  // 副歌会重复，同样的句子只发一次
  const uniq = [];
  const seen = new Set();
  for (const l of lines) {
    if (seen.has(l.text)) continue;
    seen.add(l.text);
    uniq.push({ i: uniq.length, ja: l.text, zh: l.zh || undefined });
  }

  const stream = client.beta.messages.stream({
    model: settings.model || 'claude-opus-5-5',
    max_tokens: 32000,
    betas: ['server-side-fallback-2026-07-01'],
    fallbacks: 'default',
    system: SYSTEM,
    output_config: { effort: 'medium', format: { type: 'json_schema', schema: SCHEMA } },
    messages: [{ role: 'user', content: JSON.stringify(uniq) }],
  });
  const message = await stream.finalMessage();
  if (message.stop_reason === 'refusal') throw new Error('模型拒绝了这次请求');
  if (message.stop_reason === 'max_tokens') throw new Error('输出被截断（歌词过长），请重试');
  const text = message.content.filter((b) => b.type === 'text').map((b) => b.text).join('');
  const parsed = JSON.parse(text);

  const byText = {};
  for (const item of parsed.lines || []) {
    const src = uniq[item.i];
    if (!src) continue;
    byText[src.ja] = {
      grammar: (item.grammar || []).filter((g) => src.ja.includes(g.text)),
      vocab: (item.vocab || []).filter((v) => src.ja.includes(v.text)),
    };
  }
  const result = { byText, model: message.model, at: Date.now() };
  writeJSON(`ai/${safeName(sourceKey)}.json`, result);
  return result;
}

// 把 SDK 的错误变成给用户看的中文提示
export function describeAIError(err) {
  if (err instanceof Anthropic.AuthenticationError) return 'API Key 无效，请在设置里检查';
  if (err instanceof Anthropic.PermissionDeniedError) return '这个 API Key 没有权限使用该模型';
  if (err instanceof Anthropic.NotFoundError) return '找不到该模型，请在设置里检查模型名';
  if (err instanceof Anthropic.RateLimitError) return '请求过于频繁，请稍后再试';
  if (err instanceof Anthropic.BadRequestError) return `请求被拒绝：${err.message}`;
  if (err instanceof Anthropic.APIConnectionError) return '连接不上 Claude API，请检查网络';
  if (err instanceof Anthropic.APIError) return `Claude API 错误（${err.status}）：${err.message}`;
  return err.message || String(err);
}
