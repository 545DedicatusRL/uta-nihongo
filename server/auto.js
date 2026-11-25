// 自动模式：同时盯着两个播放器。macOS 上是 Apple Music 和网易云音乐（Mac 客户端），
// Windows 上是网易云音乐（Windows 客户端）和 QQ 音乐。
// 接口和 music.js / netease.js 一样，index.js 不用分辨。
// 界面跟着其中一个（active）。要不要换到另一个，只看「另一个是不是真的在播」：
//   - 另一个没在播（只是开着、暂停着一首歌）：不换。跟着的这个一首歌播完了、正在换下一首的那一会儿
//     也留在它这儿，不会跳到后台那个暂停着的播放器上再跳回来
//   - 另一个在播，跟着的这个没在播（暂停着，或者根本没有歌）：直接换过去，不问。
//     用户自己去另一个播放器点了播放，意思已经很明白了
//   - 两个都在播：不自己换，在状态里带上 offer，界面弹窗问用户「换过去」还是「留在这儿」
//     （control 的 follow / stay）
//   - 刚启动的头几秒不问：两边的状态是先后报上来的，这时哪个在播就跟哪个
// 网易云没开时不替用户打开（只用网易云的模式才会）
import { EventEmitter } from 'node:events';

// 两个播放器。排在前面的（A）是「没有别的线索时跟它」的那个；资料库、播放队列也是它的（只有 Apple Music 有）
const MAC = process.platform === 'darwin';
const SRC = MAC
  ? { apple: await import('./music.js'), netease: await import('./netease.js') }
  : { netease: await import('./netease-win.js'), qq: await import('./smtc.js') };
const KEYS = Object.keys(SRC);
const [A, B] = KEYS;
const each = (make) => Object.fromEntries(KEYS.map((k) => [k, make(k)]));

export const NAME = KEYS.map((k) => SRC[k].NAME).join(' / ');
// 资料库、播放队列都是 Apple Music 的；能不能拖动进度要看当前跟着的是哪个（状态里的 seek）
export const caps = { library: !!SRC.apple, queue: !!SRC.apple, seek: true };

const last = each(() => ({ running: false }));
const startedAt = each(() => 0); // 这一轮播放是什么时候开始的
const stoppedAt = each(() => 0);
// 用户答过「留在这儿」的那一轮（记的是那一轮的 startedAt）：同一轮里不再问
const declined = each(() => 0);
const SAME_RUN = 3000; // 停了不到这么久又接着播（换歌、缓冲时会闪一下），算同一轮，不重新问
const BOOT = 3000;
// 跟着的这个刚停下（不是暂停）不到这么久：可能只是在换歌（一首播完到下一首响起来之间会停一下），先不急着换到另一个
const GAP = 2000;
// 跟着的这个连程序都关了，过这么久还没回来：另一个要是有歌（哪怕暂停着）就换过去。
// 等一等是因为网易云那边连接偶尔会断一下再连上，那不算关了
const GONE = 3000;
let active = A;
let had = false; // 跟着的这个播放器有过歌（「用过它」）。一次都没有过的话，另一个有歌就直接跟另一个，比如刚启动时
const goneAt = each(() => 0); // 从什么时候起读不到这个播放器了（0 = 读得到）
let bootAt = Date.now();
let offerKey = '';

export const player = new EventEmitter();
player.state = { running: false };

const playing = (k) => last[k].state === 'playing' && !!last[k].track;
const otherOf = (k) => (k === A ? B : A);
const booting = () => Date.now() - bootAt < BOOT;
// 一首歌的编号是哪个播放器的：网易云的以 ne- / nel- 开头，QQ 音乐的以 q- 开头，其余是 Apple Music 的
const srcOf = (pid) => (/^nel?-/.test(String(pid)) ? 'netease' : String(pid).startsWith('q-') ? 'qq' : 'apple');
function pick() {
  if (booting()) {
    const a = playing(A), b = playing(B);
    if (a && b) return startedAt[A] >= startedAt[B] ? A : B;
    if (a) return A;
    if (b) return B;
  }
  const other = otherOf(active);
  if (playing(other) && !playing(active)) {
    // 暂停是用户自己按的，不用等；其余的「没在播」（一首播完、停止）可能只是换歌的间隙，等过了 GAP 再换
    return last[active].state === 'paused' || Date.now() - stoppedAt[active] > GAP ? other : active;
  }
  if (last[active].track) return active;
  // 跟着的这个现在没有歌，另一个也没在播
  if (last[other].track && (!had || (goneAt[active] && Date.now() - goneAt[active] > GONE))) return other;
  if (had) return active;
  // 网易云开着但读不到（不是由本程序打开的），另一个也没开：跟着它，界面上会出「重新打开网易云」的按钮
  const noPort = KEYS.find((k) => last[k].errno === 'netease-no-port');
  if (noPort && !last[otherOf(noPort)].running) return noPort;
  return last[A].running || !last[B].running ? A : B;
}

