// マニュアルを組み立てる。
//   docs/manual-style.html  … 見た目
//   docs/manual-body.html   … 本文（{{img:名前}} が画像の差し込み位置）
//   docs/manual-shots.json  … make-manual-shots.mjs が撮った画像（data URI）
// → public/manual.html（単体で開ける 1 ファイル）
import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const style = readFileSync('docs/manual-style.html', 'utf8');
const body = readFileSync('docs/manual-body.html', 'utf8');

if (!existsSync('docs/manual-shots.json')) {
  console.error('docs/manual-shots.json がありません。');
  console.error('先に `npm run dev` を起動して `node scripts/make-manual-shots.mjs` を実行してください。');
  process.exit(1);
}
const shots = JSON.parse(readFileSync('docs/manual-shots.json', 'utf8'));

const missing = [];
const filled = body.replace(/\{\{img:([\w-]+)\}\}/g, (_, name) => {
  if (!shots[name]) {
    missing.push(name);
    return '';
  }
  return shots[name];
});

if (missing.length) {
  console.error(`画像が見つかりません: ${missing.join(', ')}`);
  process.exit(1);
}

const unused = Object.keys(shots).filter((name) => !body.includes(`{{img:${name}}}`));
if (unused.length) console.warn(`本文で使われていない画像: ${unused.join(', ')}`);

const html = `<!doctype html>
<html lang="ja">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Slideshow Maker 使い方マニュアル</title>
${style}
</head>
<body>
${filled}
</body>
</html>
`;

writeFileSync('public/manual.html', html);
console.log(`public/manual.html を書き出しました（${(html.length / 1024).toFixed(0)} KB）`);

// アーティファクトとして公開する用（外側のタグは向こうで付く）
const fragment = `<title>Slideshow Maker</title>\n${style}\n${filled}\n`;
writeFileSync('docs/manual-artifact.html', fragment);
console.log(`docs/manual-artifact.html を書き出しました（${(fragment.length / 1024).toFixed(0)} KB）`);
