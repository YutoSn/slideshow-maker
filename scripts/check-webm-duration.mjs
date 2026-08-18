// 既存の書き出し済み WebM に Duration 補完を適用し、ヘッダを確認する。
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const file = process.argv[2] ?? 'out/slideshow.webm';
const expected = Number(process.argv[3] ?? 293.09);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:5173/');

// ファイルはページ側から fetch させ、巨大な base64 受け渡しを避ける
await page.route('**/sample.webm', (route) =>
  route.fulfill({ status: 200, contentType: 'video/webm', body: readFileSync(file) }),
);

const result = await page.evaluate(async (durationSeconds) => {
  const { fixWebmDuration } = await import('/src/engine/webmDuration.ts');
  const original = await (await fetch('/sample.webm')).blob();
  const fixed = await fixWebmDuration(original, durationSeconds);
  const head = new Uint8Array(await fixed.slice(0, 80).arrayBuffer());

  // 実際に <video> が総再生時間を読めるかを確かめる
  const video = document.createElement('video');
  video.preload = 'metadata';
  video.src = URL.createObjectURL(fixed);
  const reported = await new Promise((resolve) => {
    video.onloadedmetadata = () => resolve(video.duration);
    video.onerror = () => resolve(-1);
    setTimeout(() => resolve(-2), 15000);
  });

  return {
    originalBytes: original.size,
    fixedBytes: fixed.size,
    headHex: Array.from(head).map((b) => b.toString(16).padStart(2, '0')).join(' '),
    videoReportedDuration: reported,
  };
}, expected);

console.log('original bytes :', result.originalBytes);
console.log('fixed bytes    :', result.fixedBytes, `(+${result.fixedBytes - result.originalBytes})`);
console.log('head           :', result.headHex);
console.log('<video>.duration:', result.videoReportedDuration);

await browser.close();

if (!result.headHex.includes('44 89')) throw new Error('Duration 要素が挿入されていない');
if (Math.abs(result.videoReportedDuration - expected) > 1) {
  throw new Error(`総再生時間が想定と違う: ${result.videoReportedDuration}`);
}
console.log('WEBM DURATION OK');
