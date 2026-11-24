// 自动模式：同时盯着 Apple Music 和网易云音乐，哪个在播就跟哪个。
// 接口和 music.js / netease.js 一样，index.js 不用分辨。
//   - 只有一个在播：跟它
//   - 两个都在播：跟后开始播的那个（比如网易云还开着，又在 Apple Music 里点了一首）
//   - 都没在播：停在刚才跟着的那个（暂停时歌词还留在那首歌上）；它连歌都没有了，就看另一个有没有
// 网易云没开时不替用户打开（只用网易云的模式才会）
import { EventEmitter } from 'node:events';
import * as apple from './music.js';
import * as netease from './netease.js';

export const NAME = 'Apple Music / 网易云音乐';
export const caps = { library: true, queue: true }; // 资料库、播放队列都是 Apple Music 的

const SRC = { apple, netease };
const last = { apple: { running: false }, netease: { running: false } };
const startedAt = { apple: 0, netease: 0 }; // 最近一次「开始播放」的时刻
let active = 'apple';

export const player = new EventEmitter();
player.state = { running: false };

const playing = (k) => last[k].state === 'playing' && !!last[k].track;
function pick() {
  const a = playing('apple'), n = playing('netease');
  if (a && n) return startedAt.apple >= startedAt.netease ? 'apple' : 'netease';
  if (a) return 'apple';
  if (n) return 'netease';
  if (last[active].track) return active;
  const other = active === 'apple' ? 'netease' : 'apple';
  if (last[other].track) return other;
  // 网易云开着但读不到（不是由本程序打开的）：跟着它，界面上会出「重新打开网易云」的按钮
  if (last.netease.errno === 'netease-no-port' && !last.apple.running) return 'netease';
  return last.apple.running || !last.netease.running ? 'apple' : 'netease';
}

function onState(k, s) {
  if (s.state === 'playing' && last[k].state !== 'playing') startedAt[k] = Date.now();
  last[k] = s;
  const next = pick();
  // 只转发正在跟着的那个的状态（两边各自每 250ms 报一次，不跟着的那边不用转）；换了来源时立刻转一次
  if (next !== k && next === active) return;
  active = next;
  player.state = { ...last[active], source: active };
  player.emit('state', player.state);
}
apple.player.on('state', (s) => onState('apple', s));
netease.player.on('state', (s) => onState('netease', s));

export function startWatcher() {
  apple.startWatcher();
  netease.startWatcher({ launch: false });
}
export function stopWatcher() {
  apple.stopWatcher();
  netease.stopWatcher();
}

export async function control(cmd, a = '', b = '') {
  if (cmd === 'relaunch') return netease.control(cmd, a);
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
