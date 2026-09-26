// プレビュー再生の重さを測る。切り替わりの前後でコマが止まっていないか、何に時間を使っているか。
//
// 使い方（先に node scripts/make-big-photos.mjs でスマホ相当の写真を作っておく）:
//   node scripts/bench-preview.mjs
//   URL=http://127.0.0.1:4173/ node scripts/bench-preview.mjs   # 本番ビルド（npm run build && npx vite preview）
// 環境変数: PHOTO_DIR（写真のフォルダ）, CPU（CPU を何倍遅くするか。既定 4）, NO_VIDEO, WARM（1 回通してから測る）
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const photoDir = process.env.PHOTO_DIR ?? 'assets/big-photos';
const photos = readdirSync(photoDir).map((f) => resolve(photoDir, f));
const videos = process.env.NO_VIDEO ? [] : readdirSync('assets/demo-video').map((f) => resolve('assets/demo-video', f));
const throttle = Number(process.env.CPU ?? 4);

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

// drawImage にかかった時間を、コマごとに数える
await page.addInitScript(() => {
  window.__draw = 0;
  const original = CanvasRenderingContext2D.prototype.drawImage;
  CanvasRenderingContext2D.prototype.drawImage = function (...args) {
    const t = performance.now();
    const r = original.apply(this, args);
    window.__draw += performance.now() - t;
    return r;
  };
  window.__long = [];
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) window.__long.push({ at: e.startTime, ms: e.duration });
  }).observe({ type: 'longtask', buffered: true });
});

await page.goto(process.env.URL ?? 'http://127.0.0.1:5173/');
await page.setInputFiles('input[type=file][multiple]', [...photos, ...videos]);
await page.setInputFiles('input[type=file][accept="audio/*"]', resolve('assets/demo-audio/click-40s.webm'));
await page.waitForSelector('.segments .segment', { timeout: 120000 });

// 1 カット 2 拍（1 秒）にして、切り替わりを多くする
const slider = page.locator('.panel--global .field:has-text("1 枚あたりの拍数") input[type=range]');
await slider.evaluate((el) => {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
  set.call(el, '2');
  el.dispatchEvent(new Event('input', { bubbles: true }));
});
await page.waitForTimeout(1500);

// 自動保存にかかる時間
const saveStart = Date.now();
let sawSaving = false;
for (let i = 0; i < 600; i++) {
  const s = (await page.textContent('.panel:has-text("プロジェクト") .muted').catch(() => '')) ?? '';
  if (s.includes('保存中')) sawSaving = true;
  if (sawSaving && s.includes('保存しました')) break;
  await page.waitForTimeout(50);
}
console.log(`自動保存: ${sawSaving ? `${Date.now() - saveStart}ms（待ち 1.5 秒を含む）` : '観測できず'}`);

const cdp = await page.context().newCDPSession(page);
await cdp.send('Emulation.setCPUThrottlingRate', { rate: throttle });
await cdp.send('Profiler.enable');
await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
await cdp.send('Profiler.start');

if (process.env.WARM) {
  // 1 回通して再生し、プレビュー用の画像を作り終えてから測る
  await page.evaluate(async () => {
    const audio = document.querySelector('audio');
    audio.currentTime = 2;
    await audio.play();
    await new Promise((r) => setTimeout(r, 13000));
    audio.pause();
  });
}
const result = await page.evaluate(async () => {
  window.__long = [];
  const audio = document.querySelector('audio');
  audio.currentTime = 2;
  await new Promise((r) => setTimeout(r, 300));
  const frames = [];
  let lastDraw = window.__draw;
  await audio.play();
  const t0 = performance.now();
  await new Promise((resolve) => {
    const loop = (now) => {
      frames.push({ now, media: audio.currentTime, draw: window.__draw - lastDraw });
      lastDraw = window.__draw;
      if (now - t0 < 12000) requestAnimationFrame(loop);
      else resolve();
    };
    requestAnimationFrame(loop);
  });
  audio.pause();
  const starts = [...document.querySelectorAll('.segments .segment')].map((el) => {
    const m = el.getAttribute('title');
    return m;
  });
  return { frames, long: window.__long.filter((l) => l.at >= t0), t0, segCount: starts.length };
});
const { profile } = await cdp.send('Profiler.stop');
await cdp.send('Emulation.setCPUThrottlingRate', { rate: 1 });
{
  // 自己時間を関数ごと（ファイル名つき）に集計
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  const dt = profile.timeDeltas;
  profile.samples.forEach((id, i) => {
    const n = byId.get(id);
    const f = n.callFrame;
    const key = `${f.functionName || '(anon)'} ${f.url.split('/').pop().split('?')[0]}:${f.lineNumber + 1}`;
    self.set(key, (self.get(key) ?? 0) + (dt[i] ?? 0) / 1000);
  });
  const total = [...self.values()].reduce((a, b) => a + b, 0);
  console.log(`--- CPU プロファイル（自己時間、合計 ${total.toFixed(0)}ms）`);
  for (const [k, v] of [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 18)) {
    console.log(`  ${v.toFixed(0).padStart(6)}ms  ${k}`);
  }
}

const gaps = [];
for (let i = 1; i < result.frames.length; i++) {
  gaps.push({ dt: result.frames[i].now - result.frames[i - 1].now, media: result.frames[i].media, draw: result.frames[i].draw });
}
const sorted = gaps.map((g) => g.dt).sort((a, b) => a - b);
const pct = (p) => sorted[Math.floor(sorted.length * p)].toFixed(1);
const long = gaps.filter((g) => g.dt > 50);
console.log(`CPU ${throttle}x: コマ ${gaps.length} / 12 秒（${(gaps.length / 12).toFixed(1)} fps）  中央 ${pct(0.5)}ms  95% ${pct(0.95)}ms  最大 ${sorted.at(-1).toFixed(0)}ms`);
console.log(`50ms を超える間隔: ${long.length} 回`);
// 切り替わり（1 秒ごと。曲の拍は 0.5 秒刻み）の直後かどうか
const beat = 0.5;
console.log('長い間隔の内訳（曲の位置 / 間隔 / そのうち drawImage）:');
for (const g of long.slice(0, 20)) {
  console.log(`  ${g.media.toFixed(2)}s  ${g.dt.toFixed(0)}ms  draw ${g.draw.toFixed(0)}ms`);
}
const drawAvg = gaps.reduce((s, g) => s + g.draw, 0) / gaps.length;
console.log(`drawImage の平均: ${drawAvg.toFixed(1)}ms / コマ`);
console.log(`long task: ${result.long.length} 件、合計 ${result.long.reduce((s, l) => s + l.ms, 0).toFixed(0)}ms`);
await browser.close();
