@echo off
rem Windows launcher for uta-nihongo. Double-click to start; closing this window quits the program.
chcp 65001 >nul
setlocal
cd /d "%~dp0"
title 唱歌学日语

where node >nul 2>nul
if errorlevel 1 (
  echo 没有找到 Node.js，请先安装（需要 22 或更新的版本）：https://nodejs.org
  pause
  exit /b 1
)
rem 第一次运行，或者更新后多了新的依赖（随程序带的日文字体）：装一次
set NEED_INSTALL=
if not exist node_modules set NEED_INSTALL=1
if not exist "node_modules\@fontsource-variable\noto-sans-jp" set NEED_INSTALL=1
if defined NEED_INSTALL (
  echo 正在安装依赖（第一次运行或更新后需要，要一两分钟）…
  call npm install --omit=dev --no-audit --no-fund --loglevel=error
  if errorlevel 1 (
    echo 依赖安装失败，多半是网络问题，请再运行一次。
    pause
    exit /b 1
  )
)
if "%PORT%"=="" set PORT=3939

rem 已经在运行：只把界面叫出来
curl -s -m 2 http://localhost:%PORT%/api/info 2>nul | findstr /c:"\"root\"" >nul
if not errorlevel 1 (
  echo 唱歌学日语 已在运行，显示界面。
  curl -s -m 10 -X POST http://localhost:%PORT%/api/show >nul 2>nul
  exit /b 0
)

rem 退出码 75 = 程序请求重启（换播放器、更新到新版时用）：原地重新启动
set UTA_OPEN=1
:run
node server\index.js
if %errorlevel%==75 (
  echo —— 正在重启 ——
  goto run
)
endlocal
