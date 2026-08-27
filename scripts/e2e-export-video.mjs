// 書き出した動画の中で、動画クリップのコマが実際に動いているかを確かめる。
// 止まったコマのまま録画されていた不具合の再発を防ぐ。
import { chromium } from 'playwright';
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SHOTS = process.env.SHOTS_DIR ?? '/tmp/shots';
const OUT = 'out';
mkdirSync(OUT, { recursive: true });

const photos = readdirSync('assets/demo-photos')
  .filter((f) => f.endsWith('.jpg'))
  .slice(0, 2)
  .map((f) => resolve('assets/demo-photos', f));
const clip = resolve('assets/demo-video', 'clip-a.webm');
const audio = resolve('assets/demo-audio', 'click-10s.webm');

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://127.0.0.1:5173/');
await page.setInputFiles('input[type=file][multiple]', [...photos, clip]);
await page.setInputFiles('input[type=file][accept="audio/*"]', audio);
await page.waitForSelector('.segments .segment', { timeout: 120000 });
await page.waitForTimeout(600);

// 全カットに動画を割り当てて、どこを見ても動画になるようにする
const cuts = await page.$$eval('.segments .segment', (e) => e.length);
for (let i = 1; i <= cuts; i++) {
  await page.click(`.segments .segment:nth-child(${i})`);
  await page.click('.tray__item:nth-child(3) .tray__assign');
}
await page.waitForTimeout(500);
console.log('カット数:', cuts, '（すべて動画）');

await page.selectOption('.transport__quality', 'light');
const downloaded = page.waitForEvent('download', { timeout: 5 * 60 * 1000 });
await page.click('button.primary:has-text("動画を書き出す")');
console.log('書き出し中…');
await downloaded;
const file = resolve(OUT, 'export-video-test.webm');
await (await downloaded).saveAs(file);
console.log('書き出しました:', file);

// 書き出した動画を再生して、コマが変化しているか見る
await page.route('**/exported.webm', (route) =>
  route.fulfill({ status: 200, contentType: 'video/webm', body: readFileSync(file) }),
);
const result = await page.evaluate(async () => {
  const blob = await (await fetch('/exported.webm')).blob();
  const video = document.createElement('video');
  video.src = URL.createObjectURL(blob);
  video.muted = true;
  document.body.appendChild(video);
  await new Promise((r) => (video.onloadedmetadata = r));

  const canvas = document.createElement('canvas');
  canvas.width = 160;
  canvas.height = 90;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const seekTo = (t) =>
    new Promise((res) => {
      video.onseeked = () => res();
      video.currentTime = t;
    });

  const samples = [];
  for (const t of [1.5, 2.5, 3.5, 4.5, 5.5, 6.5]) {
    if (t > video.duration) break;
    await seekTo(t);
    await new Promise((r) => setTimeout(r, 200));
    ctx.drawImage(video, 0, 0, 160, 90);
    // 1 点だけだと判断しにくいので、数点の平均を取る
    const points = [
      [40, 30],
      [80, 45],
      [120, 60],
    ].map(([x, y]) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3));
    samples.push(points);
  }
  return { duration: +video.duration.toFixed(2), samples };
});

console.log('書き出した動画の長さ:', result.duration);
console.log(
  '各時点の色       :',
  result.samples.map((p) => p[1].join(',')).join(' | '),
);

/**
 * 動画の圧縮でわずかに値がぶれるため、「文字列が違う＝別のコマ」では
 * 判定できない（止まったコマでも ±2 くらいは動く）。
 * どれだけ離れているかで見る。
 */
let spread = 0;
for (let i = 0; i < result.samples.length; i++) {
  for (let j = i + 1; j < result.samples.length; j++) {
    for (let p = 0; p < result.samples[i].length; p++) {
      const a = result.samples[i][p];
      const b = result.samples[j][p];
      const distance = Math.max(
        Math.abs(a[0] - b[0]),
        Math.abs(a[1] - b[1]),
        Math.abs(a[2] - b[2]),
      );
      if (distance > spread) spread = distance;
    }
  }
}
console.log('色の開き（最大） :', spread, '（20 未満なら止まっているとみなす）');

await browser.close();

if (result.samples.length < 4) throw new Error('サンプルが取れていない');
if (spread < 20) {
  throw new Error(`書き出した動画の中で、動画クリップが止まっている（色の開き ${spread}）`);
}
console.log('EXPORTED VIDEO OK');
