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
( sleep 1.5
  if [ -d "/Applications/Google Chrome.app" ]; then
    open -na "Google Chrome" --args --app="$URL" --window-size=1100,680
  else
    open "$URL"
  fi ) &
PORT="$PORT" node server/index.js
