// 检查更新：每次启动时问一次 GitHub「最新发布的版本是哪个」，比本机的新就告诉界面。
// 版本号写在 package.json 的 version 里（发布时和标签一致，比如 1.0.3-netease.9 ↔ 标签 v1.0.3-netease.9），
// 去哪个仓库查写在 package.json 的 uta.repo 里。只读取公开的发布信息，不发送任何本机的数据。
import fs from 'node:fs';
import path from 'node:path';
import { ROOT } from './store.js';

const pkg = (() => { try { return JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')); } catch { return {}; } })();
export const CURRENT = pkg.version || '';
const REPO = pkg.uta?.repo || '';

// 按语义化版本比大小：1.0.3-netease.10 > 1.0.3-netease.9；正式版 1.0.4 > 1.0.3-netease.N
function parse(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?/.exec(String(v).trim());
  if (!m) return null;
  return { core: [+m[1], +m[2], +m[3]], pre: m[4] ? m[4].split('.') : [] };
}
export function newer(a, b) { // a 比 b 新？
  const x = parse(a), y = parse(b);
  if (!x || !y) return false;
  for (let i = 0; i < 3; i++) if (x.core[i] !== y.core[i]) return x.core[i] > y.core[i];
  if (!x.pre.length || !y.pre.length) return !x.pre.length && !!y.pre.length; // 同一个版本号，正式版比预发布版新
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i], q = y.pre[i];
    if (p === undefined) return false;
    if (q === undefined) return true;
    if (p === q) continue;
    const pn = /^\d+$/.test(p), qn = /^\d+$/.test(q);
    if (pn && qn) return +p > +q;
    if (pn !== qn) return !pn; // 数字比字母小
    return p > q;
  }
  return false;
}

let pending = null; // 这次启动只查一次，结果一直用到退出
export function checkUpdate() {
  if (pending) return pending;
  pending = (async () => {
    if (!REPO || !CURRENT) return { current: CURRENT, newer: false };
    try {
      const r = await fetch(`https://api.github.com/repos/${REPO}/releases/latest`, {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'uta-nihongo-update-check' },
        signal: AbortSignal.timeout(10000),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const j = await r.json();
      const latest = String(j.tag_name || '').replace(/^v/, '');
      const asset = (j.assets || []).find((a) => /macOS.*\.zip$/i.test(a.name));
      return {
        current: CURRENT, latest, newer: newer(latest, CURRENT),
        title: j.name || '', page: j.html_url || `https://github.com/${REPO}/releases/latest`,
        download: asset?.browser_download_url || '',
        install: `curl -fsSL https://raw.githubusercontent.com/${REPO}/main/install.sh | bash`,
      };
    } catch (e) {
      pending = null; // 没网之类：下次打开界面时再试
      return { current: CURRENT, newer: false, error: e.message };
    }
  })();
  return pending;
}
