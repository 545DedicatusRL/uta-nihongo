#!/bin/bash
# 打包成 macOS App：dist/唱歌学日语.app
# 原生窗口（系统自带的 WebKit）+ 打包进去的 Node.js，用户电脑上不需要装 Node，也不需要浏览器。
# 用法：tools/build-app.sh                 打包本机芯片的版本 → dist/唱歌学日语.app
#       tools/build-app.sh --arch x64      打包 Intel 芯片的版本 → dist/x64/唱歌学日语.app（arm64 同理 → dist/arm64/）
#       tools/build-app.sh --zip           另外压成发布用的 dist/uta-nihongo-macOS-<芯片>.zip
#       tools/build-app.sh --install       打包后装到 ~/Applications
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT="$PWD"
NAME="唱歌学日语"
HOST_ARCH="$(uname -m | sed 's/x86_64/x64/')"
ARCH="$HOST_ARCH"; ZIP=0; INSTALL=0
while [ $# -gt 0 ]; do
  case "$1" in
    --arch) ARCH="$2"; shift ;;
    --zip) ZIP=1 ;;
    --install) INSTALL=1 ;;
    *) echo "不认识的参数：$1"; exit 1 ;;
  esac
  shift
done
case "$ARCH" in arm64) SWIFT_ARCH=arm64 ;; x64) SWIFT_ARCH=x86_64 ;; *) echo "芯片只能是 arm64 或 x64"; exit 1 ;; esac
# 本机芯片的放在 dist/ 下（和以前一样），另一种芯片的放在 dist/<芯片>/ 下
if [ "$ARCH" = "$HOST_ARCH" ]; then OUT="$ROOT/dist"; else OUT="$ROOT/dist/$ARCH"; fi
APP="$OUT/$NAME.app"
# 先在普通文件夹里组装，最后再改名成 .app：macOS 的「App 管理」保护不让改动已经运行过的 App 包里的文件
STAGE="$ROOT/dist/.stage/$NAME.app"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "需要 Node.js（用来打包进 App）"; exit 1; }
NODE="$(python3 -c 'import os,sys; print(os.path.realpath(sys.argv[1]))' "$NODE")"
if [ "$ARCH" != "$HOST_ARCH" ]; then
  # 另一种芯片：从 Node.js 官网下载同一个版本的那种芯片的 node，核对官网公布的校验值后再用（下载过就直接用缓存）
  NV="$("$NODE" -v)"; CACHE="$ROOT/dist/.cache/node-$NV-darwin-$ARCH"
  if [ ! -x "$CACHE/bin/node" ]; then
    echo "· 下载 Node.js $NV（$ARCH）"
    TMP="$(mktemp -d)"; TGZ="node-$NV-darwin-$ARCH.tar.gz"
    curl -fsSL -o "$TMP/$TGZ" "https://nodejs.org/dist/$NV/$TGZ"
    curl -fsSL -o "$TMP/SHASUMS256.txt" "https://nodejs.org/dist/$NV/SHASUMS256.txt"
    (cd "$TMP" && grep " $TGZ\$" SHASUMS256.txt | shasum -a 256 -c -) || { echo "Node.js 校验不通过"; exit 1; }
    mkdir -p "$CACHE" && tar -xzf "$TMP/$TGZ" -C "$CACHE" --strip-components 1 && rm -rf "$TMP"
  fi
  NODE="$CACHE/bin/node"
fi
# 系统版本下限跟着打包进去的 node 走（node 自己要求的最低系统，比如 13.5）
MIN_OS="$(otool -l "$NODE" | awk '/LC_BUILD_VERSION/{f=1} f&&/minos/{print $2; exit}')"; MIN_OS="${MIN_OS:-12.0}"

echo "· 依赖"
[ -d node_modules ] || npm install --omit=dev --no-audit --no-fund

echo "· 编译外壳"
rm -rf "$ROOT/dist/.stage"
mkdir -p "$STAGE/Contents/MacOS" "$STAGE/Contents/Resources/app"
# 用新系统的 SDK 编译，窗口才是新系统的样子（红黄绿按钮更大、窗口圆角更大）；用旧 SDK 编出来的会被系统按旧样式显示。
# 当前选中的开发工具 SDK 比较旧、又装了 Xcode 时，改用 Xcode 自带的
if [ -z "${DEVELOPER_DIR:-}" ] && [ -d /Applications/Xcode.app/Contents/Developer ]; then
  SDK_MAJOR="$(xcrun --show-sdk-version 2>/dev/null | cut -d. -f1)"
  [ "${SDK_MAJOR:-0}" -ge 26 ] || export DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer
