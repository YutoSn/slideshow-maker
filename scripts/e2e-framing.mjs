// 1) カットを選ぶとその写真がプレビューに映るか
// 2) プレビューのドラッグで見せる位置が変わるか
// 3) カットをプールの写真へ落として差し替えられるか
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
await page.setInputFiles('input[type=file][multiple]', photos);
await page.setInputFiles('input[type=file][accept="audio/*"]', resolve('assets/ohayou.mp3'));
await page.waitForSelector('.segments .segment', { timeout: 120000 });

/** プレビュー中央付近の色を、そのカットのサムネイル色と比べる */
const stageColour = () =>
  page.evaluate(() => {
    const c = document.querySelector('canvas.stage');
    const ctx = c.getContext('2d');
    const d = ctx.getImageData(c.width >> 1, 60, 1, 1).data;
    return [d[0], d[1], d[2]];
  });

// --- 1. 選んだカットがプレビューに映るか -------------------------
// 連続するカットは写真が違うので、選ぶたびに色が変わるはず
const seen = [];
for (const n of [3, 4, 5, 6]) {
  await page.click(`.segments .segment:nth-child(${n})`);
  await page.waitForTimeout(350);
  seen.push((await stageColour()).join(','));
}
console.log('カット 3..6 のプレビュー色:', seen.join(' | '));
const allDistinct = new Set(seen).size === seen.length;
console.log('選んだカットごとに違う絵が出る :', allDistinct);

// 選択中のカットのサムネイルと、プレビューが同じ写真かを直接照合する
const matches = await page.evaluate(() => {
  const selected = document.querySelector('.segments .segment--selected');
  const active = document.querySelector('.segments .segment--active');
  return { selectedSrc: selected?.querySelector('img')?.src.slice(-12),
           activeSrc: active?.querySelector('img')?.src.slice(-12) };
});
console.log('選択カット == 再生位置のカット :', matches.selectedSrc === matches.activeSrc);

// --- 2. プレビューのドラッグで位置が変わるか ---------------------
await page.click('.segments .segment:nth-child(4)');
await page.waitForTimeout(300);
const before = await stageColour();

const slack = await page.evaluate(() => {
  const c = document.querySelector('canvas.stage');
  const img = document.querySelector('.segments .segment--active img');
  return { canvas: [c.width, c.height], thumb: img?.src.slice(-12) };
});
console.log('canvas:', slack.canvas.join('x'), 'active thumb:', slack.thumb);

const box = await page.locator('canvas.stage').boundingBox();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
await page.mouse.down();
await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2 - 200, { steps: 12 });
await page.mouse.up();
await page.waitForTimeout(350);
const after = await stageColour();

const hintShown = await page.locator('.stage__hint').innerText();
const resetExists = await page.locator('.linkish').count();
console.log('ドラッグ前後の色:', before.join(','), '->', after.join(','));
console.log('位置が変わった               :', before.join(',') !== after.join(','));
console.log('リセットが出た               :', resetExists > 0);

await page.screenshot({ path: `${SHOTS}/framing.png` });

// リセットで元に戻るか
if (resetExists > 0) {
  await page.click('.linkish');
  await page.waitForTimeout(350);
  const reset = await stageColour();
  console.log('リセットで元に戻る           :', reset.join(',') === before.join(','));
}

// --- 3. カット -> プールの写真 へドロップ ------------------------
const cutBefore = await page.getAttribute('.segments .segment:nth-child(9) img', 'src');
const poolSrc = await page.getAttribute('.tray__item:nth-child(14) img', 'src');
await page.dragAndDrop('.segments .segment:nth-child(9)', '.tray__item:nth-child(14)');
await page.waitForTimeout(400);
const cutAfter = await page.getAttribute('.segments .segment:nth-child(9) img', 'src');
console.log('カット->プールで差し替わった :', cutAfter === poolSrc && cutBefore !== cutAfter);

await browser.close();

if (!allDistinct) throw new Error('カットを選んでもプレビューが切り替わらない');
if (matches.selectedSrc !== matches.activeSrc) throw new Error('選択カットとプレビューが不一致');
if (before.join(',') === after.join(',')) throw new Error('ドラッグしても位置が変わらない');
if (cutAfter !== poolSrc) throw new Error('カットをプールへ落としても差し替わらない');
console.log('FRAMING & SWAP OK');
