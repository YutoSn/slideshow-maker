// 新しく作ったプロジェクトが、手で「保存」を押さなくても自動保存されることを確認する。
// 以前は一度「保存」を押すまで自動保存されず、再読み込みで作業が消えていた。
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const photos = readdirSync('assets/demo-photos')
  .filter((f) => f.endsWith('.jpg'))
  .slice(0, 6)
  .map((f) => resolve('assets/demo-photos', f));
const audio = resolve('assets/demo-audio', process.env.AUDIO_FILE ?? 'click-40s.webm');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

let failed = false;
const expect = (label, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${label}${detail ? `: ${detail}` : ''}`);
};

await page.goto('http://127.0.0.1:5173/');
await page.setInputFiles('input[type=file][multiple]', photos);
await page.setInputFiles('input[type=file][accept="audio/*"]', audio);
await page.waitForSelector('.segments .segment', { timeout: 120000 });

// 「保存」は押さずに編集だけする
await page.locator('.segments .segment').nth(1).click();
await page.click('.panel--cut button:has-text("+ 1 拍")');
await page.waitForTimeout(3000);

const status = (await page.textContent('.panel:has-text("プロジェクト") .muted'))?.trim();
const name = await page.inputValue('.panel:has-text("プロジェクト") input');
expect('保存を押さなくても自動保存される', status?.includes('保存') && !status.includes('未保存'), status);
expect('名前に作った日時が入る', name.startsWith('無題のプロジェクト（'), name);

// 再読み込みすると、編集した状態で戻ってくる
await page.reload();
await page.waitForSelector('.segments .segment', { timeout: 120000 });
await page.waitForTimeout(500);
const restored = (await page.textContent('.notice--info').catch(() => ''))?.trim() ?? '';
const beats = await page.locator('.segments .segment').nth(1).getAttribute('title');
expect('再読み込みで復元される', restored.includes('復元しました'), restored);
expect('編集内容も残っている', beats?.includes('9 拍'), beats ?? '');

await browser.close();
if (failed) {
  console.log('FAILED');
  process.exit(1);
}
console.log('AUTOSAVE OK');
