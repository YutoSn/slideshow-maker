// プロジェクトの保存・復元と、マニュアルへのリンクを確認する。
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SHOTS = process.env.SHOTS_DIR ?? '/tmp/shots';
const photos = readdirSync('assets/demo-photos')
  .filter((f) => f.endsWith('.jpg'))
  .map((f) => resolve('assets/demo-photos', f));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
// 同じプロファイルを使い回して、再読み込み後も IndexedDB が残る状態を再現する
const context = await browser.newContext({ viewport: { width: 1500, height: 1050 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://127.0.0.1:5173/');
await page.setInputFiles('input[type=file][multiple]', photos);
await page.setInputFiles('input[type=file][accept="audio/*"]', resolve('assets/ohayou.mp3'));
await page.waitForSelector('.segments .segment', { timeout: 120000 });

// 名前を付けて、編集も加える
await page.fill('.panel:has-text("プロジェクト") input[type=text]', 'テスト用プロジェクト');
await page.click('.segments .segment:nth-child(5)');
await page.click('.tray__item:nth-child(11) .tray__assign');
await page.waitForTimeout(300);

const assigned = await page.getAttribute('.segments .segment:nth-child(5)', 'title');
const cutCount = await page.$$eval('.segments .segment', (e) => e.length);

await page.click('.panel:has-text("プロジェクト") button.primary');
await page.waitForTimeout(1200);
console.log('保存ステータス:', (await page.textContent('.panel:has-text("プロジェクト") .muted')).trim());

await page.screenshot({ path: `${SHOTS}/project.png` });

// --- 再読み込みして復元されるか ---------------------------------
await page.reload();
await page.waitForSelector('.segments .segment', { timeout: 60000 });
await page.waitForTimeout(800);

const restoredBanner = await page.locator('.notice--info').count();
const restoredName = await page.inputValue('.panel:has-text("プロジェクト") input[type=text]');
const restoredCuts = await page.$$eval('.segments .segment', (e) => e.length);
const restoredStatus = await page.textContent('.status');
const restoredAssign = await page.getAttribute('.segments .segment:nth-child(5)', 'title');

console.log('復元の案内が出た   :', restoredBanner > 0);
console.log('名前               :', restoredName);
console.log('素材               :', restoredStatus.trim());
console.log('カット数           :', restoredCuts, '(保存前', cutCount, ')');
console.log('カット5 保存前     :', assigned);
console.log('カット5 復元後     :', restoredAssign);
console.log('割り当ても復元     :', restoredAssign === assigned);

// 音源が無いと解析できないので、復元されていればカットが出ているはず
await page.screenshot({ path: `${SHOTS}/project-restored.png` });

// --- マニュアルのリンク -----------------------------------------
const href = await page.getAttribute('.app__manual', 'href');
const target = await page.getAttribute('.app__manual', 'target');
console.log('マニュアル link    :', href, target);

const [manual] = await Promise.all([
  context.waitForEvent('page'),
  page.click('.app__manual'),
]);
await manual.waitForLoadState('domcontentloaded');
const manualTitle = await manual.title();
const hasSaveSection = await manual.locator('text=保存する・続きから再開する').count();
console.log('別タブで開いた     :', manual.url());
console.log('タイトル           :', manualTitle);
console.log('保存の説明あり     :', hasSaveSection > 0);
await manual.screenshot({ path: `${SHOTS}/manual-page.png` });

await browser.close();

if (restoredBanner === 0) throw new Error('復元されていない');
if (restoredName !== 'テスト用プロジェクト') throw new Error('名前が復元されていない');
if (restoredCuts !== cutCount) throw new Error('カットが復元されていない');
if (restoredAssign !== assigned) throw new Error('写真の割り当てが復元されていない');
if (target !== '_blank') throw new Error('マニュアルが別タブで開かない');
if (!manualTitle.includes('マニュアル')) throw new Error('マニュアルが開けていない');
console.log('PROJECT & MANUAL OK');
