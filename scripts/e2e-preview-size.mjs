// 画面の低いノート PC でも、プレビューが潰れずに見えることを確認する。
// 動画のカットを選ぶと「このカットだけ」に動画の調整が加わって背が高くなるので、
// その状態で測る（以前はここでプレビューの高さが 0 になっていた）。
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const photos = readdirSync('assets/demo-photos').map((f) => resolve('assets/demo-photos', f));
const videos = readdirSync('assets/demo-video').map((f) => resolve('assets/demo-video', f));
const audio = resolve('assets/demo-audio', process.env.AUDIO_FILE ?? 'click-40s.webm');

/** これより低いプレビューは「見えていない」とみなす（px） */
const MIN_PREVIEW_HEIGHT = 200;

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
let failed = false;

for (const [width, height] of [
  [1333, 718],
  [1440, 900],
  [1920, 1080],
]) {
  const page = await browser.newPage({ viewport: { width, height } });
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));
  await page.goto('http://127.0.0.1:5173/');
  await page.setInputFiles('input[type=file][multiple]', [...videos, ...photos]);
  await page.setInputFiles('input[type=file][accept="audio/*"]', audio);
  await page.waitForSelector('.segments .segment', { timeout: 120000 });

  // 動画のカットを選ぶ
  const count = await page.locator('.segments .segment').count();
  for (let i = 0; i < count; i++) {
    await page.locator('.segments .segment').nth(i).click();
    if (await page.locator('.panel--cut .trim').count()) break;
  }
  await page.waitForTimeout(300);

  const size = await page.evaluate(() => {
    const canvas = document.querySelector('canvas.stage').getBoundingClientRect();
    const cut = document.querySelector('.panel--cut')?.getBoundingClientRect();
    return {
      canvasHeight: Math.round(canvas.height),
      canvasTop: Math.round(canvas.top),
      canvasBottom: Math.round(canvas.bottom),
      cutVisible: cut ? cut.height > 0 : false,
      hasTrim: document.querySelector('.panel--cut .trim') !== null,
    };
  });
  const ok =
    size.hasTrim &&
    size.cutVisible &&
    size.canvasHeight >= MIN_PREVIEW_HEIGHT &&
    size.canvasTop >= 0 &&
    size.canvasBottom <= height;
  if (!ok) failed = true;
  console.log(
    `${ok ? 'ok  ' : 'NG  '} ${width}x${height}: プレビューの高さ ${size.canvasHeight}px` +
      `（${size.canvasTop}〜${size.canvasBottom}）／ 動画の調整あり: ${size.hasTrim}`,
  );
  await page.close();
}

await browser.close();
if (failed) {
  console.log('FAILED');
  process.exit(1);
}
console.log('PREVIEW SIZE OK');
