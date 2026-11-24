// 网易云音乐（Windows 客户端 3.x）桥接：接口和 music.js 一样，换个播放器而已。
//
// 客户端的界面是 Chromium（CEF）做的。用 `--remote-debugging-port` 启动它以后，可以通过 Chrome
// 调试协议（CDP）连上它的界面页面（orpheus://orpheus/pub/app.html）：
//   - 当前歌曲：从界面的 Redux store 里读 playing（有网易云的歌曲 ID，歌词按 ID 直接取）
//   - 播放进度：订阅客户端自己的 AudioPlayer.subscribePlayStatus（约每 30ms 回报一次）
//   - 播放 / 暂停 / 上一首 / 下一首 / 拖动进度：向 store 派发它自己界面用的那几个动作
// 不改动客户端的任何文件；只在它的页面里加一个小对象 window.__uta（客户端重启后就没了）。
//
// 注意：进度不能用全局的 legacyNativeCmder.appendRegisterCall 去订阅。底层每个事件只认一个接收者，
// 全局对象和客户端内部用的不是同一个，一注册就把客户端自己的接收者顶掉，它的进度条会卡住不动。
// AudioPlayer.subscribePlayStatus 走的是内部那一个，是往已有的列表里追加。
//
// 2.x 的老客户端不认调试端口参数，这个模式用不了。
// 资料库 / 指定播放某一首：这个模式下不支持（界面里会藏起来），在网易云里选歌即可。
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { dataPath, safeName } from './store.js';

export const NAME = '网易云音乐';
export const caps = { library: false, queue: false, seek: true };

