// タイムラインの検証。
// 上段（目盛り）に描かれた小節頭の線を canvas から読み取り、
// 下段（カット）の境界がその線と揃っているかを実測する。
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
await page.setInputFiles('input[type=file][accept="image/*"]', photos);
await page.setInputFiles('input[type=file][accept="audio/*"]', resolve('assets/ohayou.mp3'));
await page.waitForSelector('.segments .segment', { timeout: 120000 });
await page.waitForTimeout(600);

/** 小節頭の線の x 座標（CSS px）と、各カットの左端を突き合わせる。 */
const measure = () =>
  page.evaluate(() => {
    const canvas = document.querySelector('.timeline__ruler');
    const inner = document.querySelector('.timeline__inner');
    const scroll = document.querySelector('.timeline');
    const dpr = window.devicePixelRatio || 1;

    const ctx = canvas.getContext('2d');
    // 小節頭の線は上端付近まで伸びている。拍の線は下端だけなので混ざらない
    const y = Math.round(10 * dpr);
    const row = ctx.getImageData(0, y, canvas.width, 1).data;

    const lines = [];
    for (let x = 0; x < canvas.width; x++) {
      const r = row[x * 4];
      const g = row[x * 4 + 1];
      const b = row[x * 4 + 2];
      // rgba(120,200,255,0.55) を #12121a に重ねた色を拾う
      if (b > 110 && g > 80 && b - r > 45) lines.push(x / dpr);
    }

    // 隣接ピクセルはまとめて 1 本として扱う
    const merged = [];
    for (const x of lines) {
      if (merged.length && x - merged[merged.length - 1].last <= 1.5) {
        const group = merged[merged.length - 1];
        group.last = x;
        group.sum += x;
        group.n += 1;
      } else {
        merged.push({ last: x, sum: x, n: 1 });
      }
    }
    const lineXs = merged.map((g) => g.sum / g.n);

    const scrollRect = scroll.getBoundingClientRect();
    const cuts = [...document.querySelectorAll('.segments .segment')].map((el) => {
      const r = el.getBoundingClientRect();
      return {
        left: r.left - scrollRect.left + scroll.scrollLeft,
        right: r.right - scrollRect.left + scroll.scrollLeft,
      };
    });

    // 目盛りは sticky なので画面座標で描かれている。
    // カット側は内容座標なので、スクロール量を足して揃える。
    return {
      lineXs: lineXs.map((x) => x + scroll.scrollLeft),
      cuts,
      innerWidth: inner.clientWidth,
      viewWidth: scroll.clientWidth,
      scrollLeft: scroll.scrollLeft,
    };
  });

const { lineXs, cuts, innerWidth, viewWidth } = await measure();
console.log(`downbeat lines detected : ${lineXs.length}`);
console.log(`cuts                    : ${cuts.length}`);
console.log(`inner width / view width: ${innerWidth} / ${viewWidth}`);

// 各カットの左端に最も近い小節頭の線との距離
let worst = 0;
let worstIndex = -1;
cuts.forEach((cut, i) => {
  let best = Infinity;
  for (const x of lineXs) best = Math.min(best, Math.abs(x - cut.left));
  if (best > worst) {
    worst = best;
    worstIndex = i;
  }
});
console.log(`worst drift             : ${worst.toFixed(2)}px (cut ${worstIndex + 1})`);

// カット同士が隙間なく連続しているか（末尾ほど効いてくる）
let maxSeam = 0;
for (let i = 1; i < cuts.length; i++) {
  maxSeam = Math.max(maxSeam, Math.abs(cuts[i].left - cuts[i - 1].right));
}
console.log(`max seam between cuts   : ${maxSeam.toFixed(2)}px`);

await page.screenshot({ path: `${SHOTS}/timeline-fit.png` });

// 拡大してもズレないか
await page.click('button[aria-label="タイムラインを拡大"]');
await page.click('button[aria-label="タイムラインを拡大"]');
await page.waitForTimeout(500);
const zoomed = await measure();
let zoomWorst = 0;
let comparedCuts = 0;
zoomed.cuts.forEach((cut) => {
  // 画面内に見えているカットだけを見る
  const x = cut.left - zoomed.scrollLeft;
  if (x < 2 || x > zoomed.viewWidth - 2) return;
  let best = Infinity;
  for (const line of zoomed.lineXs) best = Math.min(best, Math.abs(line - cut.left));
  comparedCuts += 1;
  zoomWorst = Math.max(zoomWorst, best);
});
console.log(`cuts compared while zoomed  : ${comparedCuts}`);
console.log(`zoom ×${(zoomed.innerWidth / zoomed.viewWidth).toFixed(1)} worst drift : ${zoomWorst.toFixed(2)}px`);

await page.screenshot({ path: `${SHOTS}/timeline-zoom.png` });
await browser.close();

if (lineXs.length < 10) throw new Error('小節頭の線を読み取れていない');
if (worst > 1.5) throw new Error(`カットが拍の線とズレている: ${worst.toFixed(2)}px`);
if (maxSeam > 1.5) throw new Error(`カット間に隙間がある: ${maxSeam.toFixed(2)}px`);
if (comparedCuts < 3) throw new Error('拡大時に比較できたカットが少なすぎる');
if (zoomWorst > 1.5) throw new Error(`拡大時にズレている: ${zoomWorst.toFixed(2)}px`);
console.log('TIMELINE ALIGNMENT OK');
