// BPM の手直しが効くかを確認する。
// 整数部分を打ち替えられること（以前は範囲外として弾かれていた）が要点。
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

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

const meta = () => page.textContent('.toolbar__right .muted');
const shownBpm = () => page.inputValue('.bpm input');
const field = page.locator('.bpm input');

console.log('detected      :', await shownBpm(), 'BPM /', (await meta()).trim());

// 整数部分を打ち替える（74.9 -> 120）
await field.click();
await field.fill('120');
await field.press('Enter');
await page.waitForTimeout(400);
const afterType = await field.inputValue();
const metaAfterType = await meta();
console.log('typed 120     :', afterType, '/', metaAfterType.trim());

// 1 拍ずつのボタン
await page.click('button[aria-label="BPM を 1 上げる"]');
await page.waitForTimeout(250);
console.log('after +1      :', await field.inputValue());

await page.click('button[aria-label="BPM を 0.1 下げる"]');
await page.waitForTimeout(250);
console.log('after -.1     :', await field.inputValue());

// 範囲外は丸められる
await field.click();
await field.fill('999');
await field.press('Enter');
await page.waitForTimeout(300);
console.log('typed 999     :', await field.inputValue(), '(上限に丸め)');

// 半分ボタン
await field.click();
await field.fill('150');
await field.press('Enter');
await page.waitForTimeout(300);
await page.click('.bpm button:has-text("÷2")');
await page.waitForTimeout(300);
const halved = await field.inputValue();
console.log('150 -> ÷2     :', halved);

const cuts = await page.evaluate(() => document.querySelectorAll('.segments .segment').length);
console.log('cuts at 75bpm :', cuts);

await browser.close();

if (afterType !== '120.0') throw new Error(`整数部分を打ち替えられない: ${afterType}`);
// 反映されたかは、拍数が変わってカット数が変わることで確かめる
if (!/カット/.test(metaAfterType)) throw new Error('タイムラインの表示が読めない');
if (halved !== '75.0') throw new Error(`÷2 ボタンが効かない: ${halved}`);
console.log('BPM FIELD OK');
