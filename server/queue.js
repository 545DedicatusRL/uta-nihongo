// 内置播放队列。
// Apple Music 这边每次只让它播一首；一首播完（播放状态从「播放中、接近结尾」变成「已停止」）时，
// 由这里接着播队列里的下一首。队列的内容由界面给出（资料库里当前筛选出来的列表，「仅日文」等
// 筛选都是本程序自己的逻辑，Apple Music 不知道），所以顺序 / 随机 / 循环也都在这里决定。
// 队列只是一串歌曲编号，换歌时才动一下，资料库再大也没有什么负担。

const shuffled = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// player：播放状态的事件源（每 250ms 一次 'state'）；play(pid) / seek(sec)：控制 Apple Music；
// load() / save(obj)：把队列存到磁盘，程序重启（比如更新）后能接着播
export function createQueue({ player, play, seek, load = () => null, save = () => {} }) {
  const q = { items: [], order: [], at: -1, shuffle: false, repeat: false, label: '', active: false };
  const saved = load();
  if (saved && Array.isArray(saved.items) && Array.isArray(saved.order)) Object.assign(q, saved);

  const cur = () => q.items[q.order[q.at]] || null;
  let saveTimer = null;
  const persist = () => {
    clearTimeout(saveTimer);
    saveTimer = setTimeout(() => save({ ...q }), 400);
    saveTimer.unref?.();
  };

  let pendingUntil = 0; // 刚让 Apple Music 换歌：在它真的切过去之前，别把旧状态当成新变化
  let fails = 0;
  let last = null;
  // 当前这首最近一次的有效进度。一首歌结束前后 Apple Music 报的状态偶尔会抖一下（进度变 0 等），
  // 所以判断「是不是播完了」不只看停下前那一拍，而是看：刚刚（3 秒内）还在播，而且已经播到结尾附近
  let seen = { pid: '', pos: 0, dur: 0, at: 0 };

  // 往前 / 往后走一步；走不动（到头且没开循环）时返回 false
  function step(d, wrap = q.repeat) {
    let n = q.at + d;
    if (n >= q.order.length) {
      if (!wrap || !q.order.length) return false;
      if (q.shuffle) q.order = shuffled(q.order); // 新的一轮重新洗牌
      n = 0;
    } else if (n < 0) {
      if (!wrap) return false;
      n = q.order.length - 1;
    }
    q.at = n;
    return true;
  }
  async function start() {
    const t = cur();
    if (!t) return false;
    pendingUntil = Date.now() + 4000;
    persist();
    try {
      await play(t.pid);
      return true;
    } catch {
      // 这首播不了（比如已经从资料库里移除）：换下一首，连续几首都不行就停下
      if (++fails >= 5 || !step(1)) { q.active = false; pendingUntil = 0; persist(); return false; }
      return start();
    }
  }
  function advance() {
    if (step(1)) start();
    else { q.active = false; persist(); } // 列表播完了
  }

  player.on('state', (s) => {
    const prev = last;
    last = s;
    if (s.state === 'playing' && s.pid && s.pos >= 1) seen = { pid: s.pid, pos: s.pos, dur: s.track?.duration || 0, at: Date.now() };
    const t = cur();
    if (!q.active || !t) return;
    if (pendingUntil) {
      if (s.pid === t.pid) { pendingUntil = 0; fails = 0; return; }
      if (Date.now() < pendingUntil) return;
      pendingUntil = 0;
      if (s.running && s.state === 'stopped') {
        // 让它播了，几秒过去还是没播起来（资料库里有些条目播不了，Apple Music 也不报错）：跳过这首
        if (++fails >= 5 || !step(1)) { q.active = false; persist(); } else start();
        return;
      }
    }
    if (!s.running) return;
    const dur = seen.dur || t.duration || 0;
    const nearEnd = seen.pid === t.pid && dur > 0 && seen.pos >= dur - 4 && Date.now() - seen.at < 3000;
    if (s.state === 'stopped') {
      if (nearEnd) advance(); // 这首自然播完了
      return;
    }
    if (s.pid && s.pid !== t.pid) {
      if (nearEnd) return advance(); // 播完后 Apple Music 自己接了别的歌（比如开着自动播放）：换回队列里的下一首
      // 用户在 Apple Music 里自己换了歌：在队列里就跟过去，不在就不再接管
      const k = q.order.findIndex((i) => q.items[i].pid === s.pid);
      if (k >= 0) q.at = k; else q.active = false;
      persist();
    }
  });

  const summary = () => {
    const t = cur();
    const n = q.items[q.order[q.at + 1 < q.order.length ? q.at + 1 : (q.repeat && !q.shuffle ? 0 : -1)]];
    return {
      active: q.active, total: q.order.length, at: q.at, shuffle: q.shuffle, repeat: q.repeat, label: q.label,
      pid: t?.pid || '', next: n ? { name: n.name, artist: n.artist } : null,
    };
  };

  return {
    summary,
    active: () => q.active && !!cur(),
    // 从当前这首开始往后的 n 首（界面的播放列表用）
    view: (n = 150) => ({ ...summary(), list: q.order.slice(Math.max(q.at, 0), Math.max(q.at, 0) + n).map((i) => q.items[i]) }),

    // 换一份列表并从 start 这首开始播。items: [[pid, 歌名, 歌手, 时长], …]，顺序就是列表顺序
    playList({ items, start: startPid, label = '', shuffle }) {
      const list = (Array.isArray(items) ? items : []).filter((x) => Array.isArray(x) && x[0])
        .map(([pid, name, artist, duration]) => ({ pid: String(pid), name: String(name || ''), artist: String(artist || ''), duration: Number(duration) || 0 }));
      if (!list.length) return false;
      if (typeof shuffle === 'boolean') q.shuffle = shuffle;
      q.items = list;
      q.label = String(label);
      const ids = list.map((_, i) => i);
      let first = list.findIndex((t) => t.pid === startPid);
      if (first < 0) first = q.shuffle ? Math.floor(Math.random() * list.length) : 0;
      if (q.shuffle) { q.order = [first, ...shuffled(ids.filter((i) => i !== first))]; q.at = 0; }
      else { q.order = ids; q.at = first; }
      q.active = true;
      fails = 0;
      return start();
    },
    next() { fails = 0; return step(1) ? start() : false; },
    // 已经播了几秒：回到这首的开头；刚开始：上一首
    prev(pos = 0) {
      if (pos > 3 || !step(-1)) { pendingUntil = 0; return seek(0); }
      return start();
    },
    jump(pid) {
      const k = q.order.findIndex((i) => q.items[i].pid === pid);
      if (k < 0) return false;
      q.at = k;
      q.active = true;
      fails = 0;
      return start();
    },
    // 开：当前这首留在最前，其余洗牌；关：回到列表原来的顺序，从当前这首继续
    setShuffle(on) {
      q.shuffle = !!on;
      const c = q.order[q.at];
      const ids = q.items.map((_, i) => i);
      if (q.shuffle) {
        q.order = c === undefined ? shuffled(ids) : [c, ...shuffled(ids.filter((i) => i !== c))];
        if (c !== undefined) q.at = 0;
      } else {
        q.order = ids;
        if (c !== undefined) q.at = c;
      }
      persist();
    },
    setRepeat(on) { q.repeat = !!on; persist(); },
  };
}
