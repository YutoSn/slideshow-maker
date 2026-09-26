// 選択中のカットとプレビューの表示がずれないこと、
// BPM を直しても選択中のカットの頭が動かないことを確認する。
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const photos = readdirSync('assets/demo-photos')
  .filter((f) => f.endsWith('.jpg'))
  .map((f) => resolve('assets/demo-photos', f));
const audio = resolve('assets/demo-audio', process.env.AUDIO_FILE ?? 'click-40s.webm');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://127.0.0.1:5173/');
await page.setInputFiles('input[type=file][multiple]', photos);
await page.setInputFiles('input[type=file][accept="audio/*"]', audio);
await page.waitForSelector('.segments .segment', { timeout: 120000 });

// プレビューに映っているカット（タイムラインで再生位置にあるカット）
const shown = () =>
  page.evaluate(() => {
    const cuts = [...document.querySelectorAll('.segments .segment')];
    return `カット ${cuts.findIndex((el) => el.classList.contains('segment--active')) + 1}`;
  });
// 「このカットだけ」の調整が効くカット
const picked = async () => (await page.textContent('.panel--cut .stage__badge'))?.trim();
let failed = false;
const expect = (label, actual, wanted) => {
  const ok = actual === wanted;
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${label}: ${actual}${ok ? '' : ` (期待: ${wanted})`}`);
};

// 1. カットをクリック → 選択もプレビューもそのカット
await page.locator('.segments .segment').nth(2).click();
await page.waitForTimeout(200);
expect('カット 3 をクリック（表示）', await shown(), 'カット 3');
expect('カット 3 をクリック（選択）', await picked(), 'カット 3');

// 2. 素材をクリックで割り当て → 次のカットへ進み、プレビューもそこへ
await page.locator('.tray__assign').nth(5).click();
await page.waitForTimeout(200);
expect('割り当て後（表示）', await shown(), 'カット 4');
expect('割り当て後（選択）', await picked(), 'カット 4');

// 3. ルーラーをクリック → 選択がその位置のカットに追従する
const ruler = page.locator('.timeline__ruler');
const box = await ruler.boundingBox();
await page.mouse.click(box.x + box.width * 0.02, box.y + 10);
await page.waitForTimeout(200);
expect('ルーラーで先頭付近へ（表示と選択が一致）', await picked(), await shown());

// 4. BPM を変えても、選択中のカットの頭は動かない
await page.locator('.segments .segment').nth(5).click();
await page.waitForTimeout(200);
const leftOf = (i) =>
  page.locator('.segments .segment').nth(i).evaluate((el) => parseFloat(el.style.left));
const before = await leftOf(5);
const lastBefore = await leftOf(9);
for (let i = 0; i < 3; i++) {
  await page.click('button[aria-label="BPM を 0.1 上げる"]');
  await page.waitForTimeout(150);
}
const after = await leftOf(5);
const lastAfter = await leftOf(9);
console.log(`     カット 6 の位置: ${before.toFixed(4)}% → ${after.toFixed(4)}%`);
console.log(`     カット 10 の位置: ${lastBefore.toFixed(4)}% → ${lastAfter.toFixed(4)}%（こちらは動く）`);
expect('BPM +0.3 で基準カットが動かない', Math.abs(before - after) < 1e-6, true);
expect('基準以外のカットは伸び縮みする', Math.abs(lastBefore - lastAfter) > 1e-4, true);
expect('BPM 変更後も選択はカット 6', await picked(), 'カット 6');

// 5. 位置の微調整
await page.click('button[aria-label="拍の位置を 10ms 遅らせる"]');
await page.waitForTimeout(150);
const nudged = await leftOf(5);
const duration = await page.evaluate(() => document.querySelector('audio').duration);
console.log(`     +10ms 後のカット 6: ${((nudged - after) / 100 * duration * 1000).toFixed(1)} ms ずれた`);
expect('+10ms で 10ms ずれる', Math.abs((nudged - after) / 100 * duration - 0.01) < 0.002, true);

await page.screenshot({ path: process.env.SHOT ?? '/tmp/selection-bpm.png' });
await browser.close();
if (failed) {
  console.log('FAILED');
  process.exit(1);
}
console.log('ALL OK');
