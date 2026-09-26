#!/usr/bin/env bash
# Slideshow Maker を起動する（macOS / Linux）
set -e
cd "$(dirname "$0")"

echo
echo "  ============================================"
echo "    Slideshow Maker を起動します"
echo "  ============================================"
echo

if ! command -v node >/dev/null 2>&1; then
  echo "  [!] Node.js が見つかりませんでした。"
  echo
  echo "      https://nodejs.org/ja から LTS 版をインストールしてから、"
  echo "      もう一度実行してください。"
  exit 1
fi

# 初回と、最新版を取り込んで部品が増えたときは、部品をそろえる
if ! node scripts/needs-install.cjs; then
  echo "  必要な部品をそろえます。初回は数分かかります..."
  echo
  npm install
  echo
fi

# macOS では Chrome を名指しで開く（vite が AppleScript 経由で起動する）
if [ "$(uname)" = "Darwin" ] && [ -d "/Applications/Google Chrome.app" ]; then
  export BROWSER="google chrome"
fi

echo "  ブラウザが自動で開きます。"
echo "  開かないときは http://localhost:5173/ を Chrome に貼り付けてください。"
echo
echo "  終了するときは Control + C を押します。"
echo

npm run dev -- --open
