#!/bin/zsh
# 启动「唱歌学日语」：启动本地服务并打开界面。
#   - 双击这个文件 / 在终端里运行：程序跑在这个终端窗口里，关闭窗口即退出
#   - 从桌面图标启动（UTA_BACKGROUND=1）：不开终端，在后台运行；在「设置 → 更多设置」里退出，
#     或在程序坞的图标上右键退出。运行记录写在 data/app.log
cd "$(dirname "$0")"
BG="${UTA_BACKGROUND:-}"
if [ -n "$BG" ]; then
  mkdir -p data
  [ "$(stat -f%z data/app.log 2>/dev/null || echo 0)" -gt 1000000 ] && : > data/app.log
  exec >> data/app.log 2>&1
  echo "—— $(date '+%F %T') 从桌面图标启动 ——"
  export UTA_NO_SHORTCUT=1   # 桌面图标已经在了；后台运行时不去碰桌面
fi
# 后台运行时由桌面的小应用启动：程序结束后把它也关掉（程序坞里的图标随之消失）
quit_app() { [ -n "$UTA_APP_PID" ] && kill "$UTA_APP_PID" 2>/dev/null; }

export PATH="$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then
  echo "没有找到 Node.js，请先安装：https://nodejs.org"
  if [ -n "$BG" ]; then
    osascript -e 'display dialog "没有找到 Node.js，「唱歌学日语」无法启动。请先安装：https://nodejs.org" buttons {"好"} default button 1 with icon caution' >/dev/null 2>&1
    quit_app
  else
    read -r
  fi
  exit 1
fi
[ -d node_modules ] || npm install
PORT="${PORT:-3939}"
URL="http://localhost:$PORT"
open_ui() {
  if [ -d "/Applications/Google Chrome.app" ]; then
    open -na "Google Chrome" --args --app="$URL" --window-size=1100,680
  else
    open "$URL"
  fi
}
HERE="$(pwd -P)"
# 端口上已经有「唱歌学日语」在运行
if curl -s -m 2 "$URL/api/settings" | grep -q '"hasKey"'; then
  INFO="$(curl -s -m 2 "$URL/api/info")"
  if echo "$INFO" | grep -qF "\"root\":\"$HERE\""; then
    # 就是这一份：只打开界面。后台运行时如果界面窗口还开着，就只把浏览器切到前面，不再多开一个
    echo "唱歌学日语 已在运行，直接打开界面。"
    if [ -n "$BG" ] && [ -d "/Applications/Google Chrome.app" ] && ! echo "$INFO" | grep -q '"clients":0'; then
      open -a "Google Chrome"
    else
      open_ui
    fi
    exit 0
  fi
  # 是另一份（别的文件夹里的副本或旧版）：停掉它，换成这一份
  echo "检测到另一份「唱歌学日语」正在运行（可能是旧版），先停止它，再启动这一份…"
  lsof -tiTCP:"$PORT" -sTCP:LISTEN | xargs kill 2>/dev/null
  for i in {1..25}; do
    lsof -tiTCP:"$PORT" -sTCP:LISTEN >/dev/null || break
    sleep 0.2
  done
fi
( sleep 1.5; open_ui ) &
# 退出码 75 = 程序请求重启（更新到新版时用）：原地重新启动
while true; do
  PORT="$PORT" node server/index.js
  [ $? -eq 75 ] || break
  echo "—— 正在重启到新版本 ——"
done
# 程序已经结束（在设置里点了退出等）。确认端口上确实没有在运行的了，再关掉桌面的小应用
if [ -n "$BG" ] && ! curl -s -m 1 "$URL/api/info" | grep -q '"root"'; then quit_app; fi
