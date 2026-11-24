// 随程序带的字体，由本地服务提供（不联网）。现在只有一款：日文的 Noto Sans JP。
// 它是给没有 Hiragino 的系统（Windows、Linux）用的——Hiragino 是苹果系统自带的商业字体，不能跟着程序分发；
// Noto Sans JP 是开源字体里字形比例和它最接近的。Mac 上排在 Hiragino 后面，用不到，也就不会去加载。
//
// 字体文件来自 npm 包 @fontsource-variable/noto-sans-jp（可变字重，一份文件管所有粗细）。
// 整套字被切成一百多个小文件，每个文件管一小批字（unicode-range），页面上出现了哪批字浏览器才去取哪个文件。
// 包里自带的 CSS 这里要改两处再发给页面：
//   1. 英文字母、数字、带音标的拉丁字母、希腊 / 西里尔字母都不归它管（U+2010 以前的全部去掉）：英文交给系统字体，
//      见 public/style.css 的 --font-ja。不光是专门的「拉丁」那几块要去掉——按字频切出来的那一百多块里也混着
//      常用的英文字母和空格，不去掉的话空格都会归它。U+2010 以后的留着：省略号、破折号、弯引号这些标点在日文里
//      要用日文字体的样子（省略号居中、引号占一格）
//   2. 字体没取到之前先不画字（block），不先用别的字体顶一下再换：本机取文件只要几毫秒，换一下反而是闪
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './store.js';

const DIR = path.join(ROOT, 'node_modules', '@fontsource-variable', 'noto-sans-jp');
const FAMILY = 'Uta Noto JP'; // 不叫 Noto Sans JP：免得和系统里装着的同名字体（带拉丁字母的整套）混在一起
const FIRST = 0x2010; // 从这个码位起才归日文字体管
let css = null;

// 没装这个包（旧的安装没重新 npm install）就返回空的样式表：页面照常，只是退回系统里的日文字体
export function notoCSS() {
  if (css !== null) return css;
  try {
    css = fs.readFileSync(path.join(DIR, 'index.css'), 'utf8').split(/(?=\/\* noto-sans-jp-)/).map((block) => {
      const part = /\/\* noto-sans-jp-(.+?)-wght-normal \*\//.exec(block)?.[1];
      if (!part || !/^\[\d+\]$/.test(part)) return ''; // 只要按字频切的那些块（[0]–[119]），拉丁 / 西里尔 / 越南语的专用块不要
      const range = /unicode-range:([^;]*);/.exec(block)?.[1].split(',').map((t) => t.trim())
        .filter((t) => parseInt(t.slice(2), 16) >= FIRST); // 每一段形如 U+3041-307f，看起点
      if (!range?.length) return '';
      return block
        .replace(/unicode-range:[^;]*;/, `unicode-range: ${range.join(',')};`)
        .replace(/font-family:[^;]*;/, `font-family: '${FAMILY}';`)
        .replace('font-display: swap', 'font-display: block')
        .replace(/url\(\.\/files\//g, 'url(/fonts/noto-sans-jp/');
    }).join('');
  } catch { css = ''; }
  return css;
}

// 字体文件在磁盘上的位置；名字不对或者文件不存在返回 null
export function notoFile(name) {
  if (!/^[\w.-]+\.woff2$/.test(name)) return null;
  const file = path.join(DIR, 'files', name);
  return fs.existsSync(file) ? file : null;
}