const PORT = Number(process.env.UTA_NETEASE_PORT) || 9222;
const BASE = `http://127.0.0.1:${PORT}`;
const EXE_NAME = 'cloudmusic.exe';

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
// 只装一次（页面重新载入后会重装；本程序重启而网易云没重启时沿用已经装好的那个，不会重复订阅）。
// snap() 返回当前状态；cmd() 执行控制命令。写成普通函数再转成字符串送过去，方便检查语法。
function agent() {
  if (window.__uta && window.__uta.v === 1) return 'ok';
  // 界面的 Redux store：从 React 根节点往下找带 store 的组件
  const root = document.querySelector('#root') || document.body.firstElementChild;
  if (!root) return 'no-root';
  const fk = Object.keys(root).find((k) => k.startsWith('__reactContainer') || k.startsWith('__reactFiber'));
  let store = null;
  (function walk(n, d) {
    if (!n || d > 120 || store) return;
    const p = n.memoizedProps;
    if (p && p.store && typeof p.store.getState === 'function') { store = p.store; return; }
    walk(n.child, d + 1); walk(n.sibling, d);
  })(fk && root[fk], 0);
  if (!store) return 'no-store';
  // 客户端自己的 AudioPlayer：借 webpack 的模块表找（往 webpackJsonp 里放一个空模块，拿到 require）
  let req = null;
  try {
    const id = 'uta_' + Math.random().toString(36).slice(2);
    window.webpackJsonp.push([[id], { [id]: (m, e, r) => { req = r; } }, [[id]]]);
  } catch (e) { return 'no-webpack'; }
  let player = null;
  for (const k of Object.keys((req && req.c) || {})) {
    try {
      const ex = req.c[k] && req.c[k].exports;
      if (ex && ex.AudioPlayer && typeof ex.AudioPlayer.subscribePlayStatus === 'function') { player = ex.AudioPlayer; break; }
    } catch (e) { /* 有的模块一读就报错，跳过 */ }
  }
  if (!player) return 'no-player';
  // playId 形如「歌曲ID_随机串」（本地歌曲是「track-歌曲ID_随机串」）
  const idOf = (playId) => String(playId || '').replace(/_[^_]*$/, '');
  const prog = { id: '', pos: 0, at: 0 };
  player.subscribePlayStatus({ type: 'playprogress', callback: (i) => {
    const pos = Number(i && i.current);
    if (!(pos >= 0)) return;
    prog.id = idOf(i.playId); prog.pos = pos; prog.at = Date.now();
  } });
  player.subscribePlayStatus({ type: 'seek', callback: (i) => {
    const pos = Number(i && i.position);
    if (!(pos >= 0)) return;
    prog.id = idOf(i.playId); prog.pos = pos; prog.at = Date.now();
  } });
  window.__uta = {
    v: 1,
    snap() {
      const pl = store.getState().playing || {};
      const rid = String(pl.resourceTrackId || '');
      if (!rid) return { state: 'stopped' };
      const t = pl.curTrack || {};
      const state = pl.playingState === 2 ? 'playing' : 'paused';
      let pos = null; // 还不知道进度（刚连上、还没收到第一次回报）：不报，界面沿用自己的时钟
      if (prog.id === rid) {
        pos = prog.pos;
        // 进度每 30ms 左右来一次；万一断了一下，按播放速度往前推，最多推 2 秒
        if (state === 'playing' && prog.at) pos += Math.min(2, (Date.now() - prog.at) / 1000) * (pl.playingSpeed || 1);
      } else if (pl.restoreResource && String(pl.restoreResource.trackId || pl.restoreResource.id) === rid) pos = Number(pl.restoreResource.current) || 0;
      // 网易云的歌曲 ID：在线歌曲就是 resourceTrackId；本地歌曲（track-…）认出来的那首在 onlineResourceId / curTrack.id
      const nid = [rid, pl.onlineResourceId, t.id].map((x) => String(x || '')).find((x) => /^[1-9]\d*$/.test(x)) || '';
      const album = t.album || {};
      const artists = (pl.resourceArtists && pl.resourceArtists.length ? pl.resourceArtists : t.artists) || [];
      const dur = Number(pl.resourceDuration) || (t.duration > 10000 ? t.duration / 1000 : Number(t.duration) || 0);
      return {
        state, pos, vol: Math.round((pl.playingVolume == null ? 1 : pl.playingVolume) * 100),
        track: {
          rid, id: nid, name: pl.resourceName || t.name || '', artist: artists.map((a) => a.name).filter(Boolean).join(' / '),
          album: album.name || album.albumName || '', duration: t.duration > 10000 ? t.duration / 1000 : dur,
          cover: pl.resourceCoverUrl || album.picUrl || album.cover || '',
          alias: [].concat(t.alias || [], t.transNames || []),
        },
      };
    },
    cmd(c, a) {
      const pl = store.getState().playing || {};
      const playing = pl.playingState === 2;
      const go = (type, payload) => { store.dispatch(payload === undefined ? { type } : { type, payload }); return null; };
      switch (c) {
        case 'playpause': return go(playing ? 'playing/pause' : 'playing/resume');
        case 'play': return playing ? null : go('playing/resume');
        case 'pause': return playing ? go('playing/pause') : null;
        case 'next': return go('playingList/jump2Track', { flag: 1, type: 'call', triggerScene: 'track' });
        case 'prev': return go('playingList/jump2Track', { flag: -1, type: 'call', triggerScene: 'track' });
        case 'seek': {
          const rid = String(pl.resourceTrackId || '');
          if (!rid) throw new Error('没有正在播放的歌');
          const to = Math.max(0, Number(a) || 0);
          go('playing/setPlayingPosition', { duration: to }); // 字段名叫 duration，其实是要跳到的秒数
          prog.id = rid; prog.pos = to; prog.at = Date.now();
          return null;
        }
        default: throw new Error('网易云模式不支持：' + c);
      }
    },
  };
  return 'ok';
}
const AGENT = `(${agent})()`;

// ---------- 找到 / 启动网易云 ----------
const run = (cmd, args, timeout = 8000) => new Promise((resolve) => {
  execFile(cmd, args, { timeout, windowsHide: true }, (err, stdout) => resolve(err ? '' : String(stdout)));
});
const isRunning = async () => (await run('tasklist', ['/FI', `IMAGENAME eq ${EXE_NAME}`, '/NH'])).toLowerCase().includes(EXE_NAME);
// 安装位置：环境变量 UTA_NETEASE_EXE > 注册表里登记的安装目录 > 常见位置
async function findExe() {
  const cands = [process.env.UTA_NETEASE_EXE];
  for (const key of ['HKLM\\SOFTWARE\\WOW6432Node\\Netease\\CloudMusic', 'HKLM\\SOFTWARE\\Netease\\CloudMusic', 'HKCU\\SOFTWARE\\Netease\\CloudMusic']) {
    const m = /install_dir\s+REG_SZ\s+(.+)/i.exec(await run('reg', ['query', key, '/v', 'install_dir']));
    if (m) cands.push(path.join(m[1].trim(), EXE_NAME));
  }
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA && path.join(process.env.LOCALAPPDATA, 'Programs')]) {
    if (base) cands.push(path.join(base, 'NetEase', 'CloudMusic', EXE_NAME));
  }
  return cands.find((p) => p && fs.existsSync(p)) || '';
}
async function launch() {
  const exe = await findExe();
  if (!exe) return false;
  // 调试端口只监听本机
  spawn(exe, [`--remote-debugging-port=${PORT}`, '--remote-debugging-address=127.0.0.1'], { cwd: path.dirname(exe), stdio: 'ignore', detached: true }).unref();
  return true;
}
// 关掉正在运行的网易云，再带着调试端口重新打开（界面上用户点了按钮才会调用）。
// 先客气地请它退出；它多半只是缩到托盘，几秒后还在就强制结束
export async function relaunch() {
  await run('taskkill', ['/IM', EXE_NAME, '/T']);
  for (let i = 0; i < 8 && (await isRunning()); i++) await new Promise((r) => setTimeout(r, 400));
  if (await isRunning()) {
    await run('taskkill', ['/IM', EXE_NAME, '/T', '/F']);
    for (let i = 0; i < 15 && (await isRunning()); i++) await new Promise((r) => setTimeout(r, 300));
  }
  launching = Date.now();
  await launch();
}

