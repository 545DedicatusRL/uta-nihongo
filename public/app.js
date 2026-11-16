// 唱歌学日语 — 前端
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const clamp = (x, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const fmt = (s) => { s = Math.max(0, Math.round(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const KANJI = /[㐀-䶿一-鿿々〆]/;
const toHira = (s) => s.replace(/[ァ-ヶ]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0x60));

const api = {
  async get(url) { const r = await fetch(url); if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`); return r.json(); },
  async post(url, body) {
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || `HTTP ${r.status}`);
    return j;
  },
};
const control = (cmd, a, b) => api.post('/api/control', { cmd, a, b }).catch((e) => toast(`Apple Music 没有响应：${e.message}`));

// ---------------- 偏好（存在浏览器里） ----------------
const DEFAULT_PREFS = {
  view: 'apple', furi: true, zh: true, roma: false, ann: true,
  annStyle: 'chips', annMax: 4, annGrammar: true, annVocab: true, annSource: 'auto',
  levels: { N5: false, N4: true, N3: true, N2: true, N1: true, x: true },
  dictChar: false, dictPause: true, meaningLang: 'zh', autoSense: true,
};
let prefs = { ...DEFAULT_PREFS };
try { const saved = JSON.parse(localStorage.getItem('uta-prefs') || '{}'); prefs = { ...prefs, ...saved, levels: { ...prefs.levels, ...(saved.levels || {}) } }; } catch { /* 无痕模式等 */ }
const savePrefs = () => { try { localStorage.setItem('uta-prefs', JSON.stringify(prefs)); } catch { /* 忽略 */ } };

// ---------------- 状态 ----------------
const S = {
  player: null, track: null, song: null, lines: [], active: -2, offset: 0,
  dict: {}, loadToken: 0, mode: null, sel: null, fill: null, annByTok: {},
  seekHold: 0, dragging: false, pausedByDict: false, tapAlign: false,
};
const app = $('#app');

// ---------------- 播放时钟：服务端每 250ms 推一次进度，中间用本地时钟插值 ----------------
const clock = { pos: 0, at: performance.now(), playing: false };
const now = () => (clock.playing ? clock.pos + (performance.now() - clock.at) / 1000 : clock.pos);
function setClock(pos, playing = clock.playing) { clock.pos = pos; clock.at = performance.now(); clock.playing = playing; }

function onState(s) {
  if (s.bye) return showBye();
  if (s.focus) return window.focus(); // 点了程序坞图标：程序把浏览器叫到了前面，这里尽量让这个窗口排到最上
  if (s.close) return window.close(); // 界面换到别的浏览器重新打开了：这个窗口自己关掉
  if ('queue' in s) onQueue(s.queue);
  S.player = s;
  const playing = s.state === 'playing';
  app.classList.toggle('playing', playing);
  if (typeof s.pos === 'number' && performance.now() > S.seekHold) {
    const reported = s.pos + (playing ? (s.lag || 0) / 1000 : 0);
    const predicted = now();
    const diff = reported - predicted;
    if (!playing || !clock.playing || Math.abs(diff) > 0.15) setClock(reported, playing);
    else setClock(predicted + diff * 0.12, playing); // 小误差慢慢纠正，避免歌词抖动
  } else if (!playing) setClock(now(), false);
  else clock.playing = playing;

  const t = s.track;
  if (t && (!S.track || S.track.pid !== t.pid || S.track.name !== t.name)) loadSong(t);
  else if (!t && S.track) clearSong(s);
  else if (!t) showIdle(s);
}

function showIdle(s) {
  if (s.waiting) setStatus('正在等待 Apple Music 响应…<br>如果系统弹出了「想要控制 Music」的提示，请点「允许」。<br><span class="muted">也可能是 Music 里有未关闭的对话框。</span>');
  else if (!s.running) setStatus('Apple Music 还没有打开。<br>打开它播放一首歌，或者从左上角的「资料库」里选一首。');
  else if (s.err && /not authorized|不允许|-1743/.test(s.err)) setStatus('需要授权控制 Apple Music：<br>系统设置 → 隐私与安全性 → 自动化，允许本程序控制「音乐」。');
  else setStatus('在 Apple Music 里播放一首歌，或者从左上角的「资料库」里选一首。');
}
function clearSong(s) {
  S.track = null; S.song = null; S.lines = []; S.active = -2;
  $('#title').textContent = '未在播放';
  $('#artist').textContent = '';
  $('#src-badge').textContent = '';
  $('#scroll').innerHTML = '';
  renderFocus();
  setArt(null);
  showIdle(s);
}
const setStatus = (html) => { $('#status').innerHTML = html || ''; };

// ---------------- 载入歌曲 ----------------
function songURL(t, extra = '') {
  const q = new URLSearchParams({ pid: t.pid || '', name: t.name || '', artist: t.artist || '', album: t.album || '', duration: t.duration || 0 });
  return `/api/song?${q}${extra}`;
}
async function loadSong(track, { refresh = false, keep = false } = {}) {
  const token = ++S.loadToken;
  S.track = track;
  $('#title').textContent = track.name;
  $('#artist').textContent = [track.artist, track.album].filter(Boolean).join(' — ');
  if (!keep) {
    S.song = null; S.lines = []; S.active = -2; S.offset = 0; S.sel = null;
    $('#scroll').innerHTML = '';
    $('#src-badge').textContent = '';
    renderFocus();
    setArt(track);
    setStatus('正在匹配歌词…');
    updateDictBar();
  }
  let song;
  try { song = await api.get(songURL(track, refresh ? '&refresh=1' : '')); }
  catch (e) { if (token === S.loadToken) setStatus(`歌词加载失败：${esc(e.message)}`); return; }
  if (token !== S.loadToken) return;

  S.song = song;
  S.offset = song.offset || 0;
  S.hiddenAnn = new Set(song.hiddenAnn || []);
  S.senses = { ...(song.senses || {}) };
  S.lines = withGaps(song.lines);
  S.active = -2;
  updateOffsetLabel();
  const srcName = { netease: '网易云', qq: 'QQ音乐' }[song.source?.source] || '';
  $('#src-badge').textContent = song.lines.length ? [srcName, song.flags?.words ? '逐字' : '逐行', song.ai ? 'AI' : ''].filter(Boolean).join(' · ') : '';
  if (!song.lines.length) {
    setStatus(`${song.error ? esc(song.error) + '<br>' : ''}没有找到这首歌的歌词（可能是纯音乐）。<br><button class="btn" onclick="document.getElementById('btn-source').click()">手动选择歌词源</button>`);
  } else setStatus('');
  if (song.source?.cover) setArt(track, song.source.cover);
  renderLines();
  renderFocus();
  if (song.flags?.japanese) fetchDict(token);
}
const reloadSong = (opts = {}) => S.track && loadSong(S.track, { keep: true, ...opts });

// 长间奏插入「间奏」占位行（三个点）
function withGaps(lines) {
  const out = [];
  lines.forEach((l, i) => {
    const prevEnd = i ? lines[i - 1].end : 0;
    if (l.t - prevEnd > 6) out.push({ gap: true, t: prevEnd, end: l.t, text: '', tokens: [], grammar: [] });
    out.push(l);
  });
  return out;
}

// 封面：优先用 Apple Music 里的封面，取不到时用歌词源的封面
const art = { track: null, status: '', cover: '' };
function setArt(track, cover) {
  const img = $('#art'), bg = $('#bg-img');
  if (!track) { art.track = null; img.classList.remove('on'); bg.classList.remove('on'); return; }
  const show = (url) => {
    if (art.track !== track) return;
    img.src = url; img.classList.add('on');
    bg.style.backgroundImage = `url("${url}")`; bg.classList.add('on');
  };
  const probe = (url, onOK, onFail) => { const p = new Image(); p.onload = () => { show(url); onOK && onOK(); }; p.onerror = () => onFail && onFail(); p.src = url; };
  if (cover) {
    if (art.track !== track) return;
    art.cover = cover;
    if (art.status === 'fail') probe(cover);
    return;
  }
  art.track = track; art.status = 'loading'; art.cover = '';
  img.classList.remove('on');
  const fail = () => { if (art.track !== track) return; art.status = 'fail'; if (art.cover) probe(art.cover); };
  if (!track.pid) return fail();
  probe(`/api/artwork?pid=${encodeURIComponent(track.pid)}&current=1`, () => { if (art.track === track) art.status = 'ok'; }, fail);
}

// ---------------- 渲染歌词 ----------------
function jpHTML(line, li) {
  if (line.gap) return '<span class="dots"><span class="dots-g"><i></i><i></i><i></i></span></span>';
  let html = '';
  line.tokens.forEach((tok, ti) => {
    let ci = tok.i0, inner = '';
    tok.segs.forEach((seg, si) => {
      const c0 = ci;
      let chars = '';
      for (const ch of seg.t) { chars += `<span class="ch" data-c="${ci}">${esc(ch)}</span>`; ci += ch.length; }
      const isK = KANJI.test(seg.t);
      let timing = '';
      if (line.ct && line.ct[c0]) {
        const t0 = line.ct[c0][0], t1 = (line.ct[ci - 1] || line.ct[c0])[1];
        // --lt：唱到这个词时「抬起来」用多久，跟着这个词的时长走（长音慢慢抬，短音快一点）
        timing = ` data-t0="${t0}" data-t1="${t1}" style="--lt:${clamp(t1 - t0, 0.28, 0.9).toFixed(2)}s"`;
      }
      const cls = `seg${isK ? ' k' : ''}${seg.src ? ` src-${seg.src}` : ''}`;
      inner += `<span class="${cls}" data-si="${si}"${timing}>${isK && seg.r ? `<ruby>${chars}<rt>${esc(seg.r)}</rt></ruby>` : chars}</span>`;
    });
    html += `<span class="tok" data-ti="${ti}">${inner}</span>`;
  });
  return html;
}
function lineBody(line, li) {
  return `<div class="jp" lang="ja" data-li="${li}">${jpHTML(line, li)}</div>`
    + (line.roma ? `<div class="roma">${esc(line.roma)}</div>` : '')
    + (line.zh ? `<div class="zh">${esc(line.zh)}</div>` : '');
}
function renderLines() {
  $('#scroll').innerHTML = S.lines.map((line, li) =>
    `<div class="line${line.gap ? ' gap' : ''}${line.ct ? ' timed' : ''}" data-i="${li}">${lineBody(line, li)}<div class="ann"></div></div>`).join('');
  S.active = -2;
  paintSelection();
}

function renderFocus() {
  const i = S.active;
  const line = S.lines[i];
  const plain = (l) => (l && !l.gap ? esc(l.text) : '');
  const prev = S.lines[i - 1];
  $('#f-prev').innerHTML = plain(prev);
  $('#f-prev').dataset.i = prev && !prev.gap ? i - 1 : '';
  const next = S.lines[i < 0 ? 0 : i + 1];
  $('#f-next').innerHTML = plain(next);
  $('#f-next').dataset.i = next ? S.lines.indexOf(next) : '';
  const cur = $('#f-cur');
  cur.className = `f-cur${line?.ct ? ' timed' : ''}`;
  cur.innerHTML = line ? lineBody(line, i) : (S.lines.length ? '<div class="jp"><span class="dots idle"><span class="dots-g"><i></i><i></i><i></i></span></span></div>' : '');
  cur.style.animation = 'none'; void cur.offsetWidth; cur.style.animation = '';
  paintAnnotations();
  paintSelection();
}

// ---------------- 同步：当前行 / 逐字填充 / 进度条 ----------------
function findActive(t) {
  const L = S.lines;
  let lo = 0, hi = L.length - 1, ans = -1;
  while (lo <= hi) { const mid = (lo + hi) >> 1; if (L[mid].t <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1; }
  return ans;
}
// 弹簧缓动：按弹簧的物理模型算出一条曲线，交给浏览器的 linear() 缓动去跑，
// 这样动画全程在合成器线程上，不需要每帧用 JS 去算位置。
function springEasing(stiffness, damping, mass = 1) {
  if (!globalThis.CSS?.supports?.('animation-timing-function', 'linear(0, 1)')) return { easing: 'cubic-bezier(.2, .9, .25, 1)', ms: 650 };
  const dt = 1 / 480, step = 1 / 40, pts = [0];
  let x = 0, v = 0, t = 0, next = step;
  while (t < 2) {
    v += ((1 - x) * stiffness - v * damping) / mass * dt;
    x += v * dt;
    t += dt;
    if (t >= next) { pts.push(Math.round(x * 1000) / 1000); next += step; if (Math.abs(1 - x) < 0.0015 && Math.abs(v) < 0.02) break; }
  }
  pts[pts.length - 1] = 1;
  return { easing: `linear(${pts.join(', ')})`, ms: Math.round((pts.length - 1) * step * 1000) };
}
const SPRING = springEasing(100, 15); // 阻尼比 0.75：到位前只有一点点回弹
document.documentElement.style.setProperty('--spring', SPRING.easing);
document.documentElement.style.setProperty('--spring-ms', `${SPRING.ms}ms`);
const noMotion = matchMedia('(prefers-reduced-motion: reduce)');
const elScroll = $('#scroll');

function setActive(i) {
  const first = S.active === -2; // 刚渲染完：直接就位，不做动画
  S.active = i;
  hideSensePop();
  const apply = () => {
    const els = elScroll.children, a = Math.max(i, 0);
    for (let k = 0; k < els.length; k++) {
      const el = els[k];
      // 只改状态真的变了的行：离当前行 6 行以外的样子都一样
      const st = k === i ? 2 : k < i ? 1 : 0, d = Math.min(Math.abs(k - a), 6);
      if (el._st !== st) { el._st = st; el.classList.toggle('active', st === 2); el.classList.toggle('past', st === 1); }
      if (el._d !== d) { el._d = d; el.style.setProperty('--d', d); }
    }
    renderFocus();
    jumpToActive();
  };
  if (first) apply(); else glide(apply, i);
  collectFill();
}
function collectFill() {
  const line = S.lines[S.active];
  S.fill = null;
  if (!line) return;
  const root = prefs.view === 'focus' ? $('#f-cur') : elScroll.children[S.active];
  if (!root) return;
  if (line.gap) S.fill = { gap: true, line, g: $('.dots-g', root), dots: $$('.dots-g i', root).map((el) => ({ el, p: -1 })), s: '', o: '' };
  else if (line.ct) {
    S.fill = { segs: $$('.seg', root).filter((el) => el.dataset.t0).map((el) => {
      el.classList.remove('on');
      return { el, t0: +el.dataset.t0, t1: +el.dataset.t1, d: Math.max(0.05, el.dataset.t1 - el.dataset.t0), p: -1, on: false };
    }) };
  }
}

// ---------------- 滚动：让当前行停在偏上的位置 ----------------
// 滚动位置本身是直接跳过去的；「跳之前」和「跳之后」各量一次看得见的那些行在哪，
// 再让每一行从原来的位置用弹簧动画滑到新位置（FLIP）。下面的行依次晚一点出发，
// 就有了一行带着一行走的感觉。当前行底下的标注出现 / 消失造成的挤动也一起被这个动画吸收。
let freeTimer = 0;
let glideAnims = [];
function jumpToActive() {
  if (prefs.view !== 'apple' || elScroll.classList.contains('free')) return;
  const el = elScroll.children[Math.max(S.active, 0)];
  if (el) elScroll.scrollTop = el.offsetTop - elScroll.clientHeight * 0.3;
}
// 视口上下各多看 pad 像素，返回这一段里的行的下标范围
function visibleRange(pad) {
  const els = elScroll.children, n = els.length;
  if (!n) return [0, -1];
  const top = elScroll.scrollTop - pad, bot = elScroll.scrollTop + elScroll.clientHeight + pad;
  let a = 0, b = n - 1;
  while (a < b) { const m = (a + b) >> 1; if (els[m].offsetTop + els[m].offsetHeight < top) a = m + 1; else b = m; }
  const lo = a;
  b = n - 1;
  while (a < b) { const m = (a + b + 1) >> 1; if (els[m].offsetTop > bot) b = m - 1; else a = m; }
  return [lo, a];
}
function glide(change, pivot = S.active) {
  if (prefs.view !== 'apple' || noMotion.matches || document.hidden || !elScroll.children.length) return change();
  const els = elScroll.children, H = elScroll.clientHeight;
  // 之前：量位置（包含还没播完的上一次动画的位移，所以连续换行时能从半路接着走）
  const [lo1, hi1] = visibleRange(H * 0.6);
  const before = new Map();
  for (let k = lo1; k <= hi1; k++) before.set(k, els[k].getBoundingClientRect().top);
  const scroll0 = elScroll.scrollTop;
  for (const an of glideAnims) an.cancel();
  glideAnims = [];
  change();
  // 之后
  const [lo2, hi2] = visibleRange(H * 0.2);
  const far = clamp(elScroll.scrollTop - scroll0, -H * 0.5, H * 0.5); // 之前不在视野里的行（比如拖了进度）：从不远处滑进来
  const a = Math.max(pivot, 0);
  const up = elScroll.scrollTop >= scroll0;
  for (let k = Math.min(lo1, lo2); k <= Math.max(hi1, hi2); k++) {
    if (k > hi2 + 2 || k < lo2 - 2) continue; // 换完以后看不见的行不用动
    const el = els[k];
    const d = before.has(k) ? before.get(k) - el.getBoundingClientRect().top : far;
    if (Math.abs(d) < 0.5) continue;
    // 往上走时，当前行以上的一起先走，下面的行一行比一行晚；往回走时反过来
    const lag = Math.min(Math.max(0, up ? k - a : a - k), 9) * 38;
    glideAnims.push(el.animate([{ translate: `0 ${d.toFixed(1)}px` }, { translate: '0 0' }], { duration: SPRING.ms, delay: lag, easing: SPRING.easing, fill: 'backwards' }));
  }
}
function scrollToActive(instant) {
  if (prefs.view !== 'apple' || elScroll.classList.contains('free')) return;
  if (instant) { for (const an of glideAnims) an.cancel(); glideAnims = []; jumpToActive(); } else glide(jumpToActive);
}
for (const ev of ['wheel', 'touchmove']) {
  elScroll.addEventListener(ev, () => {
    elScroll.classList.add('free');
    clearTimeout(freeTimer);
    freeTimer = setTimeout(() => { elScroll.classList.remove('free'); scrollToActive(); }, S.mode ? 8000 : 3500);
  }, { passive: true });
}

// ---------------- 每一帧：进度条、逐字填充、间奏的三个点 ----------------
// 这里每秒跑 60 次，所以只在数值真的变了的时候才去改页面，并且尽量只改不会引起重新排版的属性
const elFill = $('#progress-fill'), elCur = $('#t-cur'), elRem = $('#t-rem');
const shown = { w: -1, cur: '', rem: '' };
function setProgress(frac) {
  const w = Math.round(clamp(frac) * 2000) / 2000;
  if (w !== shown.w) { shown.w = w; elFill.style.transform = `translateX(${(w - 1) * 100}%)`; }
}
// 间奏的三个点。e：间奏已经过了多久；D：间奏总长
//   1. 三个点依次读满；整体一直在「呼吸」，越接近读满呼吸的幅度越大、个头也越大
//   2. 读满的那一刻正好在呼吸的最高点，接着再胀大一点，然后缩小并淡出，在下一句开始前消失
function paintDots(f, t) {
  const D = f.line.end - f.line.t, e = t - f.line.t;
  const out = Math.min(1.1, D * 0.22);          // 收尾（胀大 → 淡出）用的时间
  const full = Math.max(0.3, D - out - 0.12);   // 读满的时刻
  const span = full / 3;
  for (let k = 0; k < f.dots.length; k++) {
    const dot = f.dots[k], p = Math.round(clamp((e - k * span) / span) * 100) / 100;
    if (p !== dot.p) { dot.p = p; dot.el.style.setProperty('--p', p); }
  }
  let sc, op = 1;
  if (e <= full) {
    const P = clamp(e / full);
    sc = (0.88 + 0.12 * P) * (1 + (0.035 + 0.055 * P) * Math.cos((e - full) * 2 * Math.PI / 2.4));
  } else {
    const q = clamp((e - full) / out), peak = 1.09;
    if (q < 0.4) sc = peak + (1.22 - peak) * (1 - (1 - q / 0.4) ** 2);
    else { const u = (q - 0.4) / 0.6; sc = 1.22 - 0.5 * u * u; op = 1 - u * u * (3 - 2 * u); }
  }
  const s = sc.toFixed(3), o = op.toFixed(2);
  if (s !== f.s) { f.s = s; f.g.style.transform = `scale(${s})`; }
  if (o !== f.o) { f.o = o; f.g.style.opacity = o; }
}
function tick() {
  const pos = now();
  const dur = S.track?.duration || 0;
  if (!S.dragging) {
    setProgress(dur ? pos / dur : 0);
    const cur = fmt(pos), rem = `-${fmt(Math.max(0, dur - pos))}`;
    if (cur !== shown.cur) elCur.textContent = shown.cur = cur;
    if (rem !== shown.rem) elRem.textContent = shown.rem = rem;
  }
  if (!S.lines.length) return;
  const t = pos - S.offset;
  const i = findActive(t);
  if (i !== S.active) setActive(i);
  const f = S.fill;
  if (!f) return;
  if (f.gap) return paintDots(f, t);
  for (const s of f.segs) {
    // 填充进度：唱过的和还没唱到的词不会变，实际每帧只会改到正在唱的那一两个
    const p = t <= s.t0 ? 0 : t >= s.t1 ? 1 : Math.round((t - s.t0) / s.d * 200) / 200;
    if (p !== s.p) { s.p = p; s.el.style.setProperty('--p', p); }
    // 唱到了就抬起来：只切一次 class，抬起的过程交给 CSS 过渡
    const on = t >= s.t0;
    if (on !== s.on) { s.on = on; s.el.classList.toggle('on', on); }
  }
}
function frame() {
  requestAnimationFrame(frame);
  tick();
}

// 词典释义按设置的语言取：中文（有道）/ 英文（Jisho）/ 两者
// 多义词选义项。优先级：
//   1. 这首歌里手动指定的
//   2. 和这一句中文翻译对得上的（context）
//   3. 单汉字词里，有一个小词条正好就是这个汉字的（落ちる →「落」）。只限单汉字词且完全相等，
//      避免被「勉強＝勉强」这类中日同形异义的义项带偏
//   4. 词典默认（前两个义项）
// 返回 { text 显示用, senses 全部中文义项, zh 选中的中文义项, how: 'manual' | 'context' | 'kanji' | '' }
const STOPCH = new Set([...'的了是在我你他她它们和与就也都不有这那个着过吧吗呢啊把被让给很还又而及或但其之所以为于']);
const HAN = /[\u4e00-\u9fff]/;
const hanzi = (str) => [...str].filter((c) => HAN.test(c) && !STOPCH.has(c));
// 义项「掉，落；脱落；剥落」→ 小词条 ['掉', '落', '脱落', '剥落']
const glosses = (sense) => sense.replace(/（[^）]*）|\([^)]*\)/g, '').split(/[，；、,;\s]+/).filter(Boolean);
// 一个义项和翻译的贴合度：取各小词条里「有多大比例的字出现在翻译中」的最大值；整词出现在翻译里最高
function senseScore(sense, zhLine, ctx) {
  let max = 0, sum = 0;
  for (const g of glosses(sense)) {
    const chars = hanzi(g);
    if (!chars.length) continue;
    let r = chars.filter((c) => ctx.has(c)).length / chars.length;
    if (chars.length >= 2 && zhLine.includes(g)) r = 2;
    max = Math.max(max, r);
    sum += r;
  }
  return max + sum * 0.01;
}
function chooseMeaning(d, line, key) {
  if (!d) return { text: '', senses: [], zh: '', how: '' };
  const en = d.en?.[0] || '';
  const senses = d.zhs?.length ? d.zhs : d.zh ? [d.zh] : [];
  let zh = d.zh || '', how = '';
  const manual = key && S.senses?.[key];
  if (manual && senses.includes(manual)) { zh = manual; how = 'manual'; }
  else if (senses.length > 1 && prefs.autoSense !== false) {
    if (line?.zh) {
      const ctx = new Set(hanzi(line.zh));
      let best = 0.49; // 至少要有半个小词条对得上
      for (const sense of senses) {
        const sc = senseScore(sense, line.zh, ctx);
        if (sc > best) { best = sc; zh = sense; how = 'context'; }
      }
    }
    if (!how) {
      const kanji = [...(d.w || '')].filter((c) => HAN.test(c));
      const own = kanji.length === 1 && senses.find((sense) => glosses(sense).includes(kanji[0]));
      if (own) { zh = own; how = 'kanji'; }
    }
  }
  const lang = prefs.meaningLang;
  const text = lang === 'en' ? (en || zh) : lang === 'both' ? [zh, en].filter(Boolean).join(' / ') : (zh || en);
  return { text, senses: lang === 'en' ? [] : senses, zh, how };
}

// ---------------- 语法 / 词汇标注 ----------------
const RANK = { N1: 5, N2: 4, N3: 3, N4: 2, N5: 1 };
const levelOK = (lv) => prefs.levels[lv || 'x'] !== false;
function annotationsFor(line) {
  if (!line || line.gap) return [];
  const items = [];
  const useAI = line.ai && prefs.annSource !== 'builtin';
  if (prefs.annGrammar) {
    for (const g of (useAI ? line.ai.grammar : line.grammar)) {
      if (levelOK(g.lv)) items.push({ type: 'g', title: g.n, lv: g.lv, desc: g.zh, start: g.start, end: g.end });
    }
  }
  if (prefs.annVocab) {
    if (useAI) {
      for (const v of line.ai.vocab) if (levelOK(v.lv)) items.push({ type: 'v', title: v.b, rd: v.r, lv: v.lv, desc: v.zh, start: v.start, end: v.end });
    } else {
      line.tokens.forEach((tok, ti) => {
        if (!tok.v) return;
        const d = S.dict[tok.b];
        if (!d || d.miss || !levelOK(d.lv)) return;
        // 既没有级别、也不是常用词、中文词典里也查不到：多半是撞上了不相干的冷僻词条（如 イイ → Iran-Iraq）
        if (!d.lv && !d.common && !d.zh) return;
        // 纯假名写的动词（如可能形「なれる」）在词典里常对到别的词，宁可不标
        if (tok.pos === '动' && !KANJI.test(tok.b) && d.w !== tok.b) return;
        const m = chooseMeaning(d, line, `v:${tok.b}`);
        items.push({ type: 'v', title: tok.b, rd: d.r, lv: d.lv, desc: m.text, senses: m.senses, pick: m.zh, how: m.how, start: ti, end: ti + 1 });
      });
    }
  }
  const seen = new Set();
  const uniq = items.filter((a) => { a.key = `${a.type}:${a.title}`; if (seen.has(a.key)) return false; seen.add(a.key); return true; });
  const hidden = S.hiddenAnn || new Set();
  const rank = (a) => RANK[a.lv] ?? 2.5;
  const shown = uniq.filter((a) => !hidden.has(a.key))
    .map((a, k) => ({ a, k })).sort((x, y) => rank(y.a) - rank(x.a) || x.k - y.k)
    .slice(0, prefs.annMax).sort((x, y) => x.a.start - y.a.start || x.k - y.k).map((x) => x.a);
  // 这首歌里被关掉的标注：平时不出现，只在修改模式下以虚线框列出，方便加回来
  const off = S.mode === 'edit' ? uniq.filter((a) => hidden.has(a.key)).map((a) => ({ ...a, off: true })) : [];
  return [...shown, ...off];
}
function chipHTML(a) {
  const multi = !a.off && a.senses?.length > 1; // 多义词：修改模式下悬停可展开全部义项来挑
  return `<span class="chip ${a.type}${a.off ? ' off' : ''}${multi ? ' multi' : ''}" data-key="${esc(a.key)}"><b>${esc(a.title)}</b>${a.rd && a.rd !== a.title ? `<span class="rd">${esc(a.rd)}</span>` : ''}${a.lv ? `<span class="lv">${a.lv}</span>` : ''}<span class="ds">${esc(a.desc)}</span>${multi ? `<span class="more">+${a.senses.filter((x) => x !== a.pick).length}</span>` : ''}</span>`;
}
function paintAnnotations() {
  const line = S.lines[S.active];
  const anns = prefs.ann ? annotationsFor(line) : [];
  S.anns = anns;
  S.annByTok = {};
  for (const a of anns) if (!a.off) for (let k = a.start; k < a.end; k++) (S.annByTok[k] ||= []).push(a);
  // 修改模式下总是列出标签（即使平时选的是「仅下划线」），这样才能点
  const html = prefs.annStyle === 'underline' && S.mode !== 'edit' ? '' : anns.map(chipHTML).join('');
  const roots = [$('#f-cur')];
  const el = $('#scroll').children[S.active];
  if (el) roots.push(el);
  for (const root of roots) {
    $$('.tok', root).forEach((tokEl) => {
      const list = S.annByTok[tokEl.dataset.ti] || [];
      tokEl.classList.toggle('hg', list.some((a) => a.type === 'g'));
      tokEl.classList.toggle('hv', list.some((a) => a.type === 'v'));
    });
  }
  if (el) { const box = $('.ann', el); box.className = `ann ${prefs.annStyle}`; box.innerHTML = html; }
  const fa = $('#f-ann'); fa.className = `f-ann ${prefs.annStyle}`; fa.innerHTML = html;
}

// 词典数据（Jisho）：先取本地缓存，再分批补全
async function fetchDict(token) {
  const words = [...new Set(S.song.lines.flatMap((l) => l.tokens.filter((t) => t.v).map((t) => t.b)))];
  try {
    Object.assign(S.dict, await api.post('/api/dict', { words: words.slice(0, 40) }));
  } catch { /* 离线时没有词汇标注，其余功能不受影响 */ }
  if (token !== S.loadToken) return;
  paintAnnotations();
  for (let i = 40; i < words.length; i += 20) {
    try { Object.assign(S.dict, await api.post('/api/dict', { words: words.slice(i, i + 20) })); } catch { return; }
    if (token !== S.loadToken) return;
    paintAnnotations();
  }
}

// 悬停在带标注的词上时显示说明
const tip = $('#tip');
document.addEventListener('mouseover', (e) => {
  const tokEl = e.target.closest?.('.line.active .tok, #f-cur .tok');
  const list = tokEl && prefs.ann && !S.mode ? S.annByTok[tokEl.dataset.ti] : null;
  if (!list) { tip.hidden = true; return; }
  tip.innerHTML = list.map((a) => `<div><b>${esc(a.title)}</b>${a.rd ? `（${esc(a.rd)}）` : ''} ${a.lv || ''}<br>${esc(a.desc)}${a.senses?.length > 1 ? `<div class="muted">其他义项：${esc(a.senses.filter((x) => x !== a.pick).join(' ｜ '))}</div>` : ''}</div>`).join('<hr style="border:0;border-top:1px solid var(--line)">');
  tip.hidden = false;
  const r = tokEl.getBoundingClientRect();
  tip.style.left = `${clamp(r.left, 8, innerWidth - tip.offsetWidth - 8)}px`;
  tip.style.top = `${r.bottom + 8 + tip.offsetHeight > innerHeight ? r.top - tip.offsetHeight - 8 : r.bottom + 8}px`;
});

// ---------------- 点击歌词：跳转 / 敲击对齐 / 辞书选择 / 改读音 ----------------
function seekTo(sec) {
  sec = Math.max(0, sec);
  setClock(sec);
  S.seekHold = performance.now() + 700;
  control('seek', sec);
}
document.addEventListener('click', (e) => {
  const lineEl = e.target.closest('.line');
  const inFocus = e.target.closest('#f-cur');
  if (S.mode === 'dict' && (lineEl || inFocus)) return dictClick(e);
  if (S.mode === 'edit' && (lineEl || inFocus || e.target.closest('#f-ann'))) return editClick(e);
  const near = e.target.closest('#f-prev, #f-next'); // 大字视图里的上一句 / 下一句
  const i = lineEl ? +lineEl.dataset.i : near && near.dataset.i !== '' ? +near.dataset.i : -1;
  const line = S.lines[i];
  if (!line || line.gap) return;
  if (S.tapAlign) {
    setOffset(now() - line.t);
    toast(`已对齐：这句从现在开始（偏移 ${S.offset.toFixed(1)}s）`);
    return;
  }
  $('#scroll').classList.remove('free');
  seekTo(line.t + S.offset + 0.02);
});

// ---------------- 时间对齐 ----------------
let offsetTimer = 0;
function updateOffsetLabel() {
  const o = S.offset;
  $('#offset-val').textContent = Math.abs(o) < 0.05 ? '0.0s' : `${o > 0 ? '延后' : '提前'} ${Math.abs(o).toFixed(1)}s`;
  $('#offset-badge').textContent = Math.abs(o) < 0.05 ? '' : `${o > 0 ? '+' : '−'}${Math.abs(o).toFixed(1)}s`;
}
function setOffset(v) {
  if (!S.song) return;
  S.offset = Math.round(v * 100) / 100;
  updateOffsetLabel();
  clearTimeout(offsetTimer);
  const key = S.song.key, offset = S.offset;
  offsetTimer = setTimeout(() => api.post('/api/song/offset', { key, offset }).catch(() => {}), 500);
}
$$('#offset-pop [data-off]').forEach((b) => b.addEventListener('click', () => setOffset(S.offset + Number(b.dataset.off))));
$('#offset-reset').addEventListener('click', () => setOffset(0));
$('#offset-tap').addEventListener('change', (e) => { S.tapAlign = e.target.checked; });
// 时间对齐的面板一关（不管怎么关的），敲击对齐就跟着关掉，免得之后点歌词还在改时间
new MutationObserver(() => {
  if ($('#offset-pop').hidden && S.tapAlign) { S.tapAlign = false; $('#offset-tap').checked = false; }
}).observe($('#offset-pop'), { attributes: true, attributeFilter: ['hidden'] });

// ---------------- 辞书模式 ----------------
function setMode(mode) {
  S.mode = S.mode === mode ? null : mode;
  app.classList.toggle('dict-mode', S.mode === 'dict');
  app.classList.toggle('edit-mode', S.mode === 'edit');
  app.classList.toggle('by-char', S.mode === 'dict' && prefs.dictChar);
  $('#btn-dict').classList.toggle('on', S.mode === 'dict');
  $('#btn-edit').classList.toggle('on', S.mode === 'edit');
  $('#btn-edit').setAttribute('aria-pressed', S.mode === 'edit');
  $('#dictbar').hidden = S.mode !== 'dict';
  $('#reading-pop').hidden = true;
  tip.hidden = true;
  if (S.mode !== 'dict') { S.sel = null; paintSelection(); resumeIfPausedByDict(); }
  updateDictBar();
  paintAnnotations();
  hideSensePop();
  requestAnimationFrame(() => scrollToActive(true));
}
function resumeIfPausedByDict() {
  if (S.pausedByDict) { S.pausedByDict = false; control('play'); }
}
function dictClick(e) {
  const ch = e.target.closest('.ch');
  const jp = e.target.closest('.jp');
  if (!ch || !jp) return;
  const li = +jp.dataset.li;
  const line = S.lines[li];
  const c = +ch.dataset.c;
  const tok = line.tokens.find((t) => c >= t.i0 && c < t.i0 + t.s.length);
  if (!tok || tok.sp) return;
  const [u0, u1] = prefs.dictChar ? [c, c + ch.textContent.length] : [tok.i0, tok.i0 + tok.s.length];
  const s = S.sel;
  if (!s || s.li !== li) S.sel = { li, a: u0, b: u1 };
  else if (u0 >= s.a && u1 <= s.b) {
    // 点已选中的部分：在两端则收缩，在中间则只保留它
    if (u0 === s.a && u1 === s.b) S.sel = null;
    else if (u0 === s.a) s.a = u1;
    else if (u1 === s.b) s.b = u0;
    else S.sel = { li, a: u0, b: u1 };
  } else { s.a = Math.min(s.a, u0); s.b = Math.max(s.b, u1); }
  if (prefs.dictPause && S.player?.state === 'playing') { S.pausedByDict = true; control('pause'); }
  paintSelection();
  updateDictBar(true);
}
function paintSelection() {
  $$('.ch.sel').forEach((el) => el.classList.remove('sel'));
  const s = S.sel;
  if (!s) return;
  $$(`.jp[data-li="${s.li}"] .ch`).forEach((el) => { const c = +el.dataset.c; if (c >= s.a && c < s.b) el.classList.add('sel'); });
}
function selectionInfo() {
  const s = S.sel;
  const line = S.lines[s.li];
  let reading = '';
  const toks = [];
  for (const tok of line.tokens) {
    if (tok.i0 >= s.b || tok.i0 + tok.s.length <= s.a) continue;
    toks.push(tok);
    let ci = tok.i0;
    for (const seg of tok.segs) {
      const s0 = ci, s1 = ci + seg.t.length;
      ci = s1;
      if (s0 >= s.b || s1 <= s.a) continue;
      if (seg.r !== undefined && KANJI.test(seg.t)) reading += seg.r;
      else reading += toHira(seg.t.slice(Math.max(s.a, s0) - s0, Math.min(s.b, s1) - s0));
    }
  }
  const one = toks.length === 1 && toks[0].i0 === s.a && toks[0].i0 + toks[0].s.length === s.b ? toks[0] : null;
  return { line, text: line.text.slice(s.a, s.b), reading, tok: one };
}
let dictSeq = 0;
function updateDictBar(fresh) {
  const has = !!S.sel;
  $('#db-hint').hidden = has;
  $('#db-form').hidden = !has;
  if (!has) { $('#db-info').innerHTML = ''; return; }
  const info = selectionInfo();
  const w = $('#db-word'), r = $('#db-reading'), m = $('#db-meaning');
  if (fresh) { w.dataset.dirty = r.dataset.dirty = m.dataset.dirty = ''; }
  const useBase = info.tok && info.tok.b !== info.tok.s && S.sel.form !== 'surface';
  const word = useBase ? info.tok.b : info.text;
  if (!w.dataset.dirty) w.value = word;
  if (!r.dataset.dirty) r.value = useBase ? '' : info.reading;
  if (!m.dataset.dirty) m.value = '';
  const ai = info.line.ai?.vocab.find((v) => v.b === word || v.text === info.text);
  if (ai && !m.dataset.dirty) m.value = ai.zh;
  if (ai && useBase && !r.dataset.dirty) r.value = ai.r;
  const swap = info.tok && info.tok.b !== info.tok.s
    ? `　<a data-form="${useBase ? 'surface' : 'base'}">改用${useBase ? `歌词里的形式「${esc(info.text)}」` : `原形「${esc(info.tok.b)}」`}</a>` : '';
  $('#db-info').innerHTML = `查询中…${swap}`;
  const seq = ++dictSeq;
  lookup(word).then((d) => {
    if (seq !== dictSeq) return;
    if (!d || d.miss) {
      if (useBase && !r.dataset.dirty && !r.value) r.value = info.reading;
      $('#db-info').innerHTML = `词典里没有查到「${esc(word)}」，可以自己填写释义。${swap}`;
      return;
    }
    if (!r.dataset.dirty && (useBase || !r.value) && d.r) r.value = d.r;
    const picked = chooseMeaning(d, info.line, `v:${word}`);
    if (!m.dataset.dirty && !m.value) m.value = picked.text;
    const allZh = (d.zhs?.length ? d.zhs : [d.zh]).filter(Boolean).join(' ｜ ');
    const detail = [allZh, prefs.meaningLang !== 'zh' || !allZh ? (d.en || []).join('; ') : ''].filter(Boolean).join('　');
    $('#db-info').innerHTML = `${d.lv ? `<span class="lv">${d.lv}</span>` : ''}${esc(d.w)}【${esc(d.r)}】 ${esc(detail)}${swap}`;
  });
}
async function lookup(word) {
  if (S.dict[word]) return S.dict[word];
  try { Object.assign(S.dict, await api.post('/api/dict', { words: [word] })); } catch { return null; }
  return S.dict[word] || { miss: 1 };
}
for (const id of ['db-word', 'db-reading', 'db-meaning']) $(`#${id}`).addEventListener('input', (e) => { e.target.dataset.dirty = '1'; });
$('#db-info').addEventListener('click', (e) => {
  const a = e.target.closest('a[data-form]');
  if (!a || !S.sel) return;
  S.sel.form = a.dataset.form;
  updateDictBar(true);
});
$('#db-cancel').addEventListener('click', () => { S.sel = null; paintSelection(); updateDictBar(); resumeIfPausedByDict(); });
$('#db-done').addEventListener('click', addVocab);
$('#db-form').addEventListener('keydown', (e) => { if (e.key === 'Enter') addVocab(); });
async function addVocab() {
  if (!S.sel) return;
  const info = selectionInfo();
  const word = $('#db-word').value.trim();
  if (!word) return;
  const entry = {
    word, reading: $('#db-reading').value.trim(), meaning: $('#db-meaning').value.trim(),
    surface: info.text, level: S.dict[word]?.lv || '',
    line: info.line.text, zh: info.line.zh || '', lineTime: info.line.t,
    song: { pid: S.track.pid, name: S.track.name, artist: S.track.artist },
  };
  try { await api.post('/api/vocab', entry); } catch (e) { return toast(`保存失败：${e.message}`); }
  toast(`已加入词汇书：${word}`);
  S.sel = null; paintSelection(); updateDictBar();
  resumeIfPausedByDict();
  if (!$('#vocab').hidden) loadVocab();
}
$('#db-char').addEventListener('change', (e) => { prefs.dictChar = e.target.checked; savePrefs(); app.classList.toggle('by-char', S.mode === 'dict' && prefs.dictChar); });
$('#db-pause').addEventListener('change', (e) => { prefs.dictPause = e.target.checked; savePrefs(); });

// ---------------- 修改读音 ----------------
let editing = null;
// 修改模式下，鼠标停在多义词的标注上：其他义项以同款小卡叠在它下面，
// 点其中一张就换上它（这首歌里固定用它），原来那张弹出后排到最下面。
const sensePop = $('#sense-pop');
const sense = { ann: null, box: null, order: [], timer: 0, busy: false };
function hideSensePop() { clearTimeout(sense.timer); sensePop.hidden = true; sense.ann = null; }
const altCardHTML = (a, text, i, animate) =>
  `<span class="chip v alt${animate ? ' in' : ''}" data-i="${i}" style="--i:${i}"><b>${esc(a.title)}</b>${a.rd && a.rd !== a.title ? `<span class="rd">${esc(a.rd)}</span>` : ''}${a.lv ? `<span class="lv">${a.lv}</span>` : ''}<span class="ds">${esc(text)}</span></span>`;
const currentSenseChip = () => sense.box?.querySelector(`.chip.multi[data-key="${CSS.escape(sense.ann.key)}"]`);
function renderSensePop(animate) {
  const a = sense.ann;
  sensePop.className = `sense-stack ${prefs.annStyle}${sense.box?.id === 'f-ann' ? ' big' : ''}`;
  sensePop.innerHTML = sense.order.map((text, i) => altCardHTML(a, text, i, animate)).join('');
  const chip = currentSenseChip();
  if (!chip) return hideSensePop();
  sensePop.hidden = false;
  const r = chip.getBoundingClientRect();
  sensePop.style.left = `${clamp(r.left, 8, Math.max(8, innerWidth - sensePop.offsetWidth - 8))}px`;
  const below = r.bottom + 6 + sensePop.offsetHeight <= innerHeight - 8;
  sensePop.style.top = `${below ? r.bottom + 6 : Math.max(8, r.top - sensePop.offsetHeight - 6)}px`;
}
function openSensePop(chip) {
  const a = (S.anns || []).find((x) => x.key === chip.dataset.key && !x.off);
  if (!a || !(a.senses?.length > 1)) return;
  sense.ann = a;
  sense.box = chip.closest('.ann, #f-ann');
  sense.order = a.senses.filter((x) => x !== a.pick);
  renderSensePop(true);
}
document.addEventListener('mouseover', (e) => {
  if (sense.busy) return;
  const chip = S.mode === 'edit' ? e.target.closest?.('.chip.multi') : null;
  if (chip || e.target.closest?.('#sense-pop')) {
    clearTimeout(sense.timer);
    if (chip && (sensePop.hidden || sense.ann?.key !== chip.dataset.key)) openSensePop(chip);
  } else if (!sensePop.hidden) {
    clearTimeout(sense.timer);
    sense.timer = setTimeout(hideSensePop, 300); // 留一点时间把鼠标移到卡片上
  }
});
// 换义项的动画用的替身：歌词区有裁切和层级限制，所以在最上层放一张一模一样的卡来飞
function ghostChip(el, rect, hostClass) {
  const host = document.createElement('div');
  host.className = `edit-mode ${hostClass}`; // 沿用原容器的类名，卡片样式才一致
  host.style.cssText = `position:fixed;left:${rect.left}px;top:${rect.top}px;width:${rect.width}px;height:${rect.height}px;margin:0;padding:0;min-height:0;max-width:none;display:flex;flex-flow:row nowrap;align-items:flex-start;justify-content:flex-start;gap:0;pointer-events:none;z-index:40;`;
  const g = el.cloneNode(true);
  g.classList.add('ghost');
  g.style.cssText = `width:${rect.width}px;height:${rect.height}px;`;
  host.append(g);
  document.body.append(host);
  return { host, g };
}
const CARD_BG = 'rgba(34, 30, 44, .88)';
const SWAP_MS = 300, SWAP_DELAY = 60;
sensePop.addEventListener('click', (e) => {
  const card = e.target.closest('.chip.alt');
  const a = sense.ann;
  if (!card || !a || !S.song || sense.busy) return;
  const i = +card.dataset.i;
  const next = sense.order[i], prev = a.pick;
  const cur = currentSenseChip();
  if (!cur) return;
  api.post('/api/song/sense', { key: S.song.key, ann: a.key, sense: next }).catch((err) => {
    toast(`保存失败：${err.message}`);
    if (S.senses[a.key] === next) { delete S.senses[a.key]; paintAnnotations(); hideSensePop(); }
  });

  // 先记下换之前各张卡的位置，再直接换成最终状态，动画只负责把「之前」过渡到「之后」
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  const box = sense.box;
  const rc = cur.getBoundingClientRect(), ra = card.getBoundingClientRect();
  const curBg = getComputedStyle(cur).backgroundColor;
  const out = still ? null : ghostChip(cur, rc, box.className);   // 被换下的那张
  const before = new Map();
  for (const el of box.querySelectorAll('.chip[data-key]')) before.set(`k:${el.dataset.key}`, el.getBoundingClientRect());
  for (const el of sensePop.querySelectorAll('.chip.alt')) before.set(`s:${sense.order[+el.dataset.i]}`, el.getBoundingClientRect());

  S.senses[a.key] = next;
  sense.order = [...sense.order.filter((_, k) => k !== i), prev];  // 被换下的义项排到最下面
  paintAnnotations();
  sense.ann = (S.anns || []).find((x) => x.key === a.key && !x.off) || null;
  if (!sense.ann) { out?.host.remove(); return hideSensePop(); }
  renderSensePop(false);
  const fresh = currentSenseChip();
  if (still || !fresh) { out?.host.remove(); return; }

  sense.busy = true;
  setTimeout(() => { sense.busy = false; }, SWAP_DELAY + SWAP_MS + 30);
  const ease = 'cubic-bezier(.3, .75, .2, 1)';
  const slide = (el, from) => {
    const to = el.getBoundingClientRect();
    const dx = from.left - to.left, dy = from.top - to.top;
    if (Math.abs(dx) > .5 || Math.abs(dy) > .5) el.animate([{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }], { duration: SWAP_MS, easing: ease });
  };

  // 1. 退弹：旧义项从卡位向右上弹出，转着落下并淡出（横向匀速 + 纵向先升后落 = 抛物线）
  const spin = clamp(2600 / rc.width, 7, 24);
  out.host.animate([{ transform: 'translateX(0)' }, { transform: 'translateX(76px)' }], { duration: 600, easing: 'cubic-bezier(.25, .6, .6, 1)', fill: 'forwards' });
  out.g.animate([
    { transform: 'translateY(0) rotate(0deg)', opacity: 1, backgroundColor: curBg, easing: 'cubic-bezier(.15, .7, .4, 1)' },
    { offset: .36, transform: `translateY(-30px) rotate(${spin * .4}deg)`, opacity: 1, backgroundColor: CARD_BG, easing: 'cubic-bezier(.55, 0, .9, .55)' },
    { transform: `translateY(72px) rotate(${spin}deg)`, opacity: 0, backgroundColor: CARD_BG },
  ], { duration: 600, fill: 'forwards' }).onfinish = () => out.host.remove();

  // 2. 上膛：被点的那张飞进卡位，一路把宽度和「+N」平滑过渡到位，落定后换回真正的标注
  const rn = fresh.getBoundingClientRect();
  const inn = ghostChip(fresh, rn, box.className);
  const opt = { duration: SWAP_MS, delay: SWAP_DELAY, fill: 'both' };
  fresh.animate([{ opacity: 0 }, { opacity: 0 }], { duration: SWAP_DELAY + SWAP_MS });
  inn.host.animate([{ transform: `translate(${ra.left - rn.left}px, ${ra.top - rn.top}px)` }, { transform: 'none' }], { ...opt, easing: 'cubic-bezier(.3, 1.3, .5, 1)' })
    .onfinish = () => inn.host.remove();
  inn.g.animate([
    { width: `${ra.width}px`, height: `${ra.height}px`, backgroundColor: CARD_BG },
    { width: `${rn.width}px`, height: `${rn.height}px`, backgroundColor: getComputedStyle(fresh).backgroundColor },
  ], { ...opt, easing: ease });
  inn.g.querySelector('.more')?.animate([{ opacity: 0 }, { opacity: 0, offset: .4 }, { opacity: 1 }], opt);

  // 3. 补位：同一行的其他标注、列表里剩下的小卡滑到新位置
  for (const el of box.querySelectorAll('.chip[data-key]')) {
    const from = el !== fresh && before.get(`k:${el.dataset.key}`);
    if (from) slide(el, from);
  }
  const cards = [...sensePop.querySelectorAll('.chip.alt')];
  for (const el of cards.slice(0, -1)) {
    const from = before.get(`s:${sense.order[+el.dataset.i]}`);
    if (from) slide(el, from);
  }
  // 4. 回仓：旧义项在最下面由左到右浮现
  const back = cards[cards.length - 1];
  back.classList.add('back');
  back.addEventListener('animationend', () => back.classList.remove('back'), { once: true });
});

// 修改模式下点标注：在这首歌里隐藏 / 恢复它
async function toggleAnnotation(chip) {
  if (!S.song) return;
  hideSensePop();
  const key = chip.dataset.key;
  const hide = !S.hiddenAnn.has(key);
  try { await api.post('/api/song/annotation', { key: S.song.key, ann: key, hidden: hide }); }
  catch (e) { return toast(`保存失败：${e.message}`); }
  if (hide) S.hiddenAnn.add(key); else S.hiddenAnn.delete(key);
  paintAnnotations();
  const name = chip.querySelector('b')?.textContent || '';
  toast(hide ? `这首歌里不再显示「${name}」（修改模式下可点回来）` : `已恢复「${name}」`);
}
function editClick(e) {
  const chip = e.target.closest('.chip[data-key]');
  if (chip) return toggleAnnotation(chip);
  const segEl = e.target.closest('.seg.k');
  const jp = e.target.closest('.jp');
  if (!segEl || !jp) return;
  const li = +jp.dataset.li, ti = +segEl.closest('.tok').dataset.ti, si = +segEl.dataset.si;
  const line = S.lines[li];
  const seg = line.tokens[ti].segs[si];
  editing = { line, ti, si, seg };
  $('#rp-seg').textContent = seg.t;
  $('#rp-input').value = seg.r || '';
  const from = { roma: '已按歌词源的罗马音自动纠正', qq: '已按 QQ 音乐的注音自动纠正', user: '你修改过这个读音' }[seg.src];
  $('#rp-info').textContent = [from, seg.auto ? `词典读音：${seg.auto}` : ''].filter(Boolean).join('　') || '词典自动标注';
  $('#rp-reset').hidden = seg.src !== 'user';
  $('input[name=rp-scope][value=here]').checked = true;
  const pop = $('#reading-pop');
  pop.hidden = false;
  const r = segEl.getBoundingClientRect();
  pop.style.left = `${clamp(r.left - 20, 8, innerWidth - pop.offsetWidth - 8)}px`;
  pop.style.top = `${r.bottom + 10 + pop.offsetHeight > innerHeight ? Math.max(8, r.top - pop.offsetHeight - 10) : r.bottom + 10}px`;
  $('#rp-input').focus(); $('#rp-input').select();
}
async function saveReading(reading) {
  if (!editing) return;
  const { line, ti, si, seg } = editing;
  const scope = $('input[name=rp-scope]:checked').value;
  try {
    await api.post('/api/song/reading', { key: S.song.key, scope, lineText: line.text, ti, si, seg: seg.t, reading });
  } catch (e) { return toast(`保存失败：${e.message}`); }
  $('#reading-pop').hidden = true;
  editing = null;
  await reloadSong();
  toast(reading === null ? '已恢复自动读音' : '读音已保存');
}
$('#rp-save').addEventListener('click', () => saveReading(toHira($('#rp-input').value.trim())));
$('#rp-reset').addEventListener('click', () => saveReading(null));
$('#rp-cancel').addEventListener('click', () => { $('#reading-pop').hidden = true; });
$('#rp-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('#rp-save').click(); });

// ---------------- 资料库 ----------------
const lib = { tracks: null, loading: false, shown: 0, filtered: [] };
// 「仅日文」的判断。元数据里没有语言字段，只能靠线索推断：
//   1. 流派是日本的（Anime、J-Pop、歌謡曲…）
//   2. 歌名 / 歌手名里有假名
//   3. 专辑名里有假名——合辑除外（日区的「ベストセラー」之类合辑里什么歌都有）
//   4. 同一位歌手只要有一首符合上面任意一条，他的其他歌也算（歌名被译成英文 / 罗马字的那些）
// 流派明确是其他语种的（Mandopop、K-Pop…）一律不算，免得被第 4 条带进来。
const JA_GENRE = /^(anime|j-|kayokyoku|enka|japan)|vocaloid/i;
const NOT_JA_GENRE = /mandopop|cantopop|c-pop|k-pop|chinese|korean|taiwan/i;
const KANA = /[\u3040-\u30ff]/;
function markJapanese(tracks) {
  const artistKey = (t) => t.artist.trim().toLowerCase();
  const jaArtists = new Set();
  for (const t of tracks) {
    const g = t.genre || '';
    t.ja = !NOT_JA_GENRE.test(g) && (JA_GENRE.test(g) || KANA.test(t.name + t.artist) || (!t.comp && KANA.test(t.album)));
    if (t.ja && artistKey(t)) jaArtists.add(artistKey(t));
  }
  for (const t of tracks) {
    if (!t.ja && !NOT_JA_GENRE.test(t.genre || '') && jaArtists.has(artistKey(t))) t.ja = true;
  }
  return tracks;
}
async function openLibrary() {
  $('#library').hidden = false;
  $('#lib-search').focus();
  if (lib.tracks || lib.loading) return renderLibrary();
  lib.loading = true;
  $('#lib-list').innerHTML = '<div class="empty">正在读取 Apple Music 资料库…</div>';
  try {
    const [tracks, playlists] = await Promise.all([api.get('/api/library'), api.get('/api/playlists').catch(() => [])]);
    lib.tracks = markJapanese(tracks);
    $('#lib-playlist').innerHTML = '<option value="">全部歌曲</option>' + playlists.map((p) => `<option value="${esc(p.pid)}">${esc(p.name)}</option>`).join('');
    renderLibrary();
  } catch (e) {
    $('#lib-list').innerHTML = `<div class="empty">读取资料库失败：${esc(e.message)}<br><br>请确认已允许本程序控制「音乐」（系统设置 → 隐私与安全性 → 自动化）。</div>`;
  }
  lib.loading = false;
}
function renderLibrary() {
  if (!lib.tracks) return;
  const q = $('#lib-search').value.trim().toLowerCase();
  const ja = $('#lib-ja').checked;
  let list = lib.tracks.filter((t) =>
    (!q || `${t.name}\n${t.artist}\n${t.album}`.toLowerCase().includes(q)) &&
    (!ja || t.ja));
  if ($('#lib-recent').checked) list = [...list].sort((a, b) => b.added - a.added);
  lib.filtered = list;
  lib.shown = 0;
  $('#lib-list').innerHTML = list.length ? '' : '<div class="empty">没有匹配的歌曲</div>';
  moreLibrary();
}
function moreLibrary() {
  const part = lib.filtered.slice(lib.shown, lib.shown + 150);
  lib.shown += part.length;
  $('#lib-list').insertAdjacentHTML('beforeend', part.map((t) =>
    `<div class="track${S.track?.pid === t.pid ? ' cur' : ''}" data-pid="${esc(t.pid)}"><div class="n">${esc(t.name)}</div><div class="d">${fmt(t.duration)}</div><div class="a">${esc([t.artist, t.album].filter(Boolean).join(' — '))}</div></div>`).join(''));
}
$('#lib-list').addEventListener('scroll', (e) => { const el = e.target; if (el.scrollTop + el.clientHeight > el.scrollHeight - 400 && lib.shown < lib.filtered.length) moreLibrary(); });
$('#lib-list').addEventListener('click', (e) => {
  const row = e.target.closest('.track');
  if (!row) return;
  // 现在筛选出来的这份列表就是播放列表：从点的这首开始，播完自动接下一首
  const sel = $('#lib-playlist');
  const q = $('#lib-search').value.trim();
  const label = [sel.selectedOptions[0]?.textContent || '全部歌曲', $('#lib-ja').checked && '仅日文', $('#lib-recent').checked && '最近添加', q && `搜索「${q}」`].filter(Boolean).join(' · ');
  api.post('/api/queue/play', { items: lib.filtered.map((t) => [t.pid, t.name, t.artist, t.duration]), start: row.dataset.pid, label })
    .then(onQueue, (err) => toast(`Apple Music 没有响应：${err.message}`));
  $$('#lib-list .cur').forEach((el) => el.classList.remove('cur'));
  row.classList.add('cur');
});
$('#lib-search').addEventListener('input', renderLibrary);
// 默认只看日文歌；取消勾选后会记住
$('#lib-ja').checked = prefs.libJa !== false;
$('#lib-ja').addEventListener('change', (e) => { prefs.libJa = e.target.checked; savePrefs(); renderLibrary(); });
$('#lib-recent').addEventListener('change', renderLibrary);
$('#lib-playlist').addEventListener('change', async (e) => {
  $('#lib-list').innerHTML = '<div class="empty">读取中…</div>';
  try { lib.tracks = markJapanese(await api.get(`/api/library?playlist=${encodeURIComponent(e.target.value)}`)); renderLibrary(); }
  catch (err) { $('#lib-list').innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
});

// ---------------- 播放列表（内置队列，逻辑在服务端的 queue.js） ----------------
const queue = { sum: null, n: 150, list: [] };
const queueKey = (x) => (x ? [x.active, x.pid, x.at, x.total, x.shuffle, x.repeat, x.label].join('|') : '');
// 服务端每次推送状态都带着队列的概况；有变化时才更新界面
function onQueue(sum) {
  const changed = queueKey(queue.sum) !== queueKey(sum);
  queue.sum = sum;
  if (!changed) return;
  for (const [sel, on] of [['#btn-shuffle', sum.shuffle], ['#queue-shuffle', sum.shuffle], ['#queue-repeat', sum.repeat]]) {
    $(sel).classList.toggle('on', !!on);
    $(sel).setAttribute('aria-pressed', !!on);
  }
  $('#btn-next').title = sum.active && sum.next ? `下一首：${sum.next.name}` : '';
  if (!$('#queue').hidden) loadQueue();
}
async function loadQueue() {
  let v;
  try { v = await api.get(`/api/queue?n=${queue.n}`); } catch { return; }
  queue.list = v.list;
  $('#queue-count').textContent = v.total ? `· ${Math.max(v.at, 0) + 1} / ${v.total}` : '';
  $('#queue-label').textContent = v.label ? `来自：${v.label}` : '';
  const row = (t, cur) => `<div class="track${cur ? ' cur' : ''}" data-pid="${esc(t.pid)}"><div class="n">${esc(t.name)}</div><div class="d">${fmt(t.duration)}</div><div class="a">${esc(t.artist)}</div></div>`;
  if (!v.total) {
    $('#queue-list').innerHTML = '<div class="empty">还没有播放列表。<br>在「资料库」里点一首歌，就会从它开始按当前筛选出的列表播放，播完自动接下一首。</div>';
    return;
  }
  const [cur, ...rest] = v.list;
  const more = Math.max(v.at, 0) + v.list.length < v.total;
  $('#queue-list').innerHTML =
    (v.active ? '' : '<div class="empty" style="padding:14px 10px 4px">你在 Apple Music 里换了别的歌，或列表已经播完，所以没有在接着播。点下面任意一首继续。</div>') +
    `<div class="queue-sec">${v.active ? '正在播放' : '停在'}</div>${cur ? row(cur, v.active) : ''}` +
    (rest.length ? `<div class="queue-sec">接下来${v.shuffle ? '（随机）' : ''}</div>${rest.map((t) => row(t)).join('')}` : `<div class="queue-sec">${v.repeat ? '之后从头再来' : '这是最后一首'}</div>`) +
    (more ? `<div class="empty" style="padding:12px"><button class="btn small" id="queue-more">显示更多（还有 ${v.total - Math.max(v.at, 0) - v.list.length} 首）</button></div>` : '');
}
// 播放列表按钮：点一下打开，再点一下收起；抽屉开着时按钮保持选中的样子（不管是怎么关掉的）
$('#btn-queue').addEventListener('click', () => {
  const open = $('#queue').hidden;
  $('#queue').hidden = !open;
  if (open) { queue.n = 150; $('#vocab').hidden = true; loadQueue(); }
});
new MutationObserver(() => {
  const open = !$('#queue').hidden;
  $('#btn-queue').classList.toggle('on', open);
  $('#btn-queue').setAttribute('aria-pressed', open);
}).observe($('#queue'), { attributes: true, attributeFilter: ['hidden'] });
$('#queue-list').addEventListener('click', (e) => {
  if (e.target.closest('#queue-more')) { queue.n += 300; return loadQueue(); }
  const row = e.target.closest('.track');
  if (row) api.post('/api/queue/jump', { pid: row.dataset.pid }).then(onQueue, (err) => toast(err.message));
});
const toggleShuffle = () => api.post('/api/queue/shuffle', { on: !queue.sum?.shuffle }).then(onQueue, () => {});
$('#btn-shuffle').addEventListener('click', toggleShuffle);
$('#queue-shuffle').addEventListener('click', toggleShuffle);
$('#queue-repeat').addEventListener('click', () => api.post('/api/queue/repeat', { on: !queue.sum?.repeat }).then(onQueue, () => {}));

// ---------------- 词汇书 ----------------
let vocabList = [];
async function loadVocab() {
  try { vocabList = await api.get('/api/vocab'); } catch { vocabList = []; }
  renderVocab();
}
function renderVocab() {
  const q = $('#vocab-search').value.trim().toLowerCase();
  const list = vocabList.filter((v) => !q || [v.word, v.reading, v.meaning, v.line, v.song?.name].join('\n').toLowerCase().includes(q));
  $('#vocab-count').textContent = vocabList.length ? `· ${vocabList.length}` : '';
  $('#vocab-list').innerHTML = list.length ? list.map((v) => {
    const sentence = v.surface && v.line?.includes(v.surface) ? esc(v.line).replace(esc(v.surface), `<mark>${esc(v.surface)}</mark>`) : esc(v.line);
    return `<div class="vcard" data-id="${esc(v.id)}">
      <div class="vdel-zone"><button class="vdel" data-act="del" aria-label="删除这个词" title="删除"><span class="x">✕</span><span class="ext"><span>删除</span></span></button></div>
      <div class="w" lang="ja"><ruby>${esc(v.word)}<rt>${esc(v.reading !== v.word ? v.reading : '')}</rt></ruby><small>${esc(v.level || '')}</small></div>
      <div class="m" contenteditable="plaintext-only" spellcheck="false">${esc(v.meaning)}</div>
      <div class="s" lang="ja">${sentence}</div>${v.zh ? `<div class="z">${esc(v.zh)}</div>` : ''}
      <div class="f"><span>${esc([v.song?.name, v.song?.artist].filter(Boolean).join(' — '))}</span>
        <button class="btn small" data-act="play" title="播放这一句">▶ 听这句</button></div>
    </div>`;
  }).join('') : `<div class="empty">${vocabList.length ? '没有匹配的单词' : '词汇书还是空的。<br>打开「辞书」模式，点选歌词里的词就能添加。'}</div>`;
}
$('#vocab-search').addEventListener('input', renderVocab);
// 鼠标离开卡片：还没确认的「删除」收回成 ×
$('#vocab-list').addEventListener('mouseleave', (e) => {
  if (!e.target.matches?.('.vcard')) return;
  const b = e.target.querySelector('.vdel.armed');
  if (b && !b.disabled) { b.classList.remove('armed'); b.title = '删除'; }
}, true);
$('#vocab-list').addEventListener('focusout', (e) => {
  const m = e.target.closest('.m');
  if (!m) return;
  const id = m.closest('.vcard').dataset.id;
  const v = vocabList.find((x) => x.id === id);
  const meaning = m.textContent.trim();
  if (v && v.meaning !== meaning) { v.meaning = meaning; api.post('/api/vocab/update', { id, meaning }).catch(() => toast('保存失败')); }
});
$('#vocab-list').addEventListener('click', async (e) => {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const id = btn.closest('.vcard').dataset.id;
  const v = vocabList.find((x) => x.id === id);
  if (btn.dataset.act === 'del') {
    // 第一次点：× 展开成「删除」；再点一次才真的删
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.title = '再点一次确认删除';
      return;
    }
    const card = btn.closest('.vcard');
    btn.disabled = true;
    try { await api.post('/api/vocab/delete', { id }); } catch (err) { btn.disabled = false; return toast(`删除失败：${err.message}`); }
    vocabList = vocabList.filter((x) => x.id !== id);
    if (matchMedia('(prefers-reduced-motion: reduce)').matches) return renderVocab();
    // 卡片淡出并收起，下面的卡片顺势上移
    const cs = getComputedStyle(card);
    card.style.overflow = 'hidden';
    card.animate([
      { opacity: 1, height: `${card.offsetHeight}px`, marginTop: cs.marginTop, marginBottom: cs.marginBottom, paddingTop: cs.paddingTop, paddingBottom: cs.paddingBottom },
      { opacity: 0, height: '0px', marginTop: '0px', marginBottom: '0px', paddingTop: '0px', paddingBottom: '0px', borderWidth: '0px' },
    ], { duration: 240, easing: 'cubic-bezier(.3, .75, .2, 1)', fill: 'forwards' }).onfinish = renderVocab;
  } else if (v) {
    if (S.track?.pid !== v.song?.pid) {
      if (!v.song?.pid) return toast('这首歌不在资料库里，无法直接播放');
      await control('playTrack', v.song.pid);
      await new Promise((r) => setTimeout(r, 900));
    } else if (S.player?.state !== 'playing') control('play');
    seekTo((v.lineTime || 0) + S.offset);
  }
});

// ---------------- 歌词源 ----------------
async function openSource(q = '') {
  $('#source-modal').hidden = false;
  if (!S.track) { $('#src-list').innerHTML = '<div class="empty">先播放一首歌</div>'; return; }
  $('#src-list').innerHTML = '<div class="empty">搜索中…</div>';
  const p = new URLSearchParams({ name: S.track.name, artist: S.track.artist || '', duration: S.track.duration || 0, q });
  let list;
  try { list = await api.get(`/api/candidates?${p}`); } catch (e) { $('#src-list').innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  const cur = S.song?.source;
  $('#src-list').innerHTML = list.length ? list.map((c, i) => {
    const f = c.flags;
    const tags = f ? (f.lines ? [f.trans && '翻译', f.words && '逐字', f.roma && '注音'].filter(Boolean).map((x) => `<b>${x}</b>`).join('') || '<span>仅原文</span>' : '<span>无歌词</span>') : '';
    return `<div class="cand${cur && cur.source === c.source && cur.id === c.id ? ' cur' : ''}" data-i="${i}">
      <span class="src">${c.source === 'qq' ? 'QQ音乐' : '网易云'}</span><div class="t">${esc(c.title)}</div>
      <div class="x">${fmt(c.duration)}${tags}</div><div class="a">${esc(c.artists.join(' / '))}${c.album ? ' — ' + esc(c.album) : ''}</div></div>`;
  }).join('') : '<div class="empty">没有找到候选歌词，试试手动搜索日文原名。</div>';
  $('#src-list').onclick = async (e) => {
    const row = e.target.closest('.cand');
    if (!row) return;
    await api.post('/api/song/source', { key: S.song.key, cand: list[+row.dataset.i] });
    $('#source-modal').hidden = true;
    reloadSong();
  };
}
$('#src-search').addEventListener('click', () => openSource($('#src-q').value.trim()));
$('#src-q').addEventListener('keydown', (e) => { if (e.key === 'Enter') openSource($('#src-q').value.trim()); });
$('#src-auto').addEventListener('click', async () => {
  if (!S.song) return;
  await api.post('/api/song/source', { key: S.song.key, cand: null });
  $('#source-modal').hidden = true;
  reloadSong({ refresh: true });
});

// ---------------- 设置 ----------------
async function openSettings() {
  $('#settings-modal').hidden = false;
  $('#set-style').value = prefs.annStyle;
  $('#set-max').value = prefs.annMax; $('#set-max-val').textContent = `${prefs.annMax} 个`;
  $('#set-grammar').checked = prefs.annGrammar; $('#set-vocabs').checked = prefs.annVocab;
  $('#set-source').value = prefs.annSource;
  $('#set-lang').value = prefs.meaningLang;
  $('#set-autosense').checked = prefs.autoSense !== false;
  const picked = Object.keys(S.senses || {}).length;
  $('#set-clear-senses').hidden = !picked;
  $('#set-clear-senses').textContent = `清除这首歌里手动选的 ${picked} 个`;
  $('#set-levels').innerHTML = ['N5', 'N4', 'N3', 'N2', 'N1', 'x'].map((k) => `<label class="chk"><input type="checkbox" data-lv="${k}" ${prefs.levels[k] !== false ? 'checked' : ''}> ${k === 'x' ? '未分级' : k}</label>`).join(' ');
  $('#set-ai-state').textContent = S.song?.ai ? '当前歌曲已有 AI 讲解' : '';
  api.get('/api/info').then((i) => { $('#about-version').textContent = `版本 ${i.version || '未知'}　程序位置 ${i.root}`; }).catch(() => {});
  try {
    const s = await api.get('/api/settings');
    $('#set-model').value = s.model;
    $('#set-key').value = '';
    $('#set-key-state').textContent = s.hasKey ? `已保存（…${s.keyTail}）` : s.envKey ? '使用环境变量里的 Key' : '未设置';
    const auto = s.browsers[0] ? `自动（${s.browsers[0]}）` : '自动（系统默认浏览器）';
    $('#set-browser').innerHTML = `<option value="auto">${esc(auto)}</option>` + s.browsers.map((b) => `<option value="${esc(b)}">${esc(b)}</option>`).join('') + '<option value="default">系统默认浏览器（普通标签页）</option>';
    $('#set-browser').value = s.browser;
    $('#set-browser-apply').hidden = true;
  } catch { /* 忽略 */ }
}
function onAnnPrefChange() {
  prefs.annStyle = $('#set-style').value;
  prefs.annMax = +$('#set-max').value; $('#set-max-val').textContent = `${prefs.annMax} 个`;
  prefs.annGrammar = $('#set-grammar').checked; prefs.annVocab = $('#set-vocabs').checked;
  prefs.annSource = $('#set-source').value;
  prefs.meaningLang = $('#set-lang').value;
  prefs.autoSense = $('#set-autosense').checked;
  $$('#set-levels input').forEach((el) => { prefs.levels[el.dataset.lv] = el.checked; });
  savePrefs();
  paintAnnotations();
}
$('#set-clear-senses').addEventListener('click', async () => {
  if (!S.song) return;
  try { await api.post('/api/song/sense', { key: S.song.key, clear: true }); } catch (e) { return toast(`清除失败：${e.message}`); }
  S.senses = {};
  $('#set-clear-senses').hidden = true;
  paintAnnotations();
  toast('已清除，这首歌的多义词恢复自动选义');
});
for (const id of ['set-style', 'set-max', 'set-grammar', 'set-vocabs', 'set-source', 'set-lang', 'set-autosense', 'set-levels']) $(`#${id}`).addEventListener('input', onAnnPrefChange);
async function saveSettings() {
  const body = { model: $('#set-model').value.trim() };
  const key = $('#set-key').value.trim();
  if (key) body.apiKey = key;
  await api.post('/api/settings', body);
  $('#set-key').value = '';
  if (key) $('#set-key-state').textContent = `已保存（…${key.slice(-4)}）`;
}
$('#set-save').addEventListener('click', () => saveSettings().then(() => toast('设置已保存')).catch((e) => toast(e.message)));
// 界面窗口用哪个浏览器：选了就保存，下次打开界面时生效；也可以点「现在就换」马上用它重新打开
$('#set-browser').addEventListener('change', async (e) => {
  try { await api.post('/api/settings', { browser: e.target.value }); } catch (err) { return toast(`保存失败：${err.message}`); }
  $('#set-browser-apply').hidden = false;
  toast('已保存，下次打开界面时生效');
});
$('#set-browser-apply').addEventListener('click', async () => {
  try { await api.post('/api/show', { fresh: true }); } catch (err) { return toast(`打开失败：${err.message}`); }
  $('#set-browser-apply').hidden = true; // 新窗口出来后，服务端会通知原来的界面窗口自己关掉
});
$('#set-ai-run').addEventListener('click', async () => {
  if (!S.song?.lines.length || !S.song.flags?.japanese) return toast('先播放一首有日语歌词的歌');
  const btn = $('#set-ai-run'), state = $('#set-ai-state');
  btn.disabled = true;
  state.textContent = '生成中，通常需要半分钟到一两分钟…';
  try {
    await saveSettings();
    await api.post('/api/ai/annotate', { source: S.song.source, lines: S.song.lines.map((l) => ({ text: l.text, zh: l.zh })) });
    await reloadSong();
    state.textContent = '完成，已应用到当前歌曲';
  } catch (e) { state.textContent = `失败：${e.message}`; }
  btn.disabled = false;
});

// ---------------- 顶栏 / 浮层 / 快捷键 ----------------
function applyPrefs() {
  app.classList.toggle('view-apple', prefs.view === 'apple');
  app.classList.toggle('view-focus', prefs.view === 'focus');
  for (const k of ['furi', 'zh', 'roma', 'ann']) {
    app.classList.toggle(`no-${k}`, !prefs[k]);
    $(`[data-toggle=${k}]`).classList.toggle('on', prefs[k]);
  }
  $$('[data-view]').forEach((b) => b.classList.toggle('on', b.dataset.view === prefs.view));
  $('#db-char').checked = prefs.dictChar; $('#db-pause').checked = prefs.dictPause;
}
function setView(v) {
  prefs.view = v; savePrefs(); applyPrefs();
  collectFill();
  requestAnimationFrame(() => scrollToActive(true));
}
$$('[data-view]').forEach((b) => b.addEventListener('click', () => setView(b.dataset.view)));
$$('[data-toggle]').forEach((b) => b.addEventListener('click', () => {
  prefs[b.dataset.toggle] = !prefs[b.dataset.toggle]; savePrefs(); applyPrefs(); paintAnnotations();
  requestAnimationFrame(() => scrollToActive(true));
}));
// 二级菜单：显示开关留在菜单里可连续切换；工具项点了就收起菜单
function placeUnderMenuButton(pop) {
  const r = $('#btn-menu').getBoundingClientRect();
  pop.style.top = `${r.bottom + 8}px`;
  pop.style.left = `${clamp(r.right - pop.offsetWidth, 8, innerWidth - pop.offsetWidth - 8)}px`;
}
function toggleMenu(open = $('#menu').hidden) {
  $('#menu').hidden = !open;
  $('#btn-menu').classList.toggle('on', open);
  if (open) placeUnderMenuButton($('#menu'));
}
$('#btn-menu').addEventListener('click', () => toggleMenu());
$('#btn-dict').addEventListener('click', () => setMode('dict'));
$('#btn-edit').addEventListener('click', () => { toggleMenu(false); setMode('edit'); });
$('#btn-library').addEventListener('click', openLibrary);
$('#btn-vocab').addEventListener('click', () => { $('#queue').hidden = true; $('#vocab').hidden = false; loadVocab(); });
$('#btn-source').addEventListener('click', () => { toggleMenu(false); openSource(); });
$('#btn-settings').addEventListener('click', () => { toggleMenu(false); openSettings(); });
$('#btn-offset').addEventListener('click', () => {
  toggleMenu(false);
  const pop = $('#offset-pop');
  pop.hidden = false;
  placeUnderMenuButton(pop);
});
$$('[data-close]').forEach((b) => b.addEventListener('click', () => { b.closest('.drawer, .modal').hidden = true; }));
$$('.modal').forEach((m) => m.addEventListener('mousedown', (e) => { if (e.target === m) m.hidden = true; }));
document.addEventListener('mousedown', (e) => {
  // 敲击对齐开着时，点歌词是在对齐，不算「点到面板外面」，面板留着方便多敲几次
  if (!$('#offset-pop').hidden && !e.target.closest('#offset-pop, #btn-offset') && !(S.tapAlign && e.target.closest('#lyrics, #focus'))) $('#offset-pop').hidden = true;
  if (!$('#menu').hidden && !e.target.closest('#menu, #btn-menu')) toggleMenu(false);
  if (!$('#reading-pop').hidden && !e.target.closest('#reading-pop, .seg.k')) $('#reading-pop').hidden = true;
  for (const id of ['library', 'vocab']) if (!$(`#${id}`).hidden && !e.target.closest(`#${id}, #topbar`)) $(`#${id}`).hidden = true;
});

$('#btn-play').addEventListener('click', () => control('playpause'));
$('#btn-prev').addEventListener('click', () => control('prev'));
$('#btn-next').addEventListener('click', () => control('next'));
const seek = $('#seek');
seek.addEventListener('input', () => {
  S.dragging = true;
  const dur = S.track?.duration || 0;
  setProgress(seek.value / 1000);
  $('#t-cur').textContent = fmt((seek.value / 1000) * dur);
});
seek.addEventListener('change', () => { S.dragging = false; if (S.track) seekTo((seek.value / 1000) * S.track.duration); });

function stepLine(dir) {
  let i = clamp(S.active + dir, 0, S.lines.length - 1);
  while (S.lines[i]?.gap && i + dir >= 0 && i + dir < S.lines.length) i += dir;
  if (S.lines[i]) seekTo(S.lines[i].t + S.offset + 0.02);
}
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') {
    hideSensePop();
    const open = $$('.modal, .drawer, .popover').filter((el) => !el.hidden);
    if (open.length) { open.forEach((el) => { el.hidden = true; }); $('#btn-menu').classList.remove('on'); }
    else if (S.sel) $('#db-cancel').click();
    else if (S.mode) setMode(S.mode);
    return;
  }
  if (e.target.closest('input, select, textarea, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === ' ') { e.preventDefault(); control('playpause'); }
  else if (e.key === 'ArrowLeft') stepLine(-1);
  else if (e.key === 'ArrowRight') stepLine(1);
  else if (e.key === '[') setOffset(S.offset - 0.1);
  else if (e.key === ']') setOffset(S.offset + 0.1);
  else if (e.key === 'f' || e.key === 'F') setView(prefs.view === 'apple' ? 'focus' : 'apple');
  else if (e.key === 'd' || e.key === 'D') setMode('dict');
  else if (e.key === 'e' || e.key === 'E') setMode('edit');
});
addEventListener('resize', () => scrollToActive(true));

let toastTimer = 0;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg; el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 2600);
}

// ---------------- 启动 ----------------
applyPrefs();
updateOffsetLabel();
setStatus('正在连接 Apple Music…');
// 程序退出了（在设置里点了退出，或从程序坞退出）：盖上提示，不再重连
function showBye() {
  es.close();
  $$('.modal, .drawer, .popover').forEach((el) => { el.hidden = true; });
  $('#bye').hidden = false;
  setTimeout(() => window.close(), 600); // 独立窗口能直接关掉；普通标签页关不了，就留着提示
}
$('#set-quit').addEventListener('click', async () => {
  $('#set-quit').disabled = true;
  try { await api.post('/api/quit', {}); } catch (e) { $('#set-quit').disabled = false; return toast(`退出失败：${e.message}`); }
  showBye();
});
// 地址里带 ?app=1 的是程序自己打开的界面窗口：告诉服务端，它才知道界面窗口还在不在
const es = new EventSource(`/api/events${new URLSearchParams(location.search).has('app') ? '?app=1' : ''}`);
es.onmessage = (e) => onState(JSON.parse(e.data));
es.onerror = () => { if (!S.track) setStatus('和本地服务的连接断开了，请确认程序仍在运行。'); };
// 服务重启过（比如更新到了新版）：重新连上后自动刷新页面，换上新界面
let bootId = 0;
es.onopen = () => api.get('/api/info').then((i) => {
  if (bootId && i.boot && i.boot !== bootId) location.reload();
  bootId = i.boot || bootId;
}).catch(() => {});
requestAnimationFrame(frame);
// 调试入口：地址加 ?debug 后可在控制台用 __uta.onState(...) 模拟播放状态
if (new URLSearchParams(location.search).has('debug')) { es.close(); window.__uta = { onState, S, clock, prefs, tick }; }
