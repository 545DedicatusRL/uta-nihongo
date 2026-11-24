// 界面窗口：用哪个浏览器打开、已经开着时怎么把它叫到前面。
// 界面是一个网页。Chromium 系的浏览器（Chrome、Edge…）可以用 --app 参数把它开成没有地址栏和
// 标签页的独立窗口；其他浏览器只能当普通标签页打开。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile, spawn } from 'node:child_process';

const WIN = process.platform === 'win32';

// 支持 --app 的浏览器，按「自动」时的优先顺序。Windows 上 Edge 是系统自带的，排在前面保证总能找到一个
const CHROMIUM = WIN
  ? ['Microsoft Edge', 'Google Chrome', 'Brave Browser', 'Vivaldi', 'Chromium']
  : ['Google Chrome', 'Microsoft Edge', 'Brave Browser', 'Vivaldi', 'Chromium'];

// macOS：看 /Applications 里有没有对应的 .app
const appDirs = ['/Applications', path.join(os.homedir(), 'Applications')];
// Windows：各浏览器的程序相对于「Program Files / Program Files (x86) / 用户的 AppData\Local」的位置
const WIN_EXE = {
  'Microsoft Edge': 'Microsoft\\Edge\\Application\\msedge.exe',
  'Google Chrome': 'Google\\Chrome\\Application\\chrome.exe',
  'Brave Browser': 'BraveSoftware\\Brave-Browser\\Application\\brave.exe',
  Vivaldi: 'Vivaldi\\Application\\vivaldi.exe',
  Chromium: 'Chromium\\Application\\chrome.exe',
};
function winExe(name) {
  for (const base of [process.env.ProgramFiles, process.env['ProgramFiles(x86)'], process.env.LOCALAPPDATA]) {
    const p = base && WIN_EXE[name] && path.join(base, WIN_EXE[name]);
    if (p && fs.existsSync(p)) return p;
  }
  return '';
}
const installed = (name) => (WIN ? !!winExe(name) : appDirs.some((d) => fs.existsSync(path.join(d, `${name}.app`))));

export const installedBrowsers = () => CHROMIUM.filter(installed);
// setting：'auto'（装了哪个用哪个）| 浏览器名 | 'default'（系统默认浏览器，普通标签页）。
// 返回浏览器名；null 表示用系统默认浏览器
export function pickBrowser(setting = 'auto') {
  if (setting === 'default') return null;
  if (setting !== 'auto' && CHROMIUM.includes(setting) && installed(setting)) return setting;
  return installedBrowsers()[0] || null;
}

const run = (cmd, args) => new Promise((resolve) => {
  execFile(cmd, args, { timeout: 8000 }, (err, stdout) => resolve(err ? '' : String(stdout).trim()));
});

// 系统默认浏览器的位置（/Applications/Safari.app 之类）
const DEFAULT_BROWSER = `
ObjC.import('AppKit');
function run() {
  const u = $.NSWorkspace.sharedWorkspace.URLForApplicationToOpenURL($.NSURL.URLWithString('http://localhost/'));
  return u.isNil() ? '' : u.path.js;
}`;

let lastBrowser; // 上一次开窗口用的浏览器（undefined = 还没开过；null = 系统默认浏览器）

// 把浏览器叫到前面。用 AppleScript 的 activate：只是切到前面，不会像 `open -a` 那样
// 让浏览器以为用户想要一个新窗口（Chrome 只剩独立窗口时会因此多开一个空白窗口）
async function activate(name) {
  // Windows 不让后台程序把别的窗口抢到前面；交给界面自己（服务端随后会给它发 focus，它调用 window.focus()）
  if (WIN) return true;
  const target = name || await run('osascript', ['-l', 'JavaScript', '-e', DEFAULT_BROWSER]);
  if (!target) return false;
  const out = await run('osascript', ['-e', `tell application ${JSON.stringify(target)} to activate`, '-e', 'return "ok"']);
  return out === 'ok';
}

// 新开一个界面窗口。name：浏览器名；null = 系统默认浏览器
async function open(name, page) {
  if (!WIN) {
    if (name) await run('open', ['-na', name, '--args', `--app=${page}`, '--window-size=1100,680']);
    else await run('open', [page]);
    return;
  }
  const exe = name && winExe(name);
  // 浏览器是独立的程序：和本程序脱开，本程序退出时它不跟着关
  if (exe) spawn(exe, [`--app=${page}`, '--window-size=1100,680'], { detached: true, stdio: 'ignore' }).unref();
  else spawn('cmd.exe', ['/c', 'start', '', page], { detached: true, stdio: 'ignore', windowsHide: true }).unref();
}

// hasWindow：我们开的界面窗口是否还开着；fresh：不管有没有，都按当前设置新开一个（换浏览器时用）
// 返回 'focused'（把已有窗口叫到了前面）或 'opened'（新开了窗口）
export async function showUI({ url, setting, hasWindow, fresh = false }) {
  if (hasWindow && !fresh) {
    const name = lastBrowser === undefined ? pickBrowser(setting) : lastBrowser;
    if (await activate(name)) return 'focused';
  }
  const name = pickBrowser(setting);
  lastBrowser = name;
  await open(name, `${url}/?app=1`); // 带上记号：这样才分得清哪些页面是我们开的界面窗口
  return 'opened';
}
