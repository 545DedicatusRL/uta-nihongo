#!/bin/zsh
# 改完代码后运行：让本机正在用的「唱歌学日语」换成这份代码的最新版，并确认桌面快捷方式指向这里。
#   - 正在运行的就是这一份：原地重启（界面会自动刷新）
#   - 没在运行，或运行的是另一份 / 旧版：通过桌面图标启动这一份（会替换掉另一份）
cd "$(dirname "$0")/.." || exit 1
HERE="$(pwd -P)"
PORT="${PORT:-3939}"
URL="http://localhost:$PORT"
SHORTCUT="$HOME/Desktop/唱歌学日语.app"
SHORTCUT_INFO="$SHORTCUT/Contents/Resources/uta-shortcut.txt"
points_here() { [ -f "$SHORTCUT_INFO" ] && grep -qxF "LAUNCHER=$HERE/唱歌学日语.command" "$SHORTCUT_INFO"; }
field() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{console.log(JSON.parse(d)[process.argv[1]]??"")}catch{console.log("")}})' "$1"; }
info() { curl -s -m 2 "$URL/api/info"; }

# 桌面图标：从图标启动的程序不会自己去检查它，所以在这里检查 / 更新一次
node server/shortcut.js >/dev/null 2>&1

OLD_BOOT=""
if [ "$(info | field root)" = "$HERE" ]; then
  OLD_BOOT="$(info | field boot)"
  curl -s -m 3 -X POST "$URL/api/restart" >/dev/null
  for i in {1..40}; do
    sleep 0.25
    B="$(info | field boot)"
    [ -n "$B" ] && [ "$B" != "$OLD_BOOT" ] && break
  done
fi
if [ "$(info | field root)" != "$HERE" ] || [ "$(info | field boot)" = "$OLD_BOOT" ]; then
  # 没能原地重启：用桌面图标启动（没有就用本目录的启动脚本，在终端里运行）
  if points_here; then open "$SHORTCUT"; else open "$HERE/唱歌学日语.command"; fi
  for i in {1..60}; do
    sleep 0.5
    [ "$(info | field root)" = "$HERE" ] && [ "$(info | field boot)" != "$OLD_BOOT" ] && break
  done
fi

OK=1
RUN_ROOT="$(info | field root)"; RUN_VER="$(info | field version)"
HEAD_VER="$(git log -1 --format='%h · %cs' 2>/dev/null)"
HEAD_TAGS="$(git tag --points-at HEAD 2>/dev/null | tr '\n' ' ' | sed 's/ *$//')"
if [ -n "$HEAD_VER" ] && [ -n "$HEAD_TAGS" ]; then HEAD_VER="$HEAD_VER · $HEAD_TAGS"; fi
if [ "$RUN_ROOT" = "$HERE" ]; then echo "运行中：$RUN_VER（$RUN_ROOT）"; else echo "✗ 运行中的不是这一份：${RUN_ROOT:-没有在运行}"; OK=0; fi
if [ -n "$HEAD_VER" ] && [ "$RUN_VER" != "$HEAD_VER" ]; then echo "✗ 版本不一致：代码是 $HEAD_VER"; OK=0; fi
[ -n "$(git status --porcelain 2>/dev/null)" ] && echo "（注意：有未提交的改动，运行的是磁盘上的当前文件）"
if [ ! -d "$SHORTCUT" ]; then echo "桌面图标：不存在（被删除过，不会自动重建）"
elif points_here; then echo "桌面图标：指向这一份 ✓"
else echo "✗ 桌面图标指向别处：$(grep '^LAUNCHER=' "$SHORTCUT_INFO" 2>/dev/null)"; OK=0; fi
[ $OK -eq 1 ] && echo "已启用新版 ✓" || exit 1
