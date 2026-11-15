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
  dictChar: false, dictPause: true, meaningLang: 'zh',
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
  if (line.gap) return '<span class="dots"><i></i><i></i><i></i></span>';
  let html = '';
  line.tokens.forEach((tok, ti) => {
    let ci = tok.i0, inner = '';
    tok.segs.forEach((seg, si) => {
      const c0 = ci;
      let chars = '';
      for (const ch of seg.t) { chars += `<span class="ch" data-c="${ci}">${esc(ch)}</span>`; ci += ch.length; }
      const isK = KANJI.test(seg.t);
      let timing = '';
      if (line.ct && line.ct[c0]) timing = ` data-t0="${line.ct[c0][0]}" data-t1="${(line.ct[ci - 1] || line.ct[c0])[1]}"`;
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
  $('#f-prev').innerHTML = plain(S.lines[i - 1]);
  const next = S.lines[i < 0 ? 0 : i + 1];
  $('#f-next').innerHTML = plain(next);
  $('#f-next').dataset.i = next ? S.lines.indexOf(next) : '';
  const cur = $('#f-cur');
  cur.className = `f-cur${line?.ct ? ' timed' : ''}`;
  cur.innerHTML = line ? lineBody(line, i) : (S.lines.length ? '<div class="jp"><span class="dots"><i></i><i></i><i></i></span></div>' : '');
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
function setActive(i) {
  S.active = i;
  const els = $('#scroll').children;
  for (let k = 0; k < els.length; k++) {
    const el = els[k];
    el.classList.toggle('active', k === i);
    el.classList.toggle('past', k < i);
    el.style.setProperty('--d', Math.abs(k - Math.max(i, 0)));
  }
  renderFocus();
  scrollToActive();
  collectFill();
}
function collectFill() {
  const line = S.lines[S.active];
  S.fill = null;
  if (!line) return;
  const root = prefs.view === 'focus' ? $('#f-cur') : $('#scroll').children[S.active];
  if (!root) return;
  if (line.gap) S.fill = { gap: true, line, dots: $$('.dots i', root) };
  else if (line.ct) S.fill = { segs: $$('.seg', root).filter((el) => el.dataset.t0).map((el) => ({ el, t0: +el.dataset.t0, t1: +el.dataset.t1 })) };
}
let freeTimer = 0;
function scrollToActive(instant) {
  if (prefs.view !== 'apple') return;
  const sc = $('#scroll');
  if (sc.classList.contains('free')) return;
  const el = sc.children[Math.max(S.active, 0)];
  if (!el) return;
  sc.scrollTo({ top: el.offsetTop - sc.clientHeight * 0.3, behavior: instant ? 'instant' : 'smooth' });
}
for (const ev of ['wheel', 'touchmove']) {
  $('#scroll').addEventListener(ev, () => {
    const sc = $('#scroll');
    sc.classList.add('free');
    clearTimeout(freeTimer);
    freeTimer = setTimeout(() => { sc.classList.remove('free'); scrollToActive(); }, S.mode ? 8000 : 3500);
  }, { passive: true });
}

function frame() {
  requestAnimationFrame(frame);
// 调试入口：地址加 ?debug 后可在控制台用 __uta.onState(...) 模拟播放状态
if (new URLSearchParams(location.search).has('debug')) { es.close(); window.__uta = { onState, S, clock, prefs }; }
  const pos = now();
  const dur = S.track?.duration || 0;
  if (!S.dragging) {
    $('#progress-fill').style.width = dur ? `${clamp(pos / dur) * 100}%` : '0';
    $('#t-cur').textContent = fmt(pos);
    $('#t-rem').textContent = `-${fmt(Math.max(0, dur - pos))}`;
  }
  if (!S.lines.length) return;
  const t = pos - S.offset;
  const i = findActive(t);
  if (i !== S.active) setActive(i);
  const f = S.fill;
  if (!f) return;
  if (f.gap) {
    const span = (f.line.end - f.line.t) / 3;
    f.dots.forEach((d, k) => d.style.setProperty('--p', clamp((t - f.line.t - k * span) / span)));
  } else {
    for (const s of f.segs) s.el.style.setProperty('--p', clamp((t - s.t0) / Math.max(0.05, s.t1 - s.t0)));
  }
}

// 词典释义按设置的语言取：中文（有道）/ 英文（Jisho）/ 两者
function meaningOf(d) {
  if (!d) return '';
  const zh = d.zh || '', en = d.en?.[0] || '';
  if (prefs.meaningLang === 'en') return en || zh;
  if (prefs.meaningLang === 'both') return [zh, en].filter(Boolean).join(' / ');
  return zh || en;
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
        // 纯假名写的动词（如可能形「なれる」）在词典里常对到别的词，宁可不标
        if (tok.pos === '动' && !KANJI.test(tok.b) && d.w !== tok.b) return;
        items.push({ type: 'v', title: tok.b, rd: d.r, lv: d.lv, desc: meaningOf(d), start: ti, end: ti + 1 });
      });
    }
  }
  const seen = new Set();
  const uniq = items.filter((a) => { const k = a.type + a.title; if (seen.has(k)) return false; seen.add(k); return true; });
  const rank = (a) => RANK[a.lv] ?? 2.5;
  return uniq
    .map((a, k) => ({ a, k })).sort((x, y) => rank(y.a) - rank(x.a) || x.k - y.k)
    .slice(0, prefs.annMax).sort((x, y) => x.a.start - y.a.start || x.k - y.k).map((x) => x.a);
}
function chipHTML(a) {
  return `<span class="chip ${a.type}"><b>${esc(a.title)}</b>${a.rd && a.rd !== a.title ? `<span class="rd">${esc(a.rd)}</span>` : ''}${a.lv ? `<span class="lv">${a.lv}</span>` : ''}<span class="ds">${esc(a.desc)}</span></span>`;
}
function paintAnnotations() {
  const line = S.lines[S.active];
  const anns = prefs.ann ? annotationsFor(line) : [];
  S.annByTok = {};
  for (const a of anns) for (let k = a.start; k < a.end; k++) (S.annByTok[k] ||= []).push(a);
  const html = prefs.annStyle === 'underline' ? '' : anns.map(chipHTML).join('');
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
  tip.innerHTML = list.map((a) => `<div><b>${esc(a.title)}</b>${a.rd ? `（${esc(a.rd)}）` : ''} ${a.lv || ''}<br>${esc(a.desc)}</div>`).join('<hr style="border:0;border-top:1px solid var(--line)">');
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
  if (S.mode === 'edit' && (lineEl || inFocus)) return editClick(e);
  const next = e.target.closest('#f-next');
  const i = lineEl ? +lineEl.dataset.i : next && next.dataset.i !== '' ? +next.dataset.i : -1;
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

// ---------------- 辞书模式 ----------------
function setMode(mode) {
  S.mode = S.mode === mode ? null : mode;
  app.classList.toggle('dict-mode', S.mode === 'dict');
  app.classList.toggle('edit-mode', S.mode === 'edit');
  app.classList.toggle('by-char', S.mode === 'dict' && prefs.dictChar);
  $('#btn-dict').classList.toggle('on', S.mode === 'dict');
  $('#btn-edit').classList.toggle('on', S.mode === 'edit');
  $('#mode-chip').hidden = S.mode !== 'edit';
  $('#dictbar').hidden = S.mode !== 'dict';
  $('#reading-pop').hidden = true;
  tip.hidden = true;
  if (S.mode !== 'dict') { S.sel = null; paintSelection(); resumeIfPausedByDict(); }
  updateDictBar();
  if (S.mode === 'edit') toast('点击带虚线框的汉字即可修改读音');
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
    if (!m.dataset.dirty && !m.value) m.value = meaningOf(d);
    const detail = [d.zh, prefs.meaningLang !== 'zh' || !d.zh ? (d.en || []).join('; ') : ''].filter(Boolean).join('　');
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
function editClick(e) {
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
  control('playTrack', row.dataset.pid, $('#lib-playlist').value);
  $$('#lib-list .cur').forEach((el) => el.classList.remove('cur'));
  row.classList.add('cur');
});
$('#lib-search').addEventListener('input', renderLibrary);
$('#lib-ja').addEventListener('change', renderLibrary);
$('#lib-recent').addEventListener('change', renderLibrary);
$('#lib-playlist').addEventListener('change', async (e) => {
  $('#lib-list').innerHTML = '<div class="empty">读取中…</div>';
  try { lib.tracks = markJapanese(await api.get(`/api/library?playlist=${encodeURIComponent(e.target.value)}`)); renderLibrary(); }
  catch (err) { $('#lib-list').innerHTML = `<div class="empty">${esc(err.message)}</div>`; }
});

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
      <div class="w" lang="ja"><ruby>${esc(v.word)}<rt>${esc(v.reading !== v.word ? v.reading : '')}</rt></ruby><small>${esc(v.level || '')}</small></div>
      <div class="m" contenteditable="plaintext-only" spellcheck="false">${esc(v.meaning)}</div>
      <div class="s" lang="ja">${sentence}</div>${v.zh ? `<div class="z">${esc(v.zh)}</div>` : ''}
      <div class="f"><span>${esc([v.song?.name, v.song?.artist].filter(Boolean).join(' — '))}</span>
        <button class="btn small" data-act="play" title="播放这一句">▶ 听这句</button><button class="btn small" data-act="del">删除</button></div>
    </div>`;
  }).join('') : `<div class="empty">${vocabList.length ? '没有匹配的单词' : '词汇书还是空的。<br>打开「辞书」模式，点选歌词里的词就能添加。'}</div>`;
}
$('#vocab-search').addEventListener('input', renderVocab);
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
    await api.post('/api/vocab/delete', { id }).catch(() => {});
    vocabList = vocabList.filter((x) => x.id !== id);
    renderVocab();
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
  $('#set-levels').innerHTML = ['N5', 'N4', 'N3', 'N2', 'N1', 'x'].map((k) => `<label class="chk"><input type="checkbox" data-lv="${k}" ${prefs.levels[k] !== false ? 'checked' : ''}> ${k === 'x' ? '未分级' : k}</label>`).join(' ');
  $('#set-ai-state').textContent = S.song?.ai ? '当前歌曲已有 AI 讲解' : '';
  try {
    const s = await api.get('/api/settings');
    $('#set-model').value = s.model;
    $('#set-key').value = '';
    $('#set-key-state').textContent = s.hasKey ? `已保存（…${s.keyTail}）` : s.envKey ? '使用环境变量里的 Key' : '未设置';
  } catch { /* 忽略 */ }
}
function onAnnPrefChange() {
  prefs.annStyle = $('#set-style').value;
  prefs.annMax = +$('#set-max').value; $('#set-max-val').textContent = `${prefs.annMax} 个`;
  prefs.annGrammar = $('#set-grammar').checked; prefs.annVocab = $('#set-vocabs').checked;
  prefs.annSource = $('#set-source').value;
  prefs.meaningLang = $('#set-lang').value;
  $$('#set-levels input').forEach((el) => { prefs.levels[el.dataset.lv] = el.checked; });
  savePrefs();
  paintAnnotations();
}
for (const id of ['set-style', 'set-max', 'set-grammar', 'set-vocabs', 'set-source', 'set-lang', 'set-levels']) $(`#${id}`).addEventListener('input', onAnnPrefChange);
async function saveSettings() {
  const body = { model: $('#set-model').value.trim() };
  const key = $('#set-key').value.trim();
  if (key) body.apiKey = key;
  await api.post('/api/settings', body);
  $('#set-key').value = '';
  if (key) $('#set-key-state').textContent = `已保存（…${key.slice(-4)}）`;
}
$('#set-save').addEventListener('click', () => saveSettings().then(() => toast('设置已保存')).catch((e) => toast(e.message)));
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
$('#mode-chip').addEventListener('click', () => { if (S.mode === 'edit') setMode('edit'); });
$('#btn-library').addEventListener('click', openLibrary);
$('#btn-vocab').addEventListener('click', () => { $('#vocab').hidden = false; loadVocab(); });
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
  if (!$('#offset-pop').hidden && !e.target.closest('#offset-pop, #btn-offset')) $('#offset-pop').hidden = true;
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
  $('#progress-fill').style.width = `${seek.value / 10}%`;
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
const es = new EventSource('/api/events');
es.onmessage = (e) => onState(JSON.parse(e.data));
es.onerror = () => { if (!S.track) setStatus('和本地服务的连接断开了，请确认程序仍在运行。'); };
requestAnimationFrame(frame);
// 调试入口：地址加 ?debug 后可在控制台用 __uta.onState(...) 模拟播放状态
if (new URLSearchParams(location.search).has('debug')) { es.close(); window.__uta = { onState, S, clock, prefs }; }
