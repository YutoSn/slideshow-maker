// 起動スクリプト（start.bat / start.sh）から呼ぶ。
// 部品（node_modules）を入れ直す必要があれば終了コード 1 を返す。
//
// 最新版を取り込むと、新しい部品が増えていることがある。node_modules が
// あるだけで済ませると足りない部品のまま起動してしまうので、部品の一覧
// （package-lock.json）が前回のインストールより新しければ入れ直す。
const fs = require('node:fs');

try {
  const wanted = fs.statSync('package-lock.json').mtimeMs;
  const installed = fs.statSync('node_modules/.package-lock.json').mtimeMs;
  process.exit(wanted > installed ? 1 : 0);
} catch {
  // node_modules が無い、または途中で止まったインストール
  process.exit(1);
}