fi
echo "  SDK $(xcrun --show-sdk-version 2>/dev/null)"
# -target：芯片，和最低支持的系统（和 Info.plist 里写的一致），不然默认只能在本机这个系统版本以上运行
xcrun swiftc -O -target "$SWIFT_ARCH-apple-macos$MIN_OS" -o "$STAGE/Contents/MacOS/$NAME" macos/main.swift -framework AppKit -framework WebKit

echo "· 复制程序与 Node.js（$(file -b "$NODE" | awk '{print $NF}') $("$NODE" -v 2>/dev/null || basename "$(dirname "$(dirname "$NODE")")")，需要 macOS $MIN_OS+）"
cp "$NODE" "$STAGE/Contents/Resources/node"
rsync -a --exclude '.DS_Store' --exclude 'node_modules/kuromoji/test' --exclude 'node_modules/kuromoji/demo' --exclude '*.map' --exclude '*.d.ts' --exclude '*.d.mts' --exclude '*.d.cts' --exclude '*.md' --exclude '/node_modules/.bin' server public node_modules package.json LICENSE "$STAGE/Contents/Resources/app/"

echo "· 图标"
ICONSET="$(mktemp -d)/icon.iconset"; mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  sips -z $s $s public/icon.png --out "$ICONSET/icon_${s}x${s}.png" >/dev/null
  sips -z $((s*2)) $((s*2)) public/icon.png --out "$ICONSET/icon_${s}x${s}@2x.png" >/dev/null
done
iconutil -c icns "$ICONSET" -o "$STAGE/Contents/Resources/icon.icns"

VERSION="$(python3 -c 'import json; print(json.load(open("package.json"))["version"])')"
BUNDLE_VER="${VERSION%%-*}" # Info.plist 的版本号只能是数字和点：1.0.3-netease.9 → 1.0.3（完整的版本号另外写一份）
cat > "$STAGE/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>CFBundleName</key><string>$NAME</string>
  <key>CFBundleDisplayName</key><string>$NAME</string>
  <key>CFBundleIdentifier</key><string>io.github.uta-nihongo</string>
  <key>CFBundleExecutable</key><string>$NAME</string>
  <key>CFBundleIconFile</key><string>icon</string>
  <key>CFBundlePackageType</key><string>APPL</string>
  <key>CFBundleShortVersionString</key><string>$BUNDLE_VER</string>
  <key>CFBundleVersion</key><string>$BUNDLE_VER</string>
  <key>UtaReleaseVersion</key><string>$VERSION</string>
  <key>LSMinimumSystemVersion</key><string>$MIN_OS</string>
  <key>UtaArch</key><string>$ARCH</string>
  <key>LSApplicationCategoryType</key><string>public.app-category.education</string>
  <key>NSHighResolutionCapable</key><true/>
  <key>NSAppleEventsUsageDescription</key><string>用来读取 Apple Music 的播放进度、控制播放，以及关闭 / 重新打开网易云音乐。</string>
  <key>NSAppTransportSecurity</key><dict><key>NSAllowsLocalNetworking</key><true/></dict>
</dict></plist>
PLIST

echo "· 签名（本机自签）"
codesign --force --deep --sign - "$STAGE"
mkdir -p "$OUT"
rm -rf "$APP"
mv "$STAGE" "$APP"; rm -rf "$ROOT/dist/.stage"

echo "完成：$APP（$ARCH，$(du -sh "$APP" | cut -f1)）"
if [ "$ZIP" = 1 ]; then
  Z="$ROOT/dist/uta-nihongo-macOS-$ARCH.zip"
  rm -f "$Z"; ditto -c -k --keepParent "$APP" "$Z"
  echo "压缩包：$Z（$(du -sh "$Z" | cut -f1)）"
fi
if [ "$INSTALL" = 1 ]; then
  mkdir -p "$HOME/Applications"
  rm -rf "$HOME/Applications/$NAME.app"
  cp -R "$APP" "$HOME/Applications/"
  echo "已安装到 ~/Applications/$NAME.app"
fi
