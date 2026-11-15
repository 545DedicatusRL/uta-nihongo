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

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

// 有道日汉词典：返回 { zh, r } 或 null（没有这个词）
async function youdao(word, prefer) {
  const res = await fetch(`https://dict.youdao.com/suggest?num=5&ver=3.0&doctype=json&cache=false&le=ja&q=${encodeURIComponent(word)}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Youdao HTTP ${res.status}`);
  const j = await res.json();
  const entries = j.data?.entries || [];
  // show 形如「瞬き | またたき ⓪」或「まま | 儘 ⓪」
  const parts = (e) => String(e.show || '').replace(/[⓪①②③④⑤⑥⑦⑧⑨]/g, '').split('|').map((x) => x.trim()).filter(Boolean);
  const cands = entries.filter((e) => e.fromDict === '日汉' && (e.entry === word || parts(e).includes(word)));
  // 假名写的词同音词多（まま、なれる…）：优先选汉字写法与 Jisho 一致的那条
  const hit = (prefer && cands.find((e) => e.entry === prefer || parts(e).includes(prefer))) || cands.find((e) => e.entry === word) || cands[0];
  if (!hit || !hit.explain) return null;
  // 「【名词】眨眼；瞬间。闪烁。『…』是『…』的可能形。」→ 去掉词性标记和用法备注，保留前两个义项
  const senses = hit.explain.replace(/【[^】]*】/g, '').split(/[。]/).map((x) => x.trim())
    .filter((x) => x && !/[『「]/.test(x) && x.length <= 40);
  if (!senses.length) return null;
  const p = parts(hit).find((x) => x !== word && /^[\u3040-\u30ffー]+$/.test(x));
  return { zh: senses.slice(0, 2).join('；'), r: p || '' };
}
// 依次尝试几种写法（歌词里的异体字常查不到，如 出逢う → 出会う）
async function chineseMeaning(forms, prefer) {
  for (const f of forms) {
    const hit = await youdao(f, prefer);
    if (hit) return hit;
  }
  return null;
}

async function jisho(word) {
  const res = await fetch(`https://jisho.org/api/v1/search/words?keyword=${encodeURIComponent(word)}`, {
    headers: { 'User-Agent': UA },
    signal: AbortSignal.timeout(9000),
  });
  if (!res.ok) throw new Error(`Jisho HTTP ${res.status}`);
  const j = await res.json();
  const data = j.data || [];
  const exact = data.filter((d) => d.japanese.some((x) => x.word === word || (!x.word && x.reading === word) || x.reading === word));
  const pick = exact.find((d) => d.japanese[0].word === word || d.japanese[0].reading === word) || exact[0] || null;
  if (!pick) return { miss: 1 };
  const jp = pick.japanese.find((x) => x.word === word) || pick.japanese[0];
  const levels = (pick.jlpt || []).map((s) => Number(s.replace(/\D/g, ''))).filter(Boolean);
  return {
    w: jp.word || jp.reading,
    r: jp.reading || '',
    lv: levels.length ? `N${Math.max(...levels)}` : '',
    common: !!pick.is_common,
    en: pick.senses.slice(0, 3).map((s) => s.english_definitions.slice(0, 3).join(', ')),
    pos: (pick.senses[0]?.parts_of_speech || []).slice(0, 2),
    // 同一个词的其他写法（常用写法排在前面），查中文释义时用来回退
    alts: [...new Set(pick.japanese.map((x) => x.word).filter((x) => x && x !== word))].slice(0, 3),
  };
}

// 批量查询（带并发限制 + 本地缓存）。onlyCached=true 时不发网络请求。
export async function lookupWords(words, onlyCached = false) {
  const c = cache();
  const out = {};
  const todo = [];
  for (const w of new Set(words)) {
    if (c[w] && c[w].zh !== undefined) out[w] = c[w];
    else if (!onlyCached) todo.push(w);
    else if (c[w]) out[w] = c[w];
  }
  let i = 0;
  const worker = async () => {
    while (i < todo.length) {
      const w = todo[i++];
      try {
        const e = c[w] || await jisho(w);
        c[w] = e;
        dirty = true;
        out[w] = e;
        // 中文释义：先按原词查，再试其他写法；失败（网络问题）时不写 zh，下次重试
        const zh = await chineseMeaning([w, ...(e.alts || [])], e.w !== w ? e.w : undefined);
        if (zh) {
          e.zh = zh.zh;
          if (e.miss) { delete e.miss; e.w = w; e.r = zh.r; e.lv = ''; e.en = []; }
        } else e.zh = '';
      } catch { /* 网络失败：不缓存，下次重试 */ }
    }
  };
  await Promise.all([worker(), worker(), worker()]);
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
