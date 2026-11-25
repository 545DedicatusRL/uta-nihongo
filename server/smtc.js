// QQ 音乐（Windows）桥接：接口和 music.js 一样，换个播放器而已。
//
// 走的是 Windows 的系统媒体接口 SMTC（系统音量浮窗里显示歌名、能点上一首 / 下一首的那一套）。
// QQ 音乐 21.10 起会把歌名、播放状态和进度报给它，前提是在 QQ 音乐里打开
// 「设置 → 常规设置 → 通知 → 显示系统媒体传输控件（SMTC）」。
// Node 不能直接调这个接口，所以起一个常驻的 PowerShell 小助手（smtc-helper.ps1，系统自带，不用装东西），
// 它每 250ms 输出一行 JSON，这里再整理成和 music.js 一样的 'state'。
//
// 和 Apple Music / 网易云模式的差别：
//   - 拿不到歌曲 ID，只有歌名 / 歌手 / 专辑 / 时长：歌词靠搜索匹配
//   - 进度每秒报 3～4 次，带时间戳，中间按时间往前推；切歌后新进度要晚 1 秒左右才到
//   - 播放 / 暂停 / 上一首 / 下一首走系统媒体接口。拖动进度不行（QQ 音乐不理会系统媒体接口的跳转请求），
//     改用 QQ 音乐自己的命令行：再运行一次 QQMusic.exe /seekto 秒数，它会把命令转给正在运行的那个。只能跳到整秒
//   - 没有资料库和播放列表，在 QQ 音乐里选歌
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { ROOT, dataPath, safeName } from './store.js';

export const NAME = 'QQ 音乐';
export const caps = { library: false, queue: false, seek: /^qqmusic\.exe$/i.test(process.env.UTA_SMTC_APP || 'QQMusic.exe') };
export const prefer = 'qq'; // 歌词优先用这个来源的（正在放的就是它家的歌）

const APP = process.env.UTA_SMTC_APP || 'QQMusic.exe';
const HELPER = path.join(ROOT, 'server', 'smtc-helper.ps1');

export const player = new EventEmitter();
player.state = { running: false };

let helper = null, stopped = true, waitTimer = null;
const replies = []; // 等着小助手回话的命令：[{ cmd, resolve }]

// ---------- 把 SMTC 的原始数据整理成进度 ----------
// cur：当前这首（按歌名 + 歌手 + 专辑认）；anchor：最近一次可信的进度和它的时间戳
let cur = { key: '', pid: '', at: 0 };
let anchor = null;
let regress = 0; // 连着几次「往回跳了一点」
let lastState = 'paused';
let exePath = ''; // 正在运行的 QQMusic.exe 在哪（小助手报上来的），跳转进度要用
let seekedAt = 0; // 刚让它跳过进度：接下来 2 秒里的进度不当成毛刺过滤（往回跳一点是正常的，只能跳到整秒）
let playSince = 0; // 这一段是从什么时候开始播的（暂停后再播，进度要从这时起算，不能从暂停前的时间戳起算）
let lastTrackState = null; // 上一次报出去的、带着歌曲的状态

