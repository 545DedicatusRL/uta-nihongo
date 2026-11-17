// 把一段汉字的读音按字拆开：宝物 + たからもの → ['たから', 'もの']。
// 用途只有一个：逐字歌词里让每个汉字连同它头上的那几个假名各自抬起、各自算是不是长音（见 app.js 的 jpHTML / holdPlan）。
// 页面上注音的排版不受影响（还是整段注音居中放在整段汉字上面），所以这里拆错了也只是某个假名早一点或晚一点动，
// 不会让人看到错的读音。拆不出来（今日 = きょう 这类整个词才有读音的）就返回 null，那一段照旧当一个整体。
//
// 每个汉字有哪些读音，不另带字典，从分词器自带的词典里学：
//   1. 单个汉字的词（宝 = たから）、汉字后面跟假名的词（食べる → 食 = た）直接得到读音；
//   2. 多个汉字的词里，别的字都对得上、只剩一个字对不上的，剩下的那段读音就是这个字的候选（宝物 里 宝 = たから，
//      剩下 もの 给 物）。同一个候选要在两个以上的词里出现才算数——明日（あした）会给 日 提一个「した」，但只此一处。
//   反复几轮，直到学不出新的。
const KANJI = /[㐀-䶿一-鿿々〆]/;
const toHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));
const VOICED = { か: 'が', き: 'ぎ', く: 'ぐ', け: 'げ', こ: 'ご', さ: 'ざ', し: 'じ', す: 'ず', せ: 'ぜ', そ: 'ぞ', た: 'だ', ち: 'ぢ', つ: 'づ', て: 'で', と: 'ど', は: 'ば', ひ: 'び', ふ: 'ぶ', へ: 'べ', ほ: 'ぼ' };
const HALF = { は: 'ぱ', ひ: 'ぴ', ふ: 'ぷ', へ: 'ぺ', ほ: 'ぽ' };

// 一个读音放在词里的第 i 个字（共 n 个字）上时可能变成的样子：
// 不在词头的会浊化（連濁：もの → 宝物 的 もの 不变，但 花 + 火 → はなび）；不在词尾的会促音化（学 がく + 校 → がっこう）
function variants(r, i, n) {
  const out = [r];
  if (i > 0) {
    if (VOICED[r[0]]) out.push(VOICED[r[0]] + r.slice(1));
    if (HALF[r[0]]) out.push(HALF[r[0]] + r.slice(1));
  }
  if (i < n - 1 && r.length >= 2 && /[つくちき]$/.test(r)) for (const v of [...out]) out.push(v.slice(0, -1) + 'っ');
  return out;
}

let table = null; // Map：汉字 → Set(读音)
function candidates(chars, i) {
  const c = chars[i] === '々' && i > 0 ? chars[i - 1] : chars[i];
  return table.get(c) || [];
}
// 所有拆法里最好的一种：尽量用原样的读音（不靠浊化、促音化），返回 ['たから', 'もの'] 或 null
// total / from：chars 是一个更长的词里从第 from 个字开始的一截时用（决定哪些字算词头、词尾）
function segment(chars, reading, total = chars.length, from = 0) {
  const n = chars.length;
  let best = null, bestScore = -1;
  const walk = (i, at, parts, score) => {
    if (i === n) { if (at === reading.length && score > bestScore) { best = [...parts]; bestScore = score; } return; }
    if (at >= reading.length) return;
    for (const r of candidates(chars, i)) {
      variants(r, from + i, total).forEach((v, k) => {
        if (!reading.startsWith(v, at)) return;
        parts.push(v);
        walk(i + 1, at + v.length, parts, score + (k === 0 ? 1 : 0));
        parts.pop();
      });
    }
  };
  walk(0, 0, [], 0);
  return best;
}

// 一个词拆成「汉字段 + 读音」：食べ物 + たべもの → [['食', 'た'], ['物', 'もの']]；对不上就是空的
function kanjiRuns(surface, reading) {
  const runs = [];
  for (const ch of surface) {
    const type = KANJI.test(ch) ? 'K' : /[぀-ヿー]/.test(ch) ? 'H' : 'O';
    const last = runs[runs.length - 1];
    if (last && last.type === type) last.t += ch;
    else runs.push({ type, t: ch });
  }
  if (!runs.some((r) => r.type === 'K') || runs.some((r) => r.type === 'O')) return [];
  const re = new RegExp('^' + runs.map((r) => (r.type === 'K' ? '(.+?)' : toHira(r.t).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))).join('') + '$');
  const m = re.exec(reading);
  if (!m) return [];
  let g = 1;
  return runs.filter((r) => r.type === 'K').map((r) => [r.t, m[g++]]);
}

