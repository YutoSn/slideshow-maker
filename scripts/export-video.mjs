// アプリ本体の書き出し機能をそのまま実ブラウザで走らせ、動画ファイルを取り出す。
// MediaRecorder は実時間録画のため、曲の長さぶんかかる。
import { chromium } from 'playwright';
import { readdirSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const OUT = process.env.OUT_DIR ?? 'out';
const PHOTO_DIR = process.env.PHOTO_DIR ?? 'assets/demo-photos';
mkdirSync(OUT, { recursive: true });

const photos = readdirSync(PHOTO_DIR)
  .filter((f) => /\.(jpe?g|png)$/i.test(f))
  .map((f) => resolve(PHOTO_DIR, f));
console.log(`photos: ${photos.length}`);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://127.0.0.1:5173/');
await page.waitForSelector('.dropzone');
await page.setInputFiles('input[type=file][accept="image/*"]', photos);
await page.setInputFiles('input[type=file][accept="audio/*"]', resolve('assets/ohayou.mp3'));
await page.waitForSelector('.segments .segment', { timeout: 120000 });

console.log('meta:', await page.textContent('.toolbar__right .muted'));

const quality = process.env.QUALITY;
if (quality) {
  await page.selectOption('.transport__quality', quality);
  console.log('quality:', quality);
}

const downloadPromise = page.waitForEvent('download', { timeout: 15 * 60 * 1000 });
await page.click('button.primary');
console.log('recording started (realtime)…');

const progress = setInterval(async () => {
  try {
    const label = await page.textContent('button.primary');
    console.log(new Date().toISOString().slice(11, 19), label?.trim());
  } catch { /* ページ遷移中などは無視 */ }
}, 30000);

const download = await downloadPromise;
clearInterval(progress);

const target = resolve(OUT, 'slideshow.webm');
await download.saveAs(target);
console.log('saved:', target);

await browser.close();
