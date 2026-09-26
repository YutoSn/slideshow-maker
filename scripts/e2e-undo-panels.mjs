// 元に戻す / やり直すと、全体の設定・このカットだけの設定の分離を確認する。
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const photos = readdirSync('assets/demo-photos')
  .filter((f) => f.endsWith('.jpg'))
  .map((f) => resolve('assets/demo-photos', f));
const audio = resolve('assets/demo-audio', readdirSync('assets/demo-audio')[0]);

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://127.0.0.1:5173/');
await page.setInputFiles('input[type=file][multiple]', photos);
await page.setInputFiles('input[type=file][accept="audio/*"]', audio);
await page.waitForSelector('.segments .segment', { timeout: 120000 });
await page.waitForTimeout(300);

let failed = false;
const expect = (label, actual, wanted) => {
  const ok = actual === wanted;
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${label}: ${actual}${ok ? '' : ` (期待: ${wanted})`}`);
};

const undoButton = page.locator('.history button', { hasText: '元に戻す' });
const redoButton = page.locator('.history button', { hasText: 'やり直す' });
const undo = async () => {
  await undoButton.click();
  await page.waitForTimeout(150);
};
const redo = async () => {
  await redoButton.click();
  await page.waitForTimeout(150);
};
const cutLength = async () =>
  (await page.textContent('.panel--cut .cut__field b'))?.trim().split(' ')[0];

// --- 全体と個別の分離 ---
expect('全体パネルに個別の操作が無い', await page.locator('.panel--global button:has-text("1 拍")').count(), 0);
expect('全体パネルに対象カット数', (await page.textContent('.global__scope'))?.includes('カット共通'), true);
expect('読み込み直後は元に戻せない', await undoButton.isDisabled(), true);

await page.locator('.segments .segment').nth(2).click();
await page.waitForTimeout(150);
expect('このカットだけのパネルが出る', await page.locator('.panel--cut').count(), 1);
expect('パネルの対象はカット 3', (await page.textContent('.panel--cut .stage__badge'))?.trim(), 'カット 3');

// --- 1 回の操作を戻す・やり直す ---
const base = await cutLength();
await page.click('.panel--cut button:has-text("+ 1 拍")');
await page.waitForTimeout(150);
const longer = await cutLength();
expect('+1 拍で長くなる', Number(longer), Number(base) + 1);
await undo();
expect('元に戻すと元の拍数', await cutLength(), base);
await redo();
expect('やり直すと再び +1', await cutLength(), longer);

// --- 別々の操作は別々に戻る ---
await page.click('.panel--cut button:has-text("+ 1 拍")');
await page.waitForTimeout(150);
expect('さらに +1 拍', Number(await cutLength()), Number(base) + 2);
await undo();
expect('1 回戻すと +1 の状態', await cutLength(), longer);
await undo();
expect('もう 1 回戻すと元どおり', await cutLength(), base);

// --- 個別設定が全体の設定より優先されていることの表示 ---
await page.selectOption('.panel--cut label:has-text("収め方") select', 'contain');
await page.waitForTimeout(150);
const note = await page.textContent('.field:has(span:text-is("写真の収め方（全体）")) .overridden').catch(() => null);
expect('全体の欄に「1 カットは個別設定が優先」', note?.trim(), '1 カットは個別設定が優先');
await undo();
expect(
  '戻すと優先表示が消える',
  await page.locator('.field:has(span:text-is("写真の収め方（全体）")) .overridden').count(),
  0,
);

// --- スライダーのドラッグは 1 回ぶんにまとまる ---
const slider = page.locator('.panel--global .field:has-text("周辺を暗くする") input[type=range]');
const before = await slider.inputValue();
await slider.scrollIntoViewIfNeeded();
const box = await slider.boundingBox();
await page.mouse.move(box.x + box.width * 0.2, box.y + box.height / 2);
await page.mouse.down();
for (let i = 1; i <= 12; i++) {
  await page.mouse.move(box.x + box.width * (0.2 + i * 0.05), box.y + box.height / 2);
  await page.waitForTimeout(40);
}
await page.mouse.up();
await page.waitForTimeout(150);
const dragged = await slider.inputValue();
console.log(`     ドラッグ: ${before} → ${dragged}`);
expect('ドラッグで値が変わる', dragged !== before, true);
await undo();
expect('ドラッグ全体が 1 回で戻る', await slider.inputValue(), before);

// --- キーボード / BPM ---
const bpm = () => page.inputValue('.bpm input');
const bpmBefore = await bpm();
await page.click('button[aria-label="BPM を 1 上げる"]');
await page.waitForTimeout(150);
await page.locator('.panel--stage .transport').click({ position: { x: 5, y: 5 } });
await page.keyboard.press('Control+z');
await page.waitForTimeout(150);
expect('Ctrl+Z で BPM が戻る', await bpm(), bpmBefore);
await page.keyboard.press('Control+Shift+z');
await page.waitForTimeout(150);
expect('Ctrl+Shift+Z でやり直す', Number(await bpm()), Number(bpmBefore) + 1);
await page.keyboard.press('Control+z');
await page.waitForTimeout(150);

// --- 写真の割り当て ---
await page.locator('.segments .segment').nth(1).click();
await page.waitForTimeout(150);
const thumb = () => page.locator('.segments .segment').nth(1).locator('img').getAttribute('src');
const thumbBefore = await thumb();
await page.locator('.tray__assign').nth(9).click();
await page.waitForTimeout(200);
expect('写真を割り当てると変わる', (await thumb()) !== thumbBefore, true);
await undo();
expect('元に戻すと元の写真', await thumb(), thumbBefore);

await page.screenshot({ path: process.env.SHOT ?? '/tmp/undo-panels.png' });
await browser.close();
if (failed) {
  console.log('FAILED');
  process.exit(1);
}
console.log('ALL OK');