function build(tokenizer) {
  table = new Map();
  const add = (c, r) => { if (!table.has(c)) table.set(c, new Set()); const s = table.get(c); if (s.has(r)) return false; s.add(r); return true; };
  const multi = new Map(); // '宝物\tたからもの' → [chars, reading]
  const dict = tokenizer.token_info_dictionary;
  for (const key of Object.keys(dict.target_map)) {
    for (const id of dict.target_map[key]) {
      const f = dict.getFeatures(id).split(',');
      // 人名地名的读音太随意（名保美 = なおみ），不拿来学
      if (f[2] === '固有名詞' || !f[8] || f[8] === '*') continue;
      for (const [t, r] of kanjiRuns(f[0], toHira(f[8]))) {
        const chars = [...t];
        if (chars.length === 1) { if (chars[0] !== '々') add(chars[0], r); } else if (chars.length <= 4) multi.set(`${t}\t${r}`, [chars, r]);
      }
    }
  }
  for (let round = 0; round < 4; round++) {
    const votes = new Map(); // '物\tもの' → 出现在几个词里
    for (const [chars, reading] of multi.values()) {
      if (segment(chars, reading)) continue;
      const n = chars.length;
      for (let j = 0; j < n; j++) {
        if (chars[j] === '々') continue;
        // 第 j 个字不知道读音：左边的字从头对，右边的字从尾对，中间剩下的归它
        const left = j ? prefixes(chars.slice(0, j), reading, n) : [0];
        const right = j < n - 1 ? suffixes(chars.slice(j + 1), reading, j + 1, n) : [reading.length];
        const seen = new Set();
        for (const a of left) for (const b of right) {
          if (b - a < 1 || b - a > 5) continue;
          const r = reading.slice(a, b);
          if (/^[っんー]/.test(r) || seen.has(r)) continue;
          seen.add(r);
          votes.set(`${chars[j]}\t${r}`, (votes.get(`${chars[j]}\t${r}`) || 0) + 1);
        }
      }
    }
    let learned = 0;
    for (const [k, n] of votes) if (n >= 2) { const [c, r] = k.split('\t'); if (add(c, r)) learned++; }
    if (!learned) break;
  }
}
// chars 从 reading 的开头对起，能对到哪些位置
function prefixes(chars, reading, n) {
  let at = new Set([0]);
  chars.forEach((_, i) => {
    const next = new Set();
    for (const a of at) for (const r of candidates(chars, i)) for (const v of variants(r, i, n)) if (reading.startsWith(v, a)) next.add(a + v.length);
    at = next;
  });
  return [...at];
}
// chars（是整个词里从第 from 个字开始的那几个）从 reading 的结尾往回对，能对到哪些位置
function suffixes(chars, reading, from, n) {
  let at = new Set([reading.length]);
  for (let i = chars.length - 1; i >= 0; i--) {
    const next = new Set();
    for (const b of at) for (const r of candidates(chars, i)) for (const v of variants(r, from + i, n)) if (reading.endsWith(v, b)) next.add(b - v.length);
    at = next;
  }
  return [...at];
}

// 词典里对不上时的两条退路（都只是为了让每个字能各动各的，见文件开头）：
//   1. 只有一个字的读音不认识：别的字对上以后剩下的归它（過去 = か + こ）。只有一种剩法时才用
//   2. 还是不行（今日 = きょう 这种整个词才有读音的）：把读音按音数平均分给每个字（きょ + う）。音数比字数还少就算了
function oneUnknown(chars, reading) {
  const n = chars.length, found = [];
  for (let j = 0; j < n; j++) {
    if (chars[j] === '々') continue;
    const left = j ? prefixes(chars.slice(0, j), reading, n) : [0];
    const right = j < n - 1 ? suffixes(chars.slice(j + 1), reading, j + 1, n) : [reading.length];
    for (const a of left) for (const b of right) if (b > a) found.push([j, a, b]);
  }
  if (found.length !== 1) return null;
  const [j, a, b] = found[0];
  const head = j ? segment(chars.slice(0, j), reading.slice(0, a), n, 0) : [];
  const tail = j < n - 1 ? segment(chars.slice(j + 1), reading.slice(b), n, j + 1) : [];
  return head && tail ? [...head, reading.slice(a, b), ...tail] : null;
}
function evenly(chars, reading) {
  const morae = reading.match(/.[ぁぃぅぇぉゃゅょゎっんー]*/g) || []; // 小写假名、促音、拨音、长音跟着前一个音走
  const n = chars.length;
  if (morae.length < n) return null;
  const out = [];
  for (let i = 0, at = 0; i < n; i++) {
    const take = Math.round((morae.length * (i + 1)) / n) - Math.round((morae.length * i) / n);
    out.push(morae.slice(at, at + take).join(''));
    at += take;
  }
  return out.every(Boolean) ? out : null;
}

// text：一段全是汉字的字（宝物）；reading：它的读音。返回每个字的读音（['たから', 'もの']），实在分不了返回 null
export function splitKanjiReading(tokenizer, text, reading) {
  const chars = [...text];
  if (chars.length < 2 || !reading || !chars.every((c) => KANJI.test(c))) return null;
  if (!table) build(tokenizer);
  const r = toHira(reading);
  return segment(chars, r) || oneUnknown(chars, r) || evenly(chars, r);
}
// 建表要一秒左右：分词器准备好以后先建好，免得第一首歌多等这一秒
export function warmKanjiReadings(tokenizer) { if (!table) build(tokenizer); }
