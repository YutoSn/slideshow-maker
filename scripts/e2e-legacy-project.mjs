// 古い版で保存したプロジェクト（あとから足した設定を持たない）を
// 復元しても、画面が消えずに使える状態になることを確かめる。
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SHOTS = process.env.SHOTS_DIR ?? '/tmp/shots';
const photos = readdirSync('assets/demo-photos')
  .filter((f) => f.endsWith('.jpg'))
  .slice(0, 6)
  .map((f) => resolve('assets/demo-photos', f));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const context = await browser.newContext({ viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));

await page.goto('http://127.0.0.1:5173/');
await page.setInputFiles('input[type=file][multiple]', photos);
await page.setInputFiles('input[type=file][accept="audio/*"]', resolve('assets/ohayou.mp3'));
await page.waitForSelector('.segments .segment', { timeout: 120000 });
await page.click('.panel:has-text("プロジェクト") button.primary');
await page.waitForTimeout(1500);

// あとから足した設定項目を削って、古い保存を再現する
const removed = await page.evaluate(async () => {
  const db = await new Promise((res, rej) => {
    const r = indexedDB.open('slideshow-maker');
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
  const all = await new Promise((res) => {
    const r = db.transaction('projects', 'readonly').objectStore('projects').getAll();
    r.onsuccess = () => res(r.result);
  });
  const project = all[0];
  const dropped = [];
  for (const key of ['shake', 'vignette', 'filter', 'fit', 'background', 'backgroundColor']) {
    if (key in project.settings) {
      delete project.settings[key];
      dropped.push(key);
    }
  }
  await new Promise((res) => {
    const r = db.transaction('projects', 'readwrite').objectStore('projects').put(project);
    r.onsuccess = () => res();
  });
  db.close();
  return dropped;
});
console.log('削った設定項目:', removed.join(', '));

errors.length = 0;
await page.reload();
await page.waitForSelector('.segments .segment', { timeout: 60000 });
await page.waitForTimeout(1200);

const state = await page.evaluate(() => {
  const canvas = document.querySelector('canvas.stage');
  const ctx = canvas?.getContext('2d');
  // 画が出ているか（真っ黒でないか）を数点で見る
  const points = ctx
    ? [
        [100, 100],
        [canvas.width >> 1, canvas.height >> 1],
        [canvas.width - 100, canvas.height - 100],
      ].map(([x, y]) => {
        const d = ctx.getImageData(x, y, 1, 1).data;
        return d[0] + d[1] + d[2];
      })
    : [];
  return {
    mounted: (document.getElementById('root')?.children.length ?? 0) > 0,
    crashed: !!document.querySelector('.crash'),
    hasCanvas: !!canvas,
    cuts: document.querySelectorAll('.segments .segment').length,
    brightness: points,
    restored: !!document.querySelector('.notice--info'),
  };
});

console.log('復元後:', JSON.stringify(state));
console.log('エラー:', errors.length ? errors[0] : 'なし');
await page.screenshot({ path: `${SHOTS}/legacy-project.jpg`, type: 'jpeg', quality: 74 });
await browser.close();

if (!state.mounted) throw new Error('画面が消えている（React がアンマウントされた）');
if (state.crashed) throw new Error('エラー画面になっている');
if (!state.hasCanvas) throw new Error('プレビューが無い');
if (state.cuts === 0) throw new Error('カットが復元されていない');
if (state.brightness.every((v) => v < 24)) throw new Error('プレビューが真っ暗');
if (errors.length) throw new Error(`実行時エラー: ${errors[0]}`);
console.log('LEGACY PROJECT OK');
