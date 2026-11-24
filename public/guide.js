// 唱歌学日语 — 使用指引
// 第一次打开时放一遍：把界面压暗，逐个圈出按钮讲一句。看完或跳过后由调用方记下「看过了」，
// 之后只在设置里点「再看一遍」才出现。指引本身不碰任何数据，也不替用户点任何东西。
const noMotion = matchMedia('(prefers-reduced-motion: reduce)');
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const focusView = () => document.getElementById('app').classList.contains('view-focus');
const hasLyrics = () => !!document.querySelector('#scroll .line');
// 网易云 / QQ 音乐模式下没有资料库（按钮被藏起来了）；播放器的名字写在设置里的说明上
const noLibrary = () => !!document.getElementById('btn-library')?.hidden;
const playerName = () => document.querySelector('.player-name')?.textContent || 'Apple Music';

// el：要圈出来的东西（没有就是居中的一张卡）；up：圈它外面的那一组；big：一大块区域，卡片放在旁边而不是下面
const STEPS = [
  {
    welcome: true,
    title: '欢迎用「唱歌学日语」',
    text: () => `在 ${playerName()} 里放一首日文歌，这里就会跟着显示歌词：汉字上面有假名，下面有中文翻译，还会标出这一句里的语法点和生词。`,
  },
  {
    el: '#btn-library',
    title: '先挑一首歌',
    text: () => (noLibrary()
      ? `在<b>${playerName()}</b>里选歌播放，这里会自动跟上。`
      : '<b>资料库</b>里是你 Apple Music 里的歌，默认只列日文歌，也能按专辑和播放列表找。直接在 Apple Music 里点播放也一样。'),
  },
  {
    el: () => (focusView() ? '#focus' : '#lyrics'), big: true,
    title: '歌词跟着歌走',
    text: () => `${hasLyrics() ? '' : '放歌以后，歌词出现在这里。'}${focusView() ? '' : '点任意一句，歌就跳到那一句。'}句子下面的小标签是语法点和生词，鼠标停在上面能看到说明。`,
  },
  {
    el: '[data-view=apple]', up: '.group',
    title: '两种歌词样式',
    text: '<b>滚动</b>能看到前后几句；<b>大字</b>一次只放一句，适合跟着唱。',
  },
  {
    el: '#btn-dict', up: '.group',
    title: '把生词记下来',
    text: '打开<b>记词</b>，点歌词里的词，确认读音和释义后就进了词汇书。<b>词汇书</b>里可以搜索、用记忆模式自测，也能导出。',
  },
  {
    el: '#btn-edit',
    title: '标得不对，可以自己改',
    text: '读音标错了、某个标注不想看、多义词选的意思不对——进<b>修改</b>，直接点歌词改。改过的会一直记着。',
  },
  {
    el: '#btn-menu',
    title: '显示什么，你来定',
    text: '假名、中文翻译、罗马音、标注都能单独开关。歌词和歌对不上，或者配错了歌词，也在这里调。',
    note: '想再看一遍这份指引：设置 → 更多设置 → 使用指引。',
  },
];

let open = null; // 正在放的那一份；同一时间只放一份