// 两个都在播、另一个的这一轮还没问过：要问用户的那一条
function offerNow() {
  const o = otherOf(active);
  if (booting() || !playing(o) || !playing(active) || declined[o] === startedAt[o]) return null;
  const t = last[o].track;
  return { source: o, at: startedAt[o], pid: t.pid, name: t.name || '', artist: t.artist || '' };
}
function publish() {
  const offer = offerNow();
  offerKey = offer ? `${offer.source}|${offer.at}|${offer.pid}` : '';
  player.state = { ...last[active], source: active, seek: SRC[active].caps?.seek !== false, ...(offer && { offer }) };
  player.emit('state', player.state);
}

function onState(k, s) {
  const was = last[k].state === 'playing', now = s.state === 'playing';
  if (now && !was && Date.now() - stoppedAt[k] > SAME_RUN) startedAt[k] = Date.now();
  if (was && !now) stoppedAt[k] = Date.now();
  if (s.running) goneAt[k] = 0; else if (!goneAt[k]) goneAt[k] = Date.now();
  last[k] = s;
  if (last[active].track) had = true;
  const next = pick();
  // 只转发正在跟着的那个的状态（两边各自每 250ms 报一次，不跟着的那边不用转）；
  // 换了来源、或者要问的那一条变了（出现、撤回、换了歌）时立刻转一次
  if (next !== k && next === active) {
    const o = offerNow();
    if ((o ? `${o.source}|${o.at}|${o.pid}` : '') === offerKey) return;
  }
  if (next !== active) { active = next; had = !!last[active].track; }
  publish();
}
for (const k of KEYS) SRC[k].player.on('state', (s) => onState(k, s));

export function startWatcher() {
  bootAt = Date.now();
  for (const k of KEYS) SRC[k].startWatcher(k === 'netease' ? { launch: false } : undefined);
}
export function stopWatcher() {
  for (const k of KEYS) SRC[k].stopWatcher();
}

export async function control(cmd, a = '', b = '') {
  if (cmd === 'relaunch') return SRC.netease.control(cmd, a);
  // 弹窗里的两个选择。换过去：原来那个要是也在播，让它停下，免得两边一起响；
  // 它这一轮记成问过了，不然刚换过来又会反过来问一次
  if (cmd === 'follow') {
    if (!SRC[a] || a === active || !last[a].track) return;
    const old = active, both = playing(old) && playing(a);
    declined[old] = startedAt[old];
    active = a;
    had = true;
    publish();
    if (both) await SRC[old].control('pause').catch(() => {});
    return;
  }
  // 留在这儿：另一个既然不听，让它停下（会弹窗就是因为两边都在响）
  if (cmd === 'stay') {
    const o = otherOf(active), both = playing(o) && playing(active);
    declined[o] = startedAt[o];
    publish();
    if (both) await SRC[o].control('pause').catch(() => {});
    return;
  }
  // 指定播放某一首：资料库里点的是 Apple Music 的歌；词汇书的「听这句」两边的歌都有（看编号是谁家的）。
  // 另一个播放器要是正在放，先让它停下，免得两边一起响；没播成（比如网易云的播放列表里没有这首）再让它接着放
  if (cmd === 'playTrack') {
    const to = srcOf(a);
    if (!SRC[to]) throw new Error('这首歌所在的播放器现在用不了');
    const from = otherOf(to);
    const wasPlaying = playing(from);
    if (wasPlaying) await SRC[from].control('pause').catch(() => {});
    let r;
    try { r = await SRC[to].control(cmd, a, b); } catch (e) {
      if (wasPlaying) await SRC[from].control('play').catch(() => {});
      throw e;
    }
    // 界面马上跟到播这首歌的那个播放器，不等它的状态报上来：紧接着的「跳到这一句」才会发给对的那个
    // 原来那个这一轮记成问过了：它要是停得慢一点，不至于刚换过来又弹窗问要不要换回去
    declined[from] = startedAt[from];
    if (active !== to) { active = to; had = true; }
    publish();
    return r;
  }
  return SRC[active].control(cmd, a, b);
}

export const getLibrary = (...args) => (SRC.apple ? SRC.apple.getLibrary(...args) : []);
export const getPlaylists = () => (SRC.apple ? SRC.apple.getPlaylists() : []);
// 封面：按编号找是哪个播放器的歌
export const getArtwork = (pid, isCurrent) => (SRC[srcOf(pid)] || SRC[active]).getArtwork(pid, isCurrent);
export const getThumb = (pid) => (SRC[srcOf(pid)] || SRC[active]).getThumb(pid);
