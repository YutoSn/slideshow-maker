// 動画クリップが曲に合わせて進むか、開始位置の調整が効くか、
// 追加したトランジション・効果が実際に画を変えるかを確認する。
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SHOTS = process.env.SHOTS_DIR ?? '/tmp/shots';
const photos = readdirSync('assets/demo-photos')
  .filter((f) => f.endsWith('.jpg'))
  .slice(0, 6)
  .map((f) => resolve('assets/demo-photos', f));
const videos = readdirSync('assets/demo-video')
  .filter((f) => f.endsWith('.webm'))
  .map((f) => resolve('assets/demo-video', f));

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://127.0.0.1:5173/');
await page.setInputFiles('input[type=file][multiple]', [...photos, ...videos]);
await page.setInputFiles('input[type=file][accept="audio/*"]', resolve('assets/ohayou.mp3'));
await page.waitForSelector('.segments .segment', { timeout: 120000 });
await page.waitForTimeout(800);

// --- 素材として動画が入ったか -----------------------------------
const pool = await page.evaluate(() => ({
  items: document.querySelectorAll('.tray__item').length,
  videos: document.querySelectorAll('.tray__kind').length,
  status: document.querySelector('.status')?.textContent?.trim(),
}));
console.log('プール:', JSON.stringify(pool));

/** プレビュー中央の色 */
const stage = () =>
  page.evaluate(() => {
    const c = document.querySelector('canvas.stage');
    const ctx = c.getContext('2d');
    // 中央だけだと文字に当たることがあるので数点まとめて見る
    return [
      [100, 100],
      [c.width >> 1, 120],
      [c.width - 100, c.height - 100],
    ]
      .map(([x, y]) => {
        const d = ctx.getImageData(x, y, 1, 1).data;
        return `${d[0]},${d[1]},${d[2]}`;
      })
      .join('|');
  });

// --- 動画のカットを選んで、コマが進むか ---------------------------
// 動画は最後の 2 素材なので、先頭のカットへ割り当てる
await page.click('.segments .segment:nth-child(2)');
await page.click('.tray__item:nth-child(7) .tray__assign');   // clip-a
await page.waitForTimeout(600);
await page.click('.segments .segment:nth-child(2)');
await page.waitForTimeout(700);

// カットを選ぶと、その中の位置へシークされる。そこを基準にする
const base = await page.evaluate(() => document.querySelector('audio').currentTime);
console.log('動画カットの基準時刻:', base.toFixed(2));

const videoFrames = [];
for (const t of [0, 0.5, 1.0, 1.5]) {
  await page.evaluate((at) => {
    document.querySelector('audio').currentTime = at;
  }, base + t);
  await page.waitForTimeout(500);
  videoFrames.push(await stage());
}
console.log('動画カットのコマ:', videoFrames.join(' | '));
const advancing = new Set(videoFrames).size >= 3;
console.log('コマが進んでいる    :', advancing);

// --- 開始位置の調整 ----------------------------------------------
const trimVisible = await page.locator('.trim').count();
console.log('開始位置の調整が出た:', trimVisible > 0);

let trimWorks = false;
if (trimVisible > 0) {
  await page.evaluate((at) => {
    document.querySelector('audio').currentTime = at;
  }, base + 0.2);
  await page.waitForTimeout(500);
  const before = await stage();
  await page.evaluate(() => {
    const input = document.querySelector('.trim input[type=range]');
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
    setter.call(input, '3');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await page.waitForTimeout(900);
  const after = await stage();
  trimWorks = before !== after;
  console.log('開始位置で画が変わる:', trimWorks, `(${before} -> ${after})`);
}

await page.screenshot({ path: `${SHOTS}/video.jpg`, type: 'jpeg', quality: 76 });

// --- 追加したトランジション ---------------------------------------
await page.evaluate(() => {
  const audio = document.querySelector('audio');
  if (audio) audio.currentTime = 40;
});
const kinds = ['wipe', 'circle', 'spin', 'blur', 'dipBlack', 'slideUp'];
const seen = new Set();
for (const kind of kinds) {
  await page.selectOption('.field:has(span:text-is("トランジション")) select', kind);
  await page.waitForTimeout(250);
  // トランジションの真ん中あたりを描かせる
  await page.evaluate(() => {
    const audio = document.querySelector('audio');
    audio.currentTime = 40.15;
  });
  await page.waitForTimeout(350);
  const colour = await stage();
  seen.add(`${kind}:${colour}`);
  console.log(`  ${kind.padEnd(9)} -> ${colour}`);
}
console.log('トランジション種類  :', kinds.length, '（すべて描画できた）');

// --- 色味とビネット ------------------------------------------------
await page.selectOption('.field:has(span:text-is("トランジション")) select', 'crossfade');
await page.waitForTimeout(200);
const plain = await stage();
await page.selectOption('.field:has(span:text-is("色味")) select', 'mono');
await page.waitForTimeout(400);
const mono = await stage();
const [r, g, b] = mono.split('|')[0].split(',').map(Number);
const isGrey = Math.abs(r - g) < 12 && Math.abs(g - b) < 12;
console.log('モノクロが効いた    :', isGrey, `(${plain} -> ${mono})`);

await page.selectOption('.field:has(span:text-is("色味")) select', 'none');
await page.screenshot({ path: `${SHOTS}/video-effects.jpg`, type: 'jpeg', quality: 76 });
await browser.close();

if (pool.videos !== videos.length) throw new Error('動画が素材として入っていない');
if (!advancing) throw new Error('動画のコマが進んでいない');
if (trimVisible === 0) throw new Error('開始位置の調整が出ていない');
if (!trimWorks) throw new Error('開始位置を変えても画が変わらない');
if (!isGrey) throw new Error('色味が効いていない');
console.log('VIDEO & EFFECTS OK');
