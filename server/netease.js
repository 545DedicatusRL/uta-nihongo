// 网易云音乐（Mac 客户端）桥接：接口和 music.js 一样，换个播放器而已。
//
// 网易云的 Mac 客户端没有 AppleScript 接口，但它的界面是 Chromium（CEF）做的。用
// `--remote-debugging-port` 启动它以后，可以通过 Chrome 调试协议（CDP）连上它的界面页面：
//   - 当前歌曲：从界面的 Redux store 里读 playing.curTrack（有网易云的歌曲 ID，歌词可以按 ID 直接取）
//   - 播放进度：订阅客户端自己的 audioplayer.PlayProgress 回报
//   - 播放 / 暂停 / 上一首 / 下一首：点它界面底部的按钮（让它自己的状态保持一致）
//   - 拖动进度：调用 audioplayer.seek
// 不改动客户端的任何文件；只在它的页面里加一个只读的小对象 window.__uta（客户端重启后就没了）。
// 资料库 / 指定播放某一首：网易云没有对应的接口，这个模式下不支持（界面里会藏起来）。
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { dataPath, safeName } from './store.js';

export const NAME = '网易云音乐';
export const caps = { library: false, queue: false };

const PORT = Number(process.env.UTA_NETEASE_PORT) || 9222;
const APP = 'NeteaseMusic';
const BASE = `http://127.0.0.1:${PORT}`;

// ---------- 最小的 CDP 客户端（Node 22+ 自带 WebSocket） ----------
let ws = null, seq = 0;
const pending = new Map();
async function connect() {
  if (typeof WebSocket === 'undefined') throw Object.assign(new Error('需要 Node.js 22 或更新版本'), { code: 'node' });
  const list = await (await fetch(`${BASE}/json`, { signal: AbortSignal.timeout(1500) })).json();
  const page = list.find((p) => p.type === 'page' && /app\.html/.test(p.url)) || list.find((p) => p.type === 'page');
  if (!page) throw new Error('没有找到网易云的界面页面');
  const sock = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    sock.onopen = resolve;
    sock.onerror = () => reject(new Error('连不上网易云的调试端口'));
  });
  sock.onmessage = (e) => {
    let m; try { m = JSON.parse(e.data); } catch { return; }
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.reject(new Error(m.error.message));
    else if (m.result?.exceptionDetails) p.reject(new Error(m.result.exceptionDetails.exception?.description || m.result.exceptionDetails.text));
    else p.resolve(m.result?.result?.value);
  };
  sock.onclose = () => {
    if (ws === sock) ws = null;
    for (const p of pending.values()) p.reject(new Error('连接断开'));
    pending.clear();
  };
  ws = sock;
}
function evaluate(expression, timeout = 3000) {
  if (!ws) return Promise.reject(new Error('未连接'));
  const id = ++seq;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('网易云没有响应')); }, timeout);
    pending.set(id, { resolve: (v) => { clearTimeout(timer); resolve(v); }, reject: (e) => { clearTimeout(timer); reject(e); } });
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, returnByValue: true, awaitPromise: true } }));
  });
}

