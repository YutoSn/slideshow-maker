// 写真プールからカットへの割り当てが、設定変更後も残るかを確認する。
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

const cutPhoto = (n) =>
  page.getAttribute(`.segments .segment:nth-child(${n}) img`, 'src');

const before = await cutPhoto(3);

// カット 3 を選び、プールの 12 番目の写真を割り当てる
await page.click('.segments .segment:nth-child(3)');
const poolSrc = await page.getAttribute('.tray__item:nth-child(12) img', 'src');
await page.click('.tray__item:nth-child(12) .tray__assign');
await page.waitForTimeout(300);

const after = await cutPhoto(3);
console.log('cut3 changed by click-assign :', before !== after && after === poolSrc);

// クリック割り当て後に選択が次のカットへ進むか
const selectedIndex = await page.evaluate(() => {
  const all = [...document.querySelectorAll('.segments .segment')];
  return all.findIndex((el) => el.classList.contains('segment--selected')) + 1;
});
console.log('selection advanced to cut    :', selectedIndex);

// 「1 枚あたりの拍数」を変えても割り当てが残るか
await page.fill('.field input[type=range]', '6');
await page.evaluate(() => {
  const input = document.querySelector('.field input[type=range]');
  input.value = '6';
  input.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(500);
const afterRebuild = await cutPhoto(3);
console.log('assignment survived rebuild   :', afterRebuild === poolSrc);

const cutCount = await page.evaluate(() => document.querySelectorAll('.segments .segment').length);
console.log('cuts after beatsPerPhoto=6    :', cutCount);

await page.screenshot({ path: `${SHOTS}/assign.png` });
await browser.close();

if (after !== poolSrc) throw new Error('クリック割り当てが効いていない');
if (afterRebuild !== poolSrc) throw new Error('設定変更で割り当てが消えた');
console.log('ASSIGN OK');
