// Apple Music（Music.app）桥接：通过 osascript / JXA 读取资料库、控制播放、读取播放进度。
import { spawn, execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import { dataPath, safeName } from './store.js';

function osa(args, timeout = 20000) {
  return new Promise((resolve, reject) => {
    execFile('osascript', args, { timeout, maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) reject(new Error((stderr || err.message).trim()));
      else resolve(stdout.trim());
    });
  });
}
const jxa = (script, ...argv) => osa(['-l', 'JavaScript', '-e', script, ...argv.map(String)]);

// ---------- 播放状态监听：一个常驻的 JXA 进程，每 250ms 输出一行 JSON ----------
const WATCHER = `
ObjC.import('Foundation');
function run() {
  const m = Application('Music');
  const out = $.NSFileHandle.fileHandleWithStandardOutput;
  let lastPid = null, tick = 0;
  while (true) {
    const s = { running: false };
    try {
      if (m.running()) {
        s.running = true;
        s.state = m.playerState();
        s.vol = m.soundVolume();
        if (s.state !== 'stopped') {
          const t = m.currentTrack;
          s.pid = t.persistentID();
          s.pos = m.playerPosition();
          if (s.pid !== lastPid || tick % 20 === 0) {
            s.track = { pid: s.pid, name: t.name(), artist: t.artist(), album: t.album(), duration: t.duration() };
            lastPid = s.pid;
          }
        } else { lastPid = null; }
      }
    } catch (e) { s.err = String(e); }
    s.ts = Date.now();
    out.writeData($(JSON.stringify(s) + '\\n').dataUsingEncoding($.NSUTF8StringEncoding));
    tick++;
    delay(0.25);
  }
}`;

export const player = new EventEmitter();
player.state = { running: false };
let lastTrack = null;
let watcher = null;

let waitTimer = null;
// 几秒内没有任何输出：多半是系统的「想要控制 Music」授权框还没点，或 Music 暂时无响应
function armWaitTimer() {
  clearTimeout(waitTimer);
  waitTimer = setTimeout(() => {
    player.state = { running: false, waiting: true, ts: Date.now() };
    player.emit('state', player.state);
  }, 4000);
  waitTimer.unref();
}

export function startWatcher() {
  if (watcher) return;
  watcher = spawn('osascript', ['-l', 'JavaScript', '-e', WATCHER], { stdio: ['ignore', 'pipe', 'pipe'] });
  armWaitTimer();
  let buf = '';
  watcher.stdout.on('data', (chunk) => {
    armWaitTimer();
    buf += chunk;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      try {
        const s = JSON.parse(line);
        if (s.track) lastTrack = s.track;
        if (s.pid && lastTrack && lastTrack.pid === s.pid) s.track = lastTrack;
        if (!s.pid) lastTrack = null;
        player.state = s;
        player.emit('state', s);
      } catch { /* 半行，忽略 */ }
    }
  });
  let errText = '';
  watcher.stderr.on('data', (c) => { errText = (errText + c).slice(-500); });
  watcher.on('exit', () => {
    watcher = null;
    clearTimeout(waitTimer);
    player.state = { running: false, err: errText.trim() || 'watcher exited' };
    player.emit('state', player.state);
    setTimeout(startWatcher, 3000); // Music 退出或授权未给时，稍后重试
  });
}
export function stopWatcher() {
  clearTimeout(waitTimer);
  if (watcher) { watcher.removeAllListeners('exit'); watcher.kill(); watcher = null; }
}

// ---------- 播放控制 ----------
const CONTROL = `
function run(argv) {
  const m = Application('Music');
  const cmd = argv[0], a = argv[1], b = argv[2];
  switch (cmd) {
    case 'playpause': m.playpause(); break;
    case 'play': m.play(); break;
    case 'pause': m.pause(); break;
    case 'next': m.nextTrack(); break;
    case 'prev': m.backTrack(); break;
    case 'seek': m.playerPosition = Number(a); break;
    case 'volume': m.soundVolume = Number(a); break;
    case 'playTrack': {
      const src = b ? m.userPlaylists.whose({ persistentID: b })[0] : m.libraryPlaylists[0];
      src.tracks.whose({ persistentID: a })[0].play();
      break;
    }
    default: throw new Error('unknown command ' + cmd);
  }
  return 'ok';
}`;
export const control = (cmd, a = '', b = '') => jxa(CONTROL, cmd, a, b);

// ---------- 资料库 ----------
const LIBRARY = `
function run(argv) {
  const m = Application('Music');
  const src = argv[0] ? m.userPlaylists.whose({ persistentID: argv[0] })[0] : m.libraryPlaylists[0];
  const t = src.tracks;
  let added = [];
  try { added = t.dateAdded().map(d => d ? +d : 0); } catch (e) {}
  return JSON.stringify({ n: t.name(), ar: t.artist(), al: t.album(), d: t.duration(), p: t.persistentID(), a: added });
}`;
const libCache = new Map();
export async function getLibrary(playlist = '', refresh = false) {
  const hit = libCache.get(playlist);
  if (hit && !refresh && Date.now() - hit.at < 10 * 60 * 1000) return hit.tracks;
  const raw = JSON.parse(await jxa(LIBRARY, playlist));
  const tracks = raw.p.map((pid, i) => ({
    pid, name: raw.n[i] || '', artist: raw.ar[i] || '', album: raw.al[i] || '',
    duration: raw.d[i] || 0, added: raw.a[i] || 0,
  }));
  libCache.set(playlist, { at: Date.now(), tracks });
  return tracks;
}

const PLAYLISTS = `
function run() {
  const m = Application('Music');
  const p = m.userPlaylists;
  const names = p.name(), ids = p.persistentID();
  let kinds = [];
  try { kinds = p.specialKind(); } catch (e) {}
  return JSON.stringify(names.map((n, i) => ({ name: n, pid: ids[i], kind: kinds[i] || 'none' })));
}`;
export async function getPlaylists() {
  const all = JSON.parse(await jxa(PLAYLISTS));
  return all.filter((p) => p.kind === 'none');
}

// ---------- 封面 ----------
// 返回 { file, type }，没有封面时返回 null
export async function getArtwork(pid, isCurrent) {
  const file = dataPath('artwork', `${safeName(pid)}.img`);
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) {
    const target = isCurrent
      ? 'current track'
      : `(first track of library playlist 1 whose persistent ID is "${safeName(pid)}")`;
    const script = `
tell application "Music"
  set t to ${target}
  if (count of artworks of t) is 0 then return "none"
  set d to raw data of artwork 1 of t
end tell
set f to open for access POSIX file "${file.replace(/"/g, '\\"')}" with write permission
set eof f to 0
write d to f
close access f
return "ok"`;
    try {
      const r = await osa(['-e', script]);
      if (r !== 'ok') return null;
    } catch {
      try { fs.unlinkSync(file); } catch {}
      return null;
    }
  }
  const head = Buffer.alloc(4);
  const fd = fs.openSync(file, 'r');
  fs.readSync(fd, head, 0, 4, 0);
  fs.closeSync(fd);
  const type = head[0] === 0x89 && head[1] === 0x50 ? 'image/png' : 'image/jpeg';
  return { file, type };
}