// ---------- 放进网易云页面里的小助手 ----------
// 只装一次（页面重新载入后会重装）。snap() 返回当前状态；cmd() 执行控制命令。
const AGENT = `(() => {
  if (window.__uta && window.__uta.v === 3) return 'ok';
  const findStore = () => {
    const root = document.querySelector('#root') || document.body.firstElementChild;
    if (!root) return null;
    const k = Object.keys(root).find((k) => k.startsWith('__reactContainer'));
    let found = null;
    (function walk(n, d) {
      if (!n || d > 80 || found) return;
      const p = n.memoizedProps;
      if (p && p.store && typeof p.store.getState === 'function') { found = p.store; return; }
      walk(n.child, d + 1); walk(n.sibling, d);
    })(k && root[k], 0);
    return found;
  };
  const store = findStore();
  if (!store) return 'no-store';
  const prog = { id: '', pos: 0, at: 0 };
  // 客户端底层每隔一小会儿报一次进度，形如 (歌曲ID, "12.07", "1.0000")。
  // 给 window.MNBCallback 赋值不会替换原来的处理，而是登记一个「事后」监听（客户端自己的设计），
  // 每条底层回报都会再交给它一份；这里只认出进度那一种
  window.MNBCallback = (seqId, args) => {
    if (!Array.isArray(args) || args.length !== 3) return;
    const [id, pos, rate] = args;
    if (!/^\\d+$/.test(String(id)) || !/^\\d+(\\.\\d+)?$/.test(String(pos)) || !/^\\d+\\.\\d{4}$/.test(String(rate))) return;
    prog.id = String(id); prog.pos = Number(pos); prog.at = Date.now();
  };
  // 底部播放栏的按钮（标题形如「暂停（空格）」「下一首（⌘→）」）；只找屏幕上看得见的那个
  const button = (re) => {
    const el = [...document.querySelectorAll('[title]')].find((e) => re.test(e.getAttribute('title')) && e.getBoundingClientRect().width > 0 && /（/.test(e.getAttribute('title')));
    return el ? (el.closest('button,[role=button]') || el) : null;
  };
  const rid = () => Math.random().toString(36).slice(2, 8).toUpperCase();
  window.__uta = {
    v: 3,
    snap() {
      const pl = store.getState().playing || {};
      const t = pl.curTrack;
      const state = pl.playingState === 2 ? 'playing' : pl.playingState === 1 ? 'paused' : 'stopped';
      if (!t || !t.id) return { state: 'stopped' };
      const id = String(t.id);
      let pos = 0;
      if (prog.id === id) {
        pos = prog.pos;
        if (state === 'playing' && prog.at) pos += Math.min(2, (Date.now() - prog.at) / 1000) * (pl.playingSpeed || 1);
      } else if (pl.restoreResource && String(pl.restoreResource.id) === id) pos = Number(pl.restoreResource.current) || 0;
      const album = t.album || {};
      return {
        state, pos, vol: Math.round((pl.playingVolume ?? 1) * 100),
        track: {
          id, name: t.name || '', artist: (t.artists || []).map((a) => a.name).join(' / '),
          album: album.name || album.albumName || '', duration: (t.duration || 0) / 1000,
          cover: album.picUrl || album.cover || pl.resourceCoverUrl || '',
          alias: [...(t.alias || []), ...(t.transNames || [])],
        },
      };
    },
    cmd(c, a) {
      const pl = store.getState().playing || {};
      const playing = pl.playingState === 2;
      const click = (re) => { const b = button(re); if (!b) throw new Error('找不到网易云的播放按钮'); b.click(); };
      switch (c) {
        case 'playpause': return click(playing ? /^暂停/ : /^播放/);
        case 'play': return playing ? null : click(/^播放/);
        case 'pause': return playing ? click(/^暂停/) : null;
        case 'next': return click(/^下一首/);
        case 'prev': return click(/^上一首/);
        case 'seek': {
          const id = String((pl.curTrack && pl.curTrack.id) || pl.resourceTrackId || '');
          if (!id) throw new Error('没有正在播放的歌');
          const to = Math.max(0, Number(a) || 0);
          // 和它自己拖进度条时发给底层的命令一样：audioplayer.seek(歌曲ID, "ID|seek|随机串", 秒数)
          ncmChannelOSX.postMessage({ method: 'call', command: 'audioplayer.seek', params: [id, id + '|seek|' + rid(), to], seq: '::[[native-intf]]::uta-' + rid() });
          prog.id = id; prog.pos = to; prog.at = Date.now();
          return null;
        }
        default: throw new Error('网易云模式不支持：' + c);
      }
    },
  };
  return 'ok';
})()`;

// ---------- 状态轮询（和 music.js 的 WATCHER 一样，每 250ms 一次 'state'） ----------
export const player = new EventEmitter();
player.state = { running: false };
let timer = null, launching = 0, busy = false;

