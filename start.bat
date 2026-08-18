@echo off
chcp 65001 >nul
cd /d "%~dp0"
title Slideshow Maker

echo.
echo   ============================================
echo     Slideshow Maker を起動します
echo   ============================================
echo.

where node >nul 2>nul
if errorlevel 1 (
  echo   [!] Node.js が見つかりませんでした。
  echo.
  echo       https://nodejs.org/ja を開き、左側の「LTS」版を
  echo       ダウンロードしてインストールしてください。
  echo       そのあと、もう一度この start.bat をダブルクリックします。
  echo.
  pause
  exit /b 1
)

if not exist node_modules (
  echo   初回のみ、必要な部品をそろえます。数分かかります...
  echo.
  call npm install
  if errorlevel 1 (
    echo.
    echo   [!] 準備に失敗しました。インターネット接続を確認して、
    echo       もう一度お試しください。
    pause
    exit /b 1
  )
  echo.
)

rem Chrome が見つかれば Chrome で開く。無ければ既定のブラウザで開く。
if exist "%ProgramFiles%\Google\Chrome\Application\chrome.exe" (
  set "BROWSER=%ProgramFiles%\Google\Chrome\Application\chrome.exe"
) else if exist "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe" (
  set "BROWSER=%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe"
) else if exist "%LocalAppData%\Google\Chrome\Application\chrome.exe" (
  set "BROWSER=%LocalAppData%\Google\Chrome\Application\chrome.exe"
)

echo   ブラウザが自動で開きます。
echo   開かないときは、下に表示される http://localhost:5173/ を
echo   Chrome のアドレス欄に貼り付けてください。
echo.
echo   終了するときは、この黒い画面で Ctrl + C を押します。
echo.

call npm run dev -- --open

echo.
echo   サーバーを終了しました。
pause
