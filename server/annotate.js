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
  const pick = exact.find((d) => d.japanese[0].word === word || d.japanese[0].reading === word) || exact[0] || null;
  if (!pick) return { miss: 1 };
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
  }
  return out;
}

// ---- 按读音选词条 ----
const CV = 3; // 缓存里带了这个标记的条目，才保证已经把「其他读音的词条」一起存下来了
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
const stale = (e, h) => e.zhs === undefined || (!!h && e.cv !== CV && !e.miss);

// 人称代词在词典里排在前面的是同形的另一个义项（僕＝仆人、君＝君主）；那些义项本身没错，
// 但歌词里几乎总是代词，所以这里直接给出代词义
const ZH_FIX = {
  僕: '我（男性自称）', ぼく: '我（男性自称）', ボク: '我（男性自称）',
  君: '你（对平辈或晚辈）', 俺: '我（男性自称，较随意）',
};
const withFix = (w, e) => (ZH_FIX[w] && e && !e.miss ? { ...e, zh: ZH_FIX[w], zhs: [ZH_FIX[w]] } : e);

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
    if (e && !stale(e, h)) continue;
    if (!onlyCached) todo.set(w, todo.get(w) || !e || e.zhs !== undefined);
  }
  const list = [...todo];
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
        else for (const f of forms) { zh = pickYoudao(await listFor(f), f, e.w !== w ? e.w : undefined); if (zh) break; }
        if (zh) {
          e.zh = zh.zh;
          e.zhs = zh.zhs;
          if (e.miss) { delete e.miss; e.w = w; e.r = zh.r; e.lv = ''; e.en = []; }
        } else { e.zh = ''; e.zhs = []; }
        for (const m of e.more || []) {
          const hit = await chineseByReading([w], [m.r, ...(m.rs || [])], listFor, false);
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
  for (const { key, w, h } of keys) {
    const e = c[w];
    if (!e) continue;
    const old = stale(e, h);
    if (old && !onlyCached && e.zhs === undefined) continue; // 这次没查成：不给半截的结果
    out[key] = withFix(w, select(e, h));
    if (old && onlyCached) out[key] = { ...out[key], stale: 1 };
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