function emit(s) {
  s.ts = Date.now();
  player.state = s;
  player.emit('state', s);
}
const isRunning = () => new Promise((resolve) => execFile('pgrep', ['-x', APP], (err) => resolve(!err)));

async function tick() {
  if (busy) return;
  busy = true;
  try {
    if (!ws) {
      try { await connect(); }
      catch (e) {
        if (e.code === 'node') return emit({ running: false, err: e.message, errno: 'node' });
        const up = await isRunning();
        // 网易云开着、但不是带调试端口启动的：需要用户同意重开一次（界面上有按钮）
        if (up) return emit({ running: false, errno: 'netease-no-port', err: '网易云不是由唱歌学日语启动的' });
        // 网易云没开：替用户带着调试端口把它打开（30 秒内只试一次）
        if (Date.now() - launching > 30000) { launching = Date.now(); launch(); }
        return emit({ running: false, waiting: true });
      }
    }
    // 小助手装好了就直接取状态（页面重新载入过的话会先重装）
    const s = await evaluate(`(${AGENT}) === 'ok' ? window.__uta.snap() : null`);
    if (!s) return emit({ running: true, waiting: true }); // 界面还没加载完
    const out = { running: true, state: s.state, vol: s.vol };
    if (s.track) {
      out.pid = 'ne-' + s.track.id;
      out.pos = s.pos;
      out.track = { pid: out.pid, neteaseId: s.track.id, name: s.track.name, artist: s.track.artist, album: s.track.album, duration: s.track.duration, cover: s.track.cover, alias: s.track.alias };
      lastCover = { pid: out.pid, url: s.track.cover };
    }
    emit(out);
  } catch (e) {
    if (ws) { try { ws.close(); } catch {} ws = null; }
    emit({ running: false, err: String(e.message || e) });
  } finally { busy = false; }
}

function launch() {
  spawn('open', ['-a', APP, '--args', `--remote-debugging-port=${PORT}`], { stdio: 'ignore', detached: true }).unref();
}
// 关掉正在运行的网易云，再带着调试端口重新打开（界面上用户点了按钮才会调用）
export async function relaunch() {
  await new Promise((resolve) => execFile('osascript', ['-e', `quit app "${APP}"`], { timeout: 15000 }, () => resolve()));
  for (let i = 0; i < 30 && (await isRunning()); i++) await new Promise((r) => setTimeout(r, 500));
  launching = Date.now();
  launch();
}

export function startWatcher() {
  if (timer) return;
  timer = setInterval(tick, 250);
  tick();
}
export function stopWatcher() {
  clearInterval(timer); timer = null;
  if (ws) { try { ws.close(); } catch {} ws = null; }
}

// ---------- 播放控制 ----------
export async function control(cmd, a = '') {
  if (cmd === 'relaunch') { await relaunch(); return 'ok'; }
  if (cmd === 'volume') return 'ok'; // 音量交给网易云自己
  if (!ws) throw new Error('还没有连上网易云');
  await evaluate(`window.__uta.cmd(${JSON.stringify(cmd)}, ${JSON.stringify(String(a))})`);
  return 'ok';
}

// ---------- 资料库：网易云模式下不支持 ----------
export async function getLibrary() { return []; }
export async function getPlaylists() { return []; }

// ---------- 封面：下载当前歌曲的封面图 ----------
let lastCover = { pid: '', url: '' };
async function download(pid, url, size) {
  const file = dataPath('artwork', `${safeName(pid)}${size ? '.t' : ''}.jpg`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return { file, type: 'image/jpeg' };
  if (!url) return null;
  try {
    const r = await fetch(url.replace(/^http:/, 'https:') + `?param=${size || 600}y${size || 600}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    fs.mkdirSync(dataPath('artwork'), { recursive: true });
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    return { file, type: 'image/jpeg' };
  } catch { return null; }
}
export function getArtwork(pid) {
  return download(pid, lastCover.pid === pid ? lastCover.url : '');
}
export function getThumb(pid) {
  return download(pid, lastCover.pid === pid ? lastCover.url : '', 160);
}
