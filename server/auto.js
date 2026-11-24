// 自动模式：同时盯着 Apple Music 和网易云音乐。
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
import * as apple from './music.js';
import * as netease from './netease.js';

export const NAME = 'Apple Music / 网易云音乐';
export const caps = { library: true, queue: true }; // 资料库、播放队列都是 Apple Music 的

const SRC = { apple, netease };
const last = { apple: { running: false }, netease: { running: false } };
const startedAt = { apple: 0, netease: 0 }; // 这一轮播放是什么时候开始的
const stoppedAt = { apple: 0, netease: 0 };
// 用户答过「留在这儿」的那一轮（记的是那一轮的 startedAt）：同一轮里不再问
const declined = { apple: 0, netease: 0 };
const SAME_RUN = 3000; // 停了不到这么久又接着播（换歌、缓冲时会闪一下），算同一轮，不重新问
const BOOT = 3000;
// 跟着的这个刚停下（不是暂停）不到这么久：可能只是在换歌（一首播完到下一首响起来之间会停一下），先不急着换到另一个
const GAP = 2000;
// 跟着的这个连程序都关了，过这么久还没回来：另一个要是有歌（哪怕暂停着）就换过去。
// 等一等是因为网易云那边连接偶尔会断一下再连上，那不算关了
const GONE = 3000;
let active = 'apple';
let had = false; // 跟着的这个播放器有过歌（「用过它」）。一次都没有过的话，另一个有歌就直接跟另一个，比如刚启动时
const goneAt = { apple: 0, netease: 0 }; // 从什么时候起读不到这个播放器了（0 = 读得到）
let bootAt = Date.now();
let offerKey = '';

export const player = new EventEmitter();
player.state = { running: false };

const playing = (k) => last[k].state === 'playing' && !!last[k].track;
const otherOf = (k) => (k === 'apple' ? 'netease' : 'apple');
const booting = () => Date.now() - bootAt < BOOT;
function pick() {
  if (booting()) {
    const a = playing('apple'), n = playing('netease');
    if (a && n) return startedAt.apple >= startedAt.netease ? 'apple' : 'netease';
    if (a) return 'apple';
    if (n) return 'netease';
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
  // 网易云开着但读不到（不是由本程序打开的）：跟着它，界面上会出「重新打开网易云」的按钮
  if (last.netease.errno === 'netease-no-port' && !last.apple.running) return 'netease';
  return last.apple.running || !last.netease.running ? 'apple' : 'netease';
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
  player.state = { ...last[active], source: active, ...(offer && { offer }) };
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
apple.player.on('state', (s) => onState('apple', s));
netease.player.on('state', (s) => onState('netease', s));

export function startWatcher() {
  bootAt = Date.now();
  apple.startWatcher();
  netease.startWatcher({ launch: false });
}
export function stopWatcher() {
  apple.stopWatcher();
  netease.stopWatcher();
}

export async function control(cmd, a = '', b = '') {
  if (cmd === 'relaunch') return netease.control(cmd, a);
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
  if (cmd === 'stay') {
    const o = otherOf(active);
    declined[o] = startedAt[o];
    return publish();
  }
  // 从资料库点歌：是 Apple Music 播；网易云要是正在放，先让它停下，免得两边一起响
  if (cmd === 'playTrack') {
    if (playing('netease')) await netease.control('pause').catch(() => {});
    return apple.control(cmd, a, b);
  }
  return SRC[active].control(cmd, a, b);
}

export const getLibrary = (...args) => apple.getLibrary(...args);
export const getPlaylists = () => apple.getPlaylists();
// 封面：网易云的歌编号以 ne- 开头
export const getArtwork = (pid, isCurrent) => (String(pid).startsWith('ne-') ? netease.getArtwork(pid) : apple.getArtwork(pid, isCurrent));
export const getThumb = (pid) => (String(pid).startsWith('ne-') ? netease.getThumb(pid) : apple.getThumb(pid));
