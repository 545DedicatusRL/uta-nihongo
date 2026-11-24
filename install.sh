#!/bin/bash
# 唱歌学日语 — 一键安装 / 更新（macOS）
#
#   curl -fsSL https://raw.githubusercontent.com/raaaaaaayx/uta-nihongo/main/install.sh | bash
#
# 第一次运行是安装；以后再运行同一行就是更新：只换程序文件，data/ 里的词汇书、设置和缓存不动。
# 可选的环境变量：
#   UTA_DIR=/某个/文件夹   装到哪里（默认 ~/Applications/唱歌学日语；已经在运行时默认更新正在运行的那一份）
#   UTA_NO_LAUNCH=1        只安装，不启动
set -euo pipefail

REPO="raaaaaaayx/uta-nihongo"
NAME="唱歌学日语"
PORT=3939

say() { printf '\033[1m%s\033[0m\n' "$*"; }
note() { printf '  %s\n' "$*"; }
fail() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; shift; for l in "$@"; do printf '  %s\n' "$l" >&2; done; exit 1; }

[ "$(uname)" = "Darwin" ] || fail "这个程序只能在 macOS 上运行（它用的是 Apple Music）。"

# ---- Node.js ----
NVM_NODE="$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1 || true)"
export PATH="${NVM_NODE:+$HOME/.nvm/versions/node/$NVM_NODE/bin:}/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null 2>&1 || ! command -v npm >/dev/null 2>&1; then
  fail "需要先安装 Node.js。" \
    "到 https://nodejs.org 下载「LTS」版的安装包，一路点继续装好，" \
    "然后重新打开终端，再运行一次这行安装命令。"
fi
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || fail "Node.js 版本太旧（现在是 $(node -v)，需要 18 或更新）。" "到 https://nodejs.org 装一个新的「LTS」版，再运行一次这行安装命令。"

# ---- 装到哪里 ----
RUNNING_ROOT="$(curl -s -m 2 "http://localhost:$PORT/api/info" 2>/dev/null | sed -n 's/.*"root":"\([^"]*\)".*/\1/p' || true)"
DEST="${UTA_DIR:-${RUNNING_ROOT:-$HOME/Applications/$NAME}}"
if [ -d "$DEST/.git" ]; then
  say "$DEST 是用 git 克隆的那一份，安装脚本不会去覆盖它。"
  note "更新请在那个文件夹里运行：git pull && tools/update-local.sh"
  exit 0
fi
if [ -e "$DEST" ] && [ ! -f "$DEST/server/index.js" ] && [ -n "$(ls -A "$DEST" 2>/dev/null || true)" ]; then
  fail "$DEST 已经存在，而且里面不是「$NAME」。" "为了不弄乱里面的东西，安装停在这里。可以换个位置：在命令前面加上 UTA_DIR=/别的/文件夹"
fi
VERB="安装"; [ -f "$DEST/server/index.js" ] && VERB="更新"

# ---- 下载 ----
# 优先用最新的正式版本（Release）；还没有发布过或查不到时用开发中的最新代码
TAG="$(curl -fsSL -m 15 "https://api.github.com/repos/$REPO/releases/latest" 2>/dev/null | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1 || true)"
if [ -n "$TAG" ]; then URL="https://github.com/$REPO/archive/refs/tags/$TAG.tar.gz"; LABEL="$TAG"
else URL="https://github.com/$REPO/archive/refs/heads/main.tar.gz"; LABEL="最新开发版"; fi

say "$VERB「$NAME」$LABEL → $DEST"
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
mkdir -p "$TMP/src"
curl -fsSL "$URL" | tar -xz -C "$TMP/src" --strip-components=1 || fail "下载失败。" "检查一下网络（能不能打开 github.com），然后再试一次。"
[ -f "$TMP/src/server/index.js" ] || fail "下载到的内容不完整，请再试一次。"

mkdir -p "$DEST"
cp -R "$TMP/src/." "$DEST/"
cd "$DEST"

say "安装依赖（第一次要一两分钟）…"
npm install --omit=dev --no-audit --no-fund --loglevel=error || fail "依赖安装失败。" "多半是网络问题，再运行一次这行安装命令即可。"

if [ -n "${UTA_NO_LAUNCH:-}" ]; then say "已装好：$DEST（按要求没有启动）"; exit 0; fi

# ---- 启动 ----
if [ -n "$RUNNING_ROOT" ] && [ "$RUNNING_ROOT" = "$DEST" ]; then
  # 正在运行的就是这一份：让它原地重启到新版，界面会自己刷新
  curl -s -m 3 -X POST "http://localhost:$PORT/api/restart" >/dev/null 2>&1 || true
  say "已更新到 $LABEL，程序已重启。"
  exit 0
fi
# 在桌面放图标（已经有、或者以前被你删掉过，就不会重复放）
node server/shortcut.js >/dev/null 2>&1 || true
APP="$HOME/Desktop/$NAME.app"
if [ -f "$APP/Contents/Resources/uta-shortcut.txt" ] && grep -qxF "LAUNCHER=$DEST/$NAME.command" "$APP/Contents/Resources/uta-shortcut.txt"; then
  open "$APP"
  say "装好了，正在启动。以后双击桌面上的「$NAME」图标就行。"
else
  open "$DEST/$NAME.command"
  say "装好了，正在启动（这次在终端窗口里运行，关掉那个窗口即退出）。"
fi
note "第一次启动，系统会问是否允许它控制「音乐」等，点「允许」。"
note "退出：界面里「设置 → 更多设置」最下面，或在程序坞的图标上右键退出。"
note "更新：再运行一次这行安装命令。"
