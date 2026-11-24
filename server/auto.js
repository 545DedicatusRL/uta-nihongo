// 自动模式：同时盯着 Apple Music 和网易云音乐。
// 接口和 music.js / netease.js 一样，index.js 不用分辨。
//   - 界面上已经有一首歌了（在播或暂停着）：留在它那儿。另一个播放器开始播放时不自己换过去，
//     而是在状态里带上 offer，界面弹窗问用户「换过去」还是「留在这儿」（control 的 follow / stay）
//   - 跟着的那个连歌都没有了（没开、关掉了）：另一个有歌就直接跟它，这时没什么可问的
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
let active = 'apple';
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
  if (last[active].track) return active;
  const other = otherOf(active);
  if (last[other].track) return other;
  // 网易云开着但读不到（不是由本程序打开的）：跟着它，界面上会出「重新打开网易云」的按钮
  if (last.netease.errno === 'netease-no-port' && !last.apple.running) return 'netease';
  return last.apple.running || !last.netease.running ? 'apple' : 'netease';
}

// 另一个播放器正在播、这一轮还没问过：要问用户的那一条
function offerNow() {
  const o = otherOf(active);
  if (booting() || !playing(o) || declined[o] === startedAt[o]) return null;
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
  last[k] = s;
  const next = pick();
  // 只转发正在跟着的那个的状态（两边各自每 250ms 报一次，不跟着的那边不用转）；
  // 换了来源、或者要问的那一条变了（出现、撤回、换了歌）时立刻转一次
  if (next !== k && next === active) {
    const o = offerNow();
    if ((o ? `${o.source}|${o.at}|${o.pid}` : '') === offerKey) return;
  }
  active = next;
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
