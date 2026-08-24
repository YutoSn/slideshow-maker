// スマホ相当の条件（狭い画面・CPU 4 倍遅い）で、1 フレームにかかる時間を測る。
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const photos = readdirSync('assets/demo-photos')
  .filter((f) => f.endsWith('.jpg'))
  .map((f) => resolve('assets/demo-photos', f));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  deviceScaleFactor: 3,
  isMobile: true,
  hasTouch: true,
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const cdp = await context.newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: Number(process.env.THROTTLE ?? 4) });

await page.goto('http://127.0.0.1:5173/');
await page.setInputFiles('input[type=file][multiple]', photos);
await page.setInputFiles('input[type=file][accept="audio/*"]', resolve('assets/ohayou.mp3'));
await page.waitForSelector('.segments .segment', { timeout: 180000 });
await page.waitForTimeout(1000);

/**
 * 実際に再生して、フレーム間隔を測る。
 * canvas の描画は GPU 側に回るので、関数の所要時間を測っても意味がない。
 * requestAnimationFrame の間隔で見るのが実態に近い。
 */
const measure = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const audio = document.querySelector('audio');
        audio.currentTime = 20;
        void audio.play();

        const deltas = [];
        let last = performance.now();
        const started = last;

        const tick = (now) => {
          deltas.push(now - last);
          last = now;
          if (now - started < 4000) requestAnimationFrame(tick);
          else {
            audio.pause();
            deltas.shift();
            deltas.sort((a, b) => a - b);
            const mid = deltas[Math.floor(deltas.length / 2)];
            const p95 = deltas[Math.floor(deltas.length * 0.95)];
            const canvas = document.querySelector('canvas.stage');
            resolve({
              fps: +(1000 / mid).toFixed(1),
              medianMs: +mid.toFixed(1),
              p95Ms: +p95.toFixed(1),
              janky: deltas.filter((d) => d > 33).length,
              frames: deltas.length,
              canvas: `${canvas.width}x${canvas.height}`,
            });
          }
        };
        requestAnimationFrame(tick);
      }),
  );

const cover = await measure();
console.log('画面いっぱい :', JSON.stringify(cover));

await page.selectOption('.field:has(span:text-is("写真の収め方（全体）")) select', 'contain');
await page.waitForTimeout(500);
const blur = await measure();
console.log('全体+ぼかし  :', JSON.stringify(blur));

// タイムラインの DOM 量
const dom = await page.evaluate(() => ({
  segments: document.querySelectorAll('.segments .segment').length,
  images: document.querySelectorAll('.segments img').length,
  total: document.querySelectorAll('*').length,
}));
console.log('DOM          :', JSON.stringify(dom));

await browser.close();
