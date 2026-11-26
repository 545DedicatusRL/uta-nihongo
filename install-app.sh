#!/bin/bash
# 唱歌学日语 Mac App — 一行命令安装 / 更新（不需要 Node.js）
#
#   curl -fsSL https://raw.githubusercontent.com/545DedicatusRL/uta-nihongo/main/install-app.sh | bash
#
# 按这台 Mac 的芯片（Apple 芯片 / Intel）下载最新发布的 App，放进「应用程序」并打开。
# 用命令下载的文件不带「来自网上」的隔离标记，所以第一次打开不会被系统以「无法验证开发者」拦下来。
# 已经装过的话就是更新：只换 App 本身，词汇书、设置和缓存不动。
set -euo pipefail

REPO="545DedicatusRL/uta-nihongo"
NAME="唱歌学日语"
DEST="${UTA_APP_DIR:-/Applications}"

say() { printf '\033[1m%s\033[0m\n' "$*"; }
die() { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(uname -s)" = Darwin ] || die "这个 App 只能在 Mac 上用"
case "$(uname -m)" in
  arm64) ARCH=arm64; CHIP="Apple 芯片" ;;
  x86_64)
    # 在 Apple 芯片的 Mac 上用转译跑的终端也会报 x86_64，这时候还是装 Apple 芯片的版本
    if [ "$(sysctl -n sysctl.proc_translated 2>/dev/null || echo 0)" = 1 ]; then ARCH=arm64; CHIP="Apple 芯片"; else ARCH=x64; CHIP="Intel 芯片"; fi ;;
  *) die "不认识这台 Mac 的芯片：$(uname -m)" ;;
esac

# 打包进去的 Node.js 需要 macOS 13.5 或更新
OS="$(sw_vers -productVersion)"
if [ "$(printf '%s\n13.5\n' "$OS" | sort -V | head -1)" != 13.5 ]; then
  die "需要 macOS 13.5 或更新（这台是 $OS）"
fi

ZIP="uta-nihongo-macOS-$ARCH.zip"
URL="https://github.com/$REPO/releases/latest/download/$ZIP"
TMP="$(mktemp -d)"; trap 'rm -rf "$TMP"' EXIT

say "· 下载 $NAME（$CHIP）"
curl -fL --progress-bar -o "$TMP/$ZIP" "$URL" || die "下载失败，请检查网络后再试"
ditto -x -k "$TMP/$ZIP" "$TMP/app"
[ -d "$TMP/app/$NAME.app" ] || die "下载到的压缩包不对"
VER="$(plutil -extract UtaReleaseVersion raw "$TMP/app/$NAME.app/Contents/Info.plist" 2>/dev/null || echo '?')"

if pgrep -f "$NAME.app/Contents/MacOS/" >/dev/null 2>&1; then
  say "· 先退出正在运行的 $NAME"
  osascript -e "quit app \"$NAME\"" >/dev/null 2>&1 || true
  for _ in $(seq 1 50); do pgrep -f "$NAME.app/Contents/MacOS/" >/dev/null 2>&1 || break; sleep 0.2; done
fi

say "· 安装到 $DEST"
mkdir -p "$DEST" 2>/dev/null || true
if [ -w "$DEST" ] && { [ ! -e "$DEST/$NAME.app" ] || [ -w "$DEST/$NAME.app" ]; }; then
  rm -rf "$DEST/$NAME.app" && ditto "$TMP/app/$NAME.app" "$DEST/$NAME.app"
else
  say "  需要管理员密码才能写入 $DEST"
  sudo rm -rf "$DEST/$NAME.app" && sudo ditto "$TMP/app/$NAME.app" "$DEST/$NAME.app"
fi
xattr -dr com.apple.quarantine "$DEST/$NAME.app" 2>/dev/null || true

say "✓ 已安装 v$VER，正在打开"
open "$DEST/$NAME.app"
