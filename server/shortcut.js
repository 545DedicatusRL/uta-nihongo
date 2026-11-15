// 桌面图标：第一次运行时在桌面放一个「唱歌学日语」小应用，双击它就在后台启动程序并打开界面，
// 不会弹出终端窗口；运行期间程序坞里有它的图标（点一下回到界面，右键可退出）。
// 只创建一次（用户删掉后不会再生成）。
// 图标固定指向创建它的那份程序；只有那份程序已经不存在（文件夹被移动 / 删除）时，
// 才会被之后启动的程序接管，所以电脑上同时有几份程序也不会互相抢。
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { ROOT, dataPath } from './store.js';

const NAME = '唱歌学日语';
const TAG = '# uta-shortcut v3';
// 旧版在桌面放的是 .command 脚本（双击会打开终端）：发现后换成小应用
const OLD_TAGS = ['# uta-shortcut v2', '# uta-nihongo-shortcut'];
const LEGACY_TAG = '# uta-nihongo-shortcut'; // 最早的一版：谁启动就指向谁
const desktop = path.join(os.homedir(), 'Desktop');
const appPath = path.join(desktop, `${NAME}.app`);
const oldShortcut = path.join(desktop, `${NAME}.command`);
const INFO = path.join('Contents', 'Resources', 'uta-shortcut.txt'); // 记录这个图标指向哪份程序
const markerPath = dataPath('.shortcut-created');
const launcher = path.join(ROOT, `${NAME}.command`);
const icon = path.join(ROOT, 'public', 'icon.png');

// 小应用的脚本。程序路径里有中文，写成字符编码，源码保持纯 ASCII，不依赖 osacompile 对文件编码的猜测。
// 启动脚本在后台运行并记下小应用的进程号：程序退出时它会顺手把小应用也关掉。
const appleScript = () => `property launcher : string id {${[...launcher].map((c) => c.codePointAt(0)).join(', ')}}

on launch()
	do shell script "UTA_APP_PID=$PPID UTA_BACKGROUND=1 /bin/zsh " & quoted form of launcher & " > /dev/null 2>&1 &"
end launch

on run
	launch()
end run

on reopen
	launch()
end reopen

on quit
	try
		do shell script "/usr/bin/curl -s -m 2 -X POST http://127.0.0.1:3939/api/quit"
	end try
	continue quit
end quit
`;

const run = (cmd, args) => new Promise((resolve, reject) => {
  execFile(cmd, args, { timeout: 30000 }, (err, stdout, stderr) => (err ? reject(new Error(`${path.basename(cmd)}: ${(stderr || err.message).trim()}`)) : resolve(stdout)));
});
const exists = (p) => fs.access(p).then(() => true, () => false);
const readIf = (p) => fs.readFile(p, 'utf8').catch(() => null);

// 先在临时目录里把小应用做好，再整体搬到桌面
async function buildApp() {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'uta-app-'));
  try {
    const src = path.join(tmp, 'main.applescript');
    const out = path.join(tmp, `${NAME}.app`);
    await fs.writeFile(src, appleScript());
    await run('/usr/bin/osacompile', ['-s', '-o', out, src]); // -s：运行后不自动退出，留在程序坞里
    const res = path.join(out, 'Contents', 'Resources');
    const plist = path.join(out, 'Contents', 'Info.plist');
    // 换成自己的图标（去掉默认的脚本图标资源，否则它优先）
    await run('/usr/bin/sips', ['-s', 'format', 'icns', icon, '--out', path.join(res, 'applet.icns')]);
    await fs.rm(path.join(res, 'Assets.car'), { force: true });
    await run('/usr/bin/plutil', ['-remove', 'CFBundleIconName', plist]).catch(() => {});
    await run('/usr/bin/plutil', ['-replace', 'CFBundleIdentifier', '-string', 'local.uta-nihongo.launcher', plist]);
    await run('/usr/bin/plutil', ['-replace', 'NSAppleEventsUsageDescription', '-string', '「唱歌学日语」需要控制 Apple Music：播放歌曲、读取资料库和播放进度。', plist]);
    await fs.writeFile(path.join(out, INFO), `${TAG}（由程序自动生成；删除这个图标不影响程序本身）\nLAUNCHER=${launcher}\n`);
    await run('/usr/bin/codesign', ['--force', '-s', '-', out]); // 改过内容后要重新签名，系统才认它的权限
    await fs.rm(appPath, { recursive: true, force: true });
    await run('/bin/mv', [out, appPath]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
}
const mark = async () => { if (!(await exists(markerPath))) await fs.writeFile(markerPath, new Date().toISOString()); };

// 返回 'created' | 'updated' | 'kept' | 'skipped'；失败时抛出（下次启动会重试）
export async function ensureDesktopShortcut() {
  const old = await readIf(oldShortcut);
  const oldIsOurs = old !== null && OLD_TAGS.some((t) => old.includes(t));
  const dropOld = async () => { if (oldIsOurs) await fs.rm(oldShortcut, { force: true }); };

  if (await exists(appPath)) {
    const cur = await readIf(path.join(appPath, INFO));
    if (cur === null) return 'kept'; // 同名但不是我们生成的应用：不碰
    await mark();
    const target = /^LAUNCHER=(.+)$/m.exec(cur)?.[1] || '';
    if (cur.includes(TAG) && target === launcher) { await dropOld(); return 'kept'; }
    if (target && target !== launcher && await exists(target)) return 'kept'; // 指向的那份程序还在：不接管
    await buildApp();
    await dropOld();
    return 'updated';
  }
  if (oldIsOurs) {
    // 旧版的 .command 快捷方式：换成小应用（它指向的另一份程序还在时不动它）
    let target = '';
    try { target = JSON.parse(/^LAUNCHER=(".*")$/m.exec(old)?.[1] || '""'); } catch { /* 当作失效处理 */ }
    if (!old.includes(LEGACY_TAG) && target && target !== launcher && await exists(target)) return 'kept';
    await buildApp();
    await dropOld();
    await mark();
    return 'updated';
  }
  if (await exists(markerPath)) return 'skipped'; // 以前创建过、被用户删了
  await buildApp();
  await mark();
  return 'created';
}

// 直接运行（node server/shortcut.js）：检查 / 生成一次桌面图标。更新脚本用它，
// 因为从桌面图标启动的程序不会自己去碰桌面（避免系统多弹一次「访问桌面文件夹」的询问）。
if (process.argv[1] && path.resolve(process.argv[1]) === path.join(ROOT, 'server', 'shortcut.js')) {
  ensureDesktopShortcut().then((r) => console.log(r), (e) => { console.error(e.message); process.exit(1); });
}