export function startGuide(onClose) {
  if (open) return;
  const root = document.createElement('div');
  root.id = 'guide';
  root.innerHTML = `
    <div class="g-hole none"></div>
    <div class="g-card" role="dialog" aria-modal="true" aria-labelledby="g-title">
      <div class="g-body">
        <img class="g-icon" src="icon.png" alt="">
        <h2 id="g-title"></h2>
        <p class="g-text"></p>
        <p class="g-note"></p>
      </div>
      <div class="g-foot">
        <button class="g-skip">跳过</button>
        <span class="g-dots" aria-hidden="true">${STEPS.map(() => '<i></i>').join('')}</span>
        <button class="btn g-prev">上一步</button>
        <button class="btn primary g-next"></button>
      </div>
    </div>`;
  document.body.append(root);
  const q = (s) => root.querySelector(s);
  const hole = q('.g-hole'), card = q('.g-card'), body = q('.g-body');
  let at = 0;

  const targetOf = (step) => {
    const sel = typeof step.el === 'function' ? step.el() : step.el;
    const el = sel && document.querySelector(sel);
    return el && step.up ? el.closest(step.up) : el;
  };

  // 把洞和卡片摆到这一步该在的地方
  function place() {
    const step = STEPS[at];
    const r = targetOf(step)?.getBoundingClientRect();
    const ok = !!r && r.width > 0 && r.height > 0;
    const W = innerWidth, H = innerHeight;
    const pad = step.big ? -10 : 5; // 大块区域往里收一点，圈才整个留在窗口里
    const box = ok ? { x: r.left - pad, y: r.top - pad, w: r.width + pad * 2, h: r.height + pad * 2 } : { x: W / 2, y: H / 2, w: 0, h: 0 };
    hole.style.left = `${box.x}px`; hole.style.top = `${box.y}px`;
    hole.style.width = `${box.w}px`; hole.style.height = `${box.h}px`;
    hole.style.borderRadius = step.big ? '22px' : `${Math.min(box.h / 2, 999)}px`;
    hole.classList.toggle('none', !ok);

    const cw = card.offsetWidth, ch = card.offsetHeight, gap = 14, edge = 12;
    let x = (W - cw) / 2, y = (H - ch) / 2, side = '';
    if (ok && step.big) {
      if (box.x - gap - cw >= edge) { side = 'left'; x = box.x - gap - cw; y = clamp(box.y + box.h / 2 - ch / 2, edge, H - ch - edge); }
      else { x = clamp(box.x + (box.w - cw) / 2, edge, W - cw - edge); y = Math.max(edge, box.y + box.h - ch - 24); } // 旁边放不下：压在它里面靠下
    } else if (ok) {
      const below = box.y + box.h + gap + ch <= H - edge;
      side = below ? 'bottom' : 'top';
      y = below ? box.y + box.h + gap : Math.max(edge, box.y - gap - ch);
      x = clamp(box.x + box.w / 2 - cw / 2, edge, W - cw - edge);
    }
    card.className = `g-card${step.welcome ? ' welcome' : ''}${side ? ` side-${side}` : ''}`;
    card.style.setProperty('--ax', `${clamp(box.x + box.w / 2 - x, 22, cw - 22)}px`);
    card.style.setProperty('--ay', `${clamp(box.y + box.h / 2 - y, 22, ch - 22)}px`);
    card.style.transform = `translate3d(${Math.round(x)}px, ${Math.round(y)}px, 0)`;
  }

  function show(i, instant) {
    at = clamp(i, 0, STEPS.length - 1);
    const step = STEPS[at], last = at === STEPS.length - 1;
    card.classList.toggle('welcome', !!step.welcome); // 先换成这一步的宽度，再量大小
    q('.g-icon').hidden = !step.welcome;
    q('#g-title').textContent = step.title;
    q('.g-text').innerHTML = typeof step.text === 'function' ? step.text() : step.text;
    q('.g-note').textContent = step.note || '';
    q('.g-note').hidden = !step.note;
    q('.g-prev').hidden = at === 0;
    q('.g-skip').style.visibility = last ? 'hidden' : '';
    q('.g-next').textContent = at === 0 ? '带我看一圈' : last ? '开始用' : '下一步';
    [...q('.g-dots').children].forEach((d, k) => d.classList.toggle('on', k === at));
    if (instant) root.classList.add('still');
    place();
    if (instant) { void card.offsetWidth; root.classList.remove('still'); } // 第一下直接到位，不从左上角飞过来
    else if (!noMotion.matches) body.animate([{ opacity: 0, transform: 'translateY(5px)' }, { opacity: 1, transform: 'none' }], { duration: 280, easing: 'ease-out' });
    q('.g-next').focus({ preventScroll: true });
  }

  function close() {
    if (open !== api) return;
    open = null;
    document.removeEventListener('keydown', onKey, true);
    removeEventListener('resize', place);
    root.classList.add('out');
    setTimeout(() => root.remove(), noMotion.matches ? 0 : 240);
    onClose?.();
  }

  // 指引开着的时候，键盘只管指引：← → 翻页，Esc 跳过；其余的键不让它们触发播放、切换模式这些快捷键
  function onKey(e) {
    if (e.metaKey || e.ctrlKey || e.altKey) return; // 刷新、关窗口这些照常
    e.stopImmediatePropagation();
    if (e.key === 'Escape') { e.preventDefault(); close(); }
    else if (e.key === 'ArrowRight') { e.preventDefault(); if (at === STEPS.length - 1) close(); else show(at + 1); }
    else if (e.key === 'ArrowLeft') { e.preventDefault(); show(at - 1); }
    else if (e.key === 'Tab') { // 焦点留在卡片里
      e.preventDefault();
      const btns = [...card.querySelectorAll('button')].filter((b) => !b.hidden && b.style.visibility !== 'hidden');
      const k = btns.indexOf(document.activeElement);
      btns[(k + (e.shiftKey ? -1 : 1) + btns.length) % btns.length].focus();
    }
    // Enter / 空格：留给卡片上有焦点的那个按钮
  }

  q('.g-next').addEventListener('click', () => (at === STEPS.length - 1 ? close() : show(at + 1)));
  q('.g-prev').addEventListener('click', () => show(at - 1));
  q('.g-skip').addEventListener('click', close);
  document.addEventListener('keydown', onKey, true);
  addEventListener('resize', place);
  const api = { close };
  open = api;
  show(0, true);
}
