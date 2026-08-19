// 並べ替えと、収め方（cover / contain）＋背景の確認。
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SHOTS = process.env.SHOTS_DIR ?? '/tmp/shots';
const photos = readdirSync('assets/demo-photos')
  .filter((f) => f.endsWith('.jpg'))
  .map((f) => resolve('assets/demo-photos', f));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://127.0.0.1:5173/');
await page.setInputFiles('input[type=file][accept="image/*"]', photos);
await page.setInputFiles('input[type=file][accept="audio/*"]', resolve('assets/ohayou.mp3'));
await page.waitForSelector('.segments .segment', { timeout: 120000 });

const order = () =>
  page.$$eval('.segments .segment img', (els) =>
    els.map((el) => el.getAttribute('src').slice(-12)),
  );

// --- 並べ替え -------------------------------------------------
const before = await order();
await page.dragAndDrop('.segments .segment:nth-child(2)', '.segments .segment:nth-child(6)');
await page.waitForTimeout(400);
const after = await order();

const movedPhoto = before[1];
console.log('cut2 の写真が cut6 へ :', after[5] === movedPhoto);
console.log('間のカットが繰り上がり :', after[1] === before[2] && after[4] === before[5]);
console.log('枚数は不変             :', before.length === after.length);
// 集合として同じ（写真が消えたり増えたりしていない）
const same = [...before].sort().join() === [...after].sort().join();
console.log('写真の集合は同一       :', same);

// --- 収め方 ---------------------------------------------------
/** 画面の四隅が背景色になっているか＝余白ができているかを見る */
const cornerProbe = () =>
  page.evaluate(() => {
    const c = document.querySelector('canvas.stage');
    const ctx = c.getContext('2d');
    const px = (x, y) => Array.from(ctx.getImageData(x, y, 1, 1).data).slice(0, 3);
    return {
      topLeft: px(4, 4),
      topRight: px(c.width - 5, 4),
      centre: px(c.width >> 1, c.height >> 1),
    };
  });

// 縦長写真（4 枚目）が出るカットへ移動して比較する
await page.evaluate(() => {
  const audio = document.querySelector('audio');
  if (audio) audio.currentTime = 30;
});
await page.waitForTimeout(500);

const coverProbe = await cornerProbe();
await page.screenshot({ path: `${SHOTS}/fit-cover.png` });

// contain + 黒背景に切り替え
await page.selectOption('.field:has(span:text-is("写真の収め方（全体）")) select', 'contain');
await page.waitForTimeout(300);
await page.selectOption('.field:has(span:text-is("余白の埋め方")) select', 'black');
await page.waitForTimeout(500);
const containBlack = await cornerProbe();
await page.screenshot({ path: `${SHOTS}/fit-contain-black.png` });

// blur 背景
await page.selectOption('.field:has(span:text-is("余白の埋め方")) select', 'blur');
await page.waitForTimeout(500);
const containBlur = await cornerProbe();
await page.screenshot({ path: `${SHOTS}/fit-contain-blur.png` });

console.log('cover   四隅:', JSON.stringify(coverProbe.topLeft), JSON.stringify(coverProbe.topRight));
console.log('contain 四隅(黒):', JSON.stringify(containBlack.topLeft), JSON.stringify(containBlack.topRight));
console.log('contain 四隅(ぼかし):', JSON.stringify(containBlur.topLeft), JSON.stringify(containBlur.topRight));

const isBlack = (p) => p[0] < 12 && p[1] < 12 && p[2] < 12;
const blackCorners = isBlack(containBlack.topLeft) && isBlack(containBlack.topRight);
const blurCorners = !isBlack(containBlur.topLeft) || !isBlack(containBlur.topRight);
console.log('黒背景で余白が黒       :', blackCorners);
console.log('ぼかし背景は黒でない   :', blurCorners);

await browser.close();

if (after[5] !== movedPhoto) throw new Error('並べ替えが効いていない');
if (!same) throw new Error('並べ替えで写真の集合が変わった');
if (!blackCorners) throw new Error('contain + 黒で余白が黒になっていない');
if (!blurCorners) throw new Error('ぼかし背景が描かれていない');
console.log('FIT & REORDER OK');
