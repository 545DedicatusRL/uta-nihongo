#!/bin/zsh
# 双击启动「唱歌学日语」：启动本地服务并打开界面。关闭这个终端窗口即退出。
cd "$(dirname "$0")"
export PATH="$HOME/.nvm/versions/node/$(ls "$HOME/.nvm/versions/node" 2>/dev/null | tail -1)/bin:/opt/homebrew/bin:/usr/local/bin:$PATH"
if ! command -v node >/dev/null; then
  echo "没有找到 Node.js，请先安装：https://nodejs.org"; read -r; exit 1
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
  if curl -s -m 2 "$URL/api/info" | grep -qF "\"root\":\"$HERE\""; then
    # 就是这一份：只打开界面
    echo "唱歌学日语 已在运行，直接打开界面。"
    open_ui
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
# 退出码 75 = 程序请求重启（更新到新版时用）：在同一个窗口里重新启动
while true; do
  PORT="$PORT" node server/index.js
  [ $? -eq 75 ] || break
  echo "—— 正在重启到新版本 ——"
done
