@echo off
chcp 65001 >nul
title 寰球智投 · Global Pulse
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo.
  echo 未检测到 Node.js。请先安装 Node.js 18 或更高版本：
  echo https://nodejs.org/
  echo.
  pause
  exit /b 1
)

rem 如果服务已经在运行，直接打开浏览器，避免重复启动导致端口冲突。
powershell -NoProfile -Command "try { $r = Invoke-WebRequest -Uri 'http://127.0.0.1:8090/api/health' -UseBasicParsing -TimeoutSec 2; if ($r.StatusCode -eq 200) { exit 0 } else { exit 1 } } catch { exit 1 }"
if not errorlevel 1 (
  echo.
  echo 服务已经在运行，正在打开 http://127.0.0.1:8090
  start "" "http://127.0.0.1:8090"
  exit /b 0
)

set OPENED=0
set FAILS=0

:loop
echo.
if "%OPENED%"=="0" (
  echo 正在启动寰球智投行情终端...
  echo 浏览器会自动打开本机地址；手机用终端里打印的局域网地址打开。
  echo 关闭本窗口即停止服务；进程意外退出会自动重启（连续失败 5 次为止）。
  echo.
  node server.js --open
  set OPENED=1
) else (
  echo 服务已重启，上次退出代码 %CODE%
  node server.js
)
set CODE=%ERRORLEVEL%
if "%CODE%"=="0" goto quit

set /a FAILS+=1
if %FAILS% GEQ 5 (
  echo.
  echo 服务连续异常退出 5 次，已停止自动重启。
  echo 请查看上面的报错与 data\crash.log。
  echo.
  pause
  exit /b 1
)
echo 5 秒后自动重启（连续失败 %FAILS% 次）...
timeout /t 5 >nul
goto loop

:quit
echo.
echo 服务已正常停止。
pause