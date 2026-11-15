// 桌面快捷方式：第一次运行时在桌面放一个带图标的「唱歌学日语」，双击它会打开终端并启动程序。
// 只创建一次（用户删掉后不会再生成）；程序文件夹被移动后，会自动把已有快捷方式指向新位置。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT, dataPath } from './store.js';

const NAME = '唱歌学日语';
const TAG = '# uta-nihongo-shortcut';
const shortcutPath = path.join(os.homedir(), 'Desktop', `${NAME}.command`);
const markerPath = dataPath('.shortcut-created');
const launcher = path.join(ROOT, `${NAME}.command`);
const icon = path.join(ROOT, 'public', 'icon.png');

const script = () => `#!/bin/zsh
${TAG}（由程序自动生成；删除它不影响程序本身）
LAUNCHER=${JSON.stringify(launcher)}
if [ ! -x "$LAUNCHER" ]; then
  echo "找不到程序：$LAUNCHER"
  echo "程序文件夹可能被移动或删除了。到新位置启动一次程序，这个快捷方式会自动更新。"
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
    if (!cur.includes(TAG)) return 'kept';          // 同名但不是我们生成的文件：不碰
    if (!(await exists(markerPath))) await fs.writeFile(markerPath, new Date().toISOString());
    if (cur === body) return 'kept';
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
