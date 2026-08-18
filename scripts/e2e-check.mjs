// 実ブラウザでアプリ全体を通し、素材読み込み→解析→セグメント生成→描画を確認する。
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SHOTS = process.env.SHOTS_DIR ?? '/tmp/shots';
const photos = readdirSync('assets/demo-photos')
  .filter((f) => f.endsWith('.jpg'))
  .map((f) => resolve('assets/demo-photos', f));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
page.on('console', (m) => m.type() === 'error' && console.log('[console.error]', m.text()));

await page.goto('http://127.0.0.1:5173/');
await page.waitForSelector('.dropzone');

// 写真と音源を投入
await page.setInputFiles('input[type=file][accept="image/*"]', photos);
await page.setInputFiles('input[type=file][accept="audio/*"]', resolve('assets/ohayou.mp3'));

// 解析完了（タイムラインの描画）を待つ
await page.waitForSelector('.segments .segment', { timeout: 120000 });
await page.waitForTimeout(500);

const summary = await page.evaluate(() => ({
  segments: document.querySelectorAll('.segments .segment').length,
  status: document.querySelector('.status')?.textContent?.trim(),
  meta: document.querySelector('.panel__head .muted')?.textContent?.trim(),
}));
console.log('summary:', JSON.stringify(summary));

await page.screenshot({ path: `${SHOTS}/01-loaded.png` });

// 曲の各所へシークして、実際に別々の画が描かれることを確認
const canvasHashes = [];
for (const [i, t] of [4, 40, 95, 150, 220].entries()) {
  await page.evaluate((time) => {
    const audio = document.querySelector('audio');
    if (audio) audio.currentTime = time;
  }, t);
  await page.waitForTimeout(700);
  await page.screenshot({ path: `${SHOTS}/1${i}-t${t}s.png`, clip: { x: 0, y: 0, width: 1500, height: 1000 } });
  canvasHashes.push(
    await page.evaluate(() => {
      const c = document.querySelector('canvas.stage');
      return c.toDataURL('image/jpeg', 0.4).slice(-64);
    }),
  );
}
const unique = new Set(canvasHashes).size;
console.log(`distinct frames across 5 seek points: ${unique}/5`);

// 再生が実際に進むか
await page.click('canvas.stage');
await page.waitForTimeout(2500);
const advanced = await page.evaluate(() => document.querySelector('audio')?.currentTime ?? 0);
console.log('playhead after 2.5s of playback:', advanced.toFixed(2));

await page.screenshot({ path: `${SHOTS}/02-playing.png` });
await browser.close();

if (summary.segments < 10) throw new Error('セグメントが生成されていない');
if (unique < 5) throw new Error('シーク位置ごとに描画が変わっていない');
console.log('E2E OK');