// ---------- 状态轮询（和 music.js 的 WATCHER 一样，每 250ms 一次 'state'） ----------
export const player = new EventEmitter();
player.state = { running: false };
let timer = null, launching = 0, busy = false;
let lastCover = { pid: '', url: '' };

function emit(s) {
  s.ts = Date.now();
  player.state = s;
  player.emit('state', s);
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    if (!ws) {
      try { await connect(); }
      catch (e) {
        if (e.code === 'node') return emit({ running: false, err: e.message, errno: 'node' });
        // 网易云开着、但不是带调试端口启动的：需要用户同意重开一次（界面上有按钮）
        if (await isRunning()) return emit({ running: false, errno: 'netease-no-port', err: '网易云不是由唱歌学日语启动的' });
        // 网易云没开：替用户带着调试端口把它打开（30 秒内只试一次）
        if (Date.now() - launching > 30000) {
          launching = Date.now();
          if (!(await launch())) return emit({ running: false, errno: 'netease-not-found', err: '没有找到网易云音乐' });
        }
        return emit({ running: false, waiting: true });
      }
    }
    const s = await evaluate(`(${AGENT}) === 'ok' ? window.__uta.snap() : null`);
    if (!s) return emit({ running: true, waiting: true }); // 界面还没加载完
    const out = { running: true, state: s.state, vol: s.vol };
    if (s.track) {
      // 认得出是网易云哪首歌的用它的 ID；认不出的本地歌曲用客户端自己的编号，歌词靠搜索
      out.pid = s.track.id ? `ne-${s.track.id}` : `nel-${safeName(s.track.rid)}`;
      if (typeof s.pos === 'number') out.pos = s.pos;
      out.track = { pid: out.pid, neteaseId: s.track.id || '', name: s.track.name, artist: s.track.artist, album: s.track.album, duration: s.track.duration, cover: s.track.cover, alias: s.track.alias };
      lastCover = { pid: out.pid, url: s.track.cover };
    }
    emit(out);
  } catch (e) {
    if (ws) { try { ws.close(); } catch {} ws = null; }
    emit({ running: false, err: String(e.message || e) });
  } finally { busy = false; }
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

// ---------- 资料库：这个模式下不支持 ----------
export async function getLibrary() { return []; }
export async function getPlaylists() { return []; }

// ---------- 封面：下载当前歌曲的封面图 ----------
async function download(pid, url, size) {
  const file = dataPath('artwork', `${safeName(pid)}${size ? '.t' : ''}.jpg`);
  if (fs.existsSync(file) && fs.statSync(file).size > 0) return { file, type: 'image/jpeg' };
  if (!url) return null;
  try {
    const r = await fetch(`${url.replace(/^http:/, 'https:')}?param=${size || 600}y${size || 600}`, { signal: AbortSignal.timeout(8000) });
    if (!r.ok) return null;
    fs.mkdirSync(dataPath('artwork'), { recursive: true });
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    return { file, type: 'image/jpeg' };
  } catch { return null; }
}
export const getArtwork = (pid) => download(pid, lastCover.pid === pid ? lastCover.url : '');
export const getThumb = (pid) => download(pid, lastCover.pid === pid ? lastCover.url : '', 160);