function onLine(o) {
  if ('reply' in o) { const i = replies.findIndex((r) => r.cmd === o.reply); if (i >= 0) replies.splice(i, 1)[0].resolve(o); return; }
  clearTimeout(waitTimer);
  const now = Date.now();
  if ('exe' in o) exePath = o.exe || '';
  if (!o.running) {
    cur = { key: '', pid: '', at: 0 }; anchor = null;
    // QQ 音乐开着却没有会话：多半是没打开「显示系统媒体传输控件」，或者版本太旧
    return emit(o.proc ? { running: true, errno: 'smtc-no-session', err: o.err } : { running: false, err: o.err });
  }
  const key = `${o.title}|${o.artist}|${o.album}`;
  if (key !== cur.key) {
    // 第一次看到（本程序刚启动）：系统里现成的进度就是这首的，时间戳再早也算数（at 记 0）
    cur = { key, pid: `q-${crypto.createHash('sha1').update(key).digest('hex').slice(0, 16)}`, at: cur.key ? now : 0, duration: 0 };
    anchor = null; regress = 0;
  }
  // Changing（正在切歌）等过渡状态沿用上一个状态
  const state = o.status === 'Playing' ? 'playing' : o.status === 'Changing' ? lastState : 'paused';
  if (state === 'playing' && lastState !== 'playing') playSince = now;
  lastState = state;
  if (!o.title) return emit({ running: true, state: 'stopped' });

  // 时间戳比切歌还早的进度是上一首留下的（新歌名先到，新进度晚 1 秒左右才到）：不用
  if (o.stamp > 0 && o.stamp >= cur.at - 300) {
    const next = { pos: o.pos, at: o.stamp };
    if (!anchor || next.at !== anchor.at || next.pos !== anchor.pos) {
      // 偶尔会往回跳 0.25～2 秒的毛刺：只来一次的丢掉，连着来两次就认（真的卡了一下）
      const expect = anchor && state === 'playing' ? anchor.pos + (next.at - anchor.at) / 1000 : null;
      const back = expect === null ? 0 : expect - next.pos;
      // 刚让它跳过进度（2 秒内）：QQ 音乐真的跳过去之前，还会带着新时间戳报一两次跳之前的位置，离目标远的不认；
      // 离得近的都认（只能跳到整秒，比目标早一点是正常的，不算毛刺）
      if (now - seekedAt < 2000) { if (Math.abs(back) < 3) { anchor = next; regress = 0; } }
      else if (back > 0.25 && back < 2 && ++regress < 2) { /* 丢掉这一次 */ } else { anchor = next; regress = 0; }
    }
    if (o.end > 0) cur.duration = o.end;
  }
  // 刚切歌，新歌的进度和时长还没到（一般晚 1 秒左右）：先照旧报上一首，等到了再换。
  // 不然界面拿着「时长 0」去找歌词，少了一个最管用的匹配条件。最多等 1.5 秒
  if (!anchor && cur.at && now - cur.at < 1500 && lastTrackState && lastTrackState.pid !== cur.pid) return emit({ ...lastTrackState, state });
  let pos;
  if (anchor) pos = state === 'playing' ? anchor.pos + Math.min(2.5, Math.max(0, (now - Math.max(anchor.at, playSince)) / 1000)) : anchor.pos;
  else pos = state === 'playing' ? Math.min(3, (now - cur.at) / 1000) : 0; // 进度一直没到：先当作从头开始
  if (cur.duration) pos = Math.min(pos, cur.duration);
  emit(lastTrackState = {
    running: true, state, pid: cur.pid, pos,
    track: { pid: cur.pid, name: o.title, artist: o.artist.replace(/\//g, ' / '), album: o.album, duration: cur.duration || 0, prefer },
  });
}
function emit(s) {
  s.ts = Date.now();
  player.state = s;
  player.emit('state', s);
}

// ---------- 小助手进程 ----------
function armWaitTimer() {
  clearTimeout(waitTimer);
  waitTimer = setTimeout(() => emit({ running: false, waiting: true }), 5000);
  waitTimer.unref();
}
export function startWatcher() {
  if (helper) return;
  stopped = false;
  helper = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', HELPER, '-Prefer', APP], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
  armWaitTimer();
  let buf = '', errText = '';
  helper.stdout.setEncoding('utf8');
  helper.stdout.on('data', (chunk) => {
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      try { onLine(JSON.parse(line)); } catch { /* 半行，忽略 */ }
    }
  });
  helper.stderr.on('data', (c) => { errText = (errText + c).slice(-500); });
  helper.on('error', (e) => { errText = e.message; });
  helper.on('exit', () => {
    helper = null;
    clearTimeout(waitTimer);
    for (const r of replies.splice(0)) r.resolve({ ok: false });
    if (stopped) return;
    emit({ running: false, err: errText.trim() || 'smtc helper exited' });
    setTimeout(() => { if (!stopped) startWatcher(); }, 3000).unref();
  });
}
export function stopWatcher() {
  stopped = true;
  clearTimeout(waitTimer);
  if (helper) { try { helper.stdin.end(); } catch {} helper.kill(); helper = null; } // 小助手发现输入关了也会自己退出
}
function send(cmd, arg = '') {
  return new Promise((resolve) => {
    if (!helper) return resolve({ ok: false });
    const entry = { cmd, resolve };
    replies.push(entry);
    helper.stdin.write(`${cmd}${arg ? ` ${arg}` : ''}\n`);
    setTimeout(() => { const i = replies.indexOf(entry); if (i >= 0) { replies.splice(i, 1); resolve({ ok: false, err: 'timeout' }); } }, 5000).unref();
  });
}

// ---------- 播放控制 ----------
export async function control(cmd, a = '') {
  if (cmd === 'volume') return 'ok'; // 音量交给 QQ 音乐自己
  if (cmd === 'seek') return seek(a);
  if (!['play', 'pause', 'playpause', 'next', 'prev'].includes(cmd)) throw new Error(`${NAME}模式不支持：${cmd}`);
  const r = await send(cmd);
  if (!r.ok) throw new Error(r.err || `${NAME}没有接受这个操作`);
  return 'ok';
}

// 跳到某一秒：QQ 音乐自己的命令行 /seekto（它会把命令转给已经在运行的那个，自己马上退出）。
// 只能到整秒，往前取整：宁可早一点点，不要把那一句的开头切掉
function seek(sec) {
  if (!caps.seek) return Promise.reject(new Error(`${NAME}不支持从外面拖动进度，请在${NAME}里拖`));
  if (!exePath || !player.state.track) return Promise.reject(new Error(`${NAME}没有在播放`));
  const to = Math.max(0, Math.floor(Number(sec) || 0));
  return new Promise((resolve, reject) => {
    execFile(exePath, ['/seekto', String(to)], { timeout: 10000, windowsHide: true }, (err) => {
      if (err) return reject(new Error(`${NAME}没有接受跳转：${err.message}`));
      // 不等它下一次报进度：先按跳到的位置算，界面不会先跳回原处再跳过去
      seekedAt = Date.now();
      anchor = { pos: to, at: seekedAt };
      if (lastTrackState) emit(lastTrackState = { ...lastTrackState, pos: to }); // 马上报一次，不等小助手的下一行
      resolve('ok');
    });
  });
}

// ---------- 资料库：这个模式下不支持 ----------
export async function getLibrary() { return []; }
export async function getPlaylists() { return []; }

// ---------- 封面：让小助手把系统媒体接口里的那张缩略图存下来 ----------
export async function getArtwork(pid) {
  const file = dataPath('artwork', `${safeName(pid)}.img`);
  const ok = () => fs.existsSync(file) && fs.statSync(file).size > 0;
  if (!ok()) {
    if (pid !== cur.pid) return null; // 只取得到正在放的这首
    await send('art', file);
    if (!ok() || pid !== cur.pid) { try { fs.unlinkSync(file); } catch {} return null; }
  }
  const head = Buffer.alloc(4);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  return { file, type: head[0] === 0x89 && head[1] === 0x50 ? 'image/png' : 'image/jpeg' };
}
export const getThumb = getArtwork;
