// マニュアル用のスクリーンショットを、実際のアプリを操作しながら撮る。
// 出力は data URI の JSON。build-manual.mjs がこれをテンプレートに埋め込む。
import { chromium } from 'playwright';
import { readdirSync, writeFileSync, mkdirSync } from 'node:fs';
import { resolve, dirname } from 'node:path';

const OUT = process.env.OUT ?? 'docs/manual-shots.json';
const photos = readdirSync('assets/demo-photos')
  .filter((f) => f.endsWith('.jpg'))
  .map((f) => resolve('assets/demo-photos', f));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({
  viewport: { width: 1440, height: 1000 },
  deviceScaleFactor: 1.5,
});
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://127.0.0.1:5173/');
await page.setInputFiles('input[type=file][accept="image/*"]', photos);
await page.setInputFiles('input[type=file][accept="audio/*"]', resolve('assets/ohayou.mp3'));
await page.waitForSelector('.segments .segment', { timeout: 120000 });
await page.fill('.panel:has-text("プロジェクト") input[type=text]', '2026 夏休み');
await page.waitForTimeout(600);

/** 番号付きの吹き出しを画面に重ねる。撮影後に消す。 */
async function annotate(marks) {
  await page.evaluate((items) => {
    const layer = document.createElement('div');
    layer.id = '__notes';
    layer.style.cssText = 'position:fixed;inset:0;z-index:9999;pointer-events:none';
    document.body.appendChild(layer);

    for (const { selector, label, at = 'top-left', dx = 0, dy = 0 } of items) {
      const el = document.querySelector(selector);
      if (!el) continue;
      const r = el.getBoundingClientRect();

      const ring = document.createElement('div');
      ring.style.cssText = `position:absolute;left:${r.left - 3}px;top:${r.top - 3}px;
        width:${r.width + 6}px;height:${r.height + 6}px;border:2px solid #6ea8ff;
        border-radius:10px;box-shadow:0 0 0 3px rgba(110,168,255,.18)`;
      layer.appendChild(ring);

      const badge = document.createElement('div');
      const x = at.includes('right') ? r.right - 14 : r.left - 14;
      const y = at.includes('bottom') ? r.bottom - 14 : r.top - 14;
      badge.textContent = label;
      badge.style.cssText = `position:absolute;left:${x + dx}px;top:${y + dy}px;
        min-width:26px;height:26px;padding:0 7px;border-radius:13px;background:#6ea8ff;
        color:#08111f;font:700 14px/26px system-ui,sans-serif;text-align:center;
        box-shadow:0 2px 8px rgba(0,0,0,.5)`;
      layer.appendChild(badge);
    }
  }, marks);
}

async function clearNotes() {
  await page.evaluate(() => document.getElementById('__notes')?.remove());
}

const shots = {};

async function shot(name, selector, marks = []) {
  if (marks.length) await annotate(marks);
  await page.waitForTimeout(250);
  const target = selector ? page.locator(selector) : page;
  const buffer = await target.screenshot({ type: 'jpeg', quality: 76 });
  shots[name] = `data:image/jpeg;base64,${buffer.toString('base64')}`;
  await clearNotes();
  console.log(`${name}: ${(buffer.length / 1024).toFixed(0)} KB`);
}

// --- 画面全体の見取り図 -------------------------------------------
await page.evaluate(() => window.scrollTo(0, 0));
await shot('overview', null, [
  { selector: '.app__side .panel:nth-child(1)', label: '1' },
  { selector: '.app__side .panel:nth-child(2)', label: '2' },
  { selector: '.app__side .panel:nth-child(3)', label: '3' },
  { selector: '.panel--stage', label: '4', at: 'top-right' },
  { selector: '.app__main .panel:nth-child(2)', label: '5', at: 'top-right' },
  { selector: '.app__manual', label: '6', at: 'top-right', dx: 10 },
]);

// --- 写真プール ---------------------------------------------------
await shot('pool', '.app__side .panel:nth-child(2)', [
  { selector: '.dropzone', label: '1' },
  { selector: '.hint', label: '2' },
  { selector: '.tray', label: '3' },
]);

// --- タイムライン -------------------------------------------------
await page.click('.segments .segment:nth-child(6)');
await page.waitForTimeout(300);
await shot('timeline', '.app__main .panel:nth-child(2)', [
  { selector: '.timeline', label: '2' },
  { selector: '.segments', label: '3' },
  { selector: '.bpm', label: '1' },
  { selector: '.zoom__controls', label: '4', at: 'top-right', dx: 10 },
]);

// --- プレビューのドラッグ -----------------------------------------
await page.evaluate(() => {
  const stage = document.querySelector('canvas.stage');
  const r = stage.getBoundingClientRect();
  const layer = document.createElement('div');
  layer.id = '__notes';
  layer.style.cssText = 'position:fixed;inset:0;z-index:9999;pointer-events:none';
  const cx = r.left + r.width / 2;
  const cy = r.top + r.height / 2;
  layer.innerHTML = `
    <svg style="position:absolute;left:0;top:0;width:100vw;height:100vh">
      <defs><marker id="a" markerWidth="9" markerHeight="9" refX="7" refY="4.5" orient="auto">
        <path d="M0,0 L9,4.5 L0,9 z" fill="#6ea8ff"/></marker></defs>
      <line x1="${cx - 130}" y1="${cy}" x2="${cx + 130}" y2="${cy}"
        stroke="#6ea8ff" stroke-width="4" marker-end="url(#a)" marker-start="url(#a)"/>
      <circle cx="${cx}" cy="${cy}" r="13" fill="#6ea8ff"/>
    </svg>`;
  document.body.appendChild(layer);
});
await shot('preview', '.panel--stage');

// --- 収め方の比較 -------------------------------------------------
await page.evaluate(() => {
  const audio = document.querySelector('audio');
  if (audio) audio.currentTime = 22;
});
await page.waitForTimeout(500);
await shot('fitCover', 'canvas.stage');

await page.selectOption('.field:has(span:text-is("写真の収め方（全体）")) select', 'contain');
await page.waitForTimeout(600);
await shot('fitContain', 'canvas.stage');

await page.selectOption('.field:has(span:text-is("余白の埋め方")) select', 'black');
await page.waitForTimeout(600);
await shot('fitBlack', 'canvas.stage');

await page.selectOption('.field:has(span:text-is("余白の埋め方")) select', 'blur');
await page.selectOption('.field:has(span:text-is("写真の収め方（全体）")) select', 'cover');
await page.waitForTimeout(400);

// --- 見せ方の設定 -------------------------------------------------
await page.evaluate(() => { document.querySelector('.app__side').scrollTop = 0; });
await shot('settings', '.app__side .panel:nth-child(3)');

// --- プロジェクト -------------------------------------------------
await shot('project', '.app__side .panel:nth-child(1)');

// --- 書き出し -----------------------------------------------------
await shot('export', '.transport', [
  { selector: '.transport__quality', label: '1' },
  { selector: '.transport button.primary', label: '2', at: 'top-right', dx: 8 },
]);

mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, JSON.stringify(shots, null, 0));
const total = Object.values(shots).reduce((n, v) => n + v.length, 0);
console.log(`\nwrote ${Object.keys(shots).length} shots to ${OUT} (${(total / 1024).toFixed(0)} KB of data URI)`);

await browser.close();
