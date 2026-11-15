// 桌面快捷方式：第一次运行时在桌面放一个带图标的「唱歌学日语」，双击它会打开终端并启动程序。
// 只创建一次（用户删掉后不会再生成）。
// 快捷方式固定指向创建它的那份程序；只有那份程序已经不存在（文件夹被移动 / 删除）时，
// 才会被之后启动的程序接管，所以电脑上同时有几份程序也不会互相抢。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT, dataPath } from './store.js';

const NAME = '唱歌学日语';
const TAG = '# uta-shortcut v2';
const LEGACY_TAG = '# uta-nihongo-shortcut'; // 旧版生成的快捷方式：谁启动就指向谁，多份程序并存时会来回跳
const shortcutPath = path.join(os.homedir(), 'Desktop', `${NAME}.command`);
const markerPath = dataPath('.shortcut-created');
const launcher = path.join(ROOT, `${NAME}.command`);
const icon = path.join(ROOT, 'public', 'icon.png');

const script = () => `#!/bin/zsh
${TAG}（由程序自动生成；删除它不影响程序本身）
LAUNCHER=${JSON.stringify(launcher)}
if [ ! -x "$LAUNCHER" ]; then
  echo "找不到程序：$LAUNCHER"
  echo "程序文件夹可能被移动或删除了。到新位置启动一次程序（npm start），这个快捷方式会自动更新。"
  read -r
  exit 1
fi
exec "$LAUNCHER"
`;

// 给文件贴上自定义图标，并隐藏 .command 扩展名
const SET_ICON = `
ObjC.import('AppKit');
function run(argv) {
  const img = $.NSImage.alloc.initWithContentsOfFile(argv[1]);
  const ok = img.isNil() ? false : $.NSWorkspace.sharedWorkspace.setIconForFileOptions(img, argv[0], 0);
  $.NSFileManager.defaultManager.setAttributesOfItemAtPathError($({ NSFileExtensionHidden: true }), argv[0], null);
  return ok ? 'ok' : 'no-icon';
}`;
const setIcon = () => new Promise((resolve) => {
  execFile('osascript', ['-l', 'JavaScript', '-e', SET_ICON, shortcutPath, icon], { timeout: 15000 },
    (err, stdout) => resolve(!err && stdout.trim() === 'ok'));
});

const exists = (p) => fs.access(p).then(() => true, () => false);

// 返回 'created' | 'updated' | 'kept' | 'skipped'；失败时抛出（下次启动会重试）
export async function ensureDesktopShortcut() {
  const body = script();
  if (await exists(shortcutPath)) {
    const cur = await fs.readFile(shortcutPath, 'utf8');
    const legacy = !cur.includes(TAG) && cur.includes(LEGACY_TAG);
    if (!cur.includes(TAG) && !legacy) return 'kept'; // 同名但不是我们生成的文件：不碰
    if (!(await exists(markerPath))) await fs.writeFile(markerPath, new Date().toISOString());
    if (cur === body) return 'kept';
    if (!legacy) {
      // 指向的那份程序还在：不接管
      const m = /^LAUNCHER=(".*")$/m.exec(cur);
      let target = '';
      try { target = m ? JSON.parse(m[1]) : ''; } catch { /* 当作失效处理 */ }
      if (target && target !== launcher && await exists(target)) return 'kept';
    }
    await fs.writeFile(shortcutPath, body);          // 原地改写，图标保留
    return 'updated';
  }
  if (await exists(markerPath)) return 'skipped';   // 以前创建过、被用户删了
  await fs.writeFile(shortcutPath, body, { mode: 0o755 });
  await fs.chmod(shortcutPath, 0o755);
  await setIcon();
  await fs.writeFile(markerPath, new Date().toISOString());
  return 'created';
}
