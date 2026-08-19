// 1) 横スクロールが勝手に戻らないか
// 2) PC 幅で、左だけがスクロールしプレビュー／タイムラインは動かないか
// 3) BPM 操作がタイムライン側にあるか
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SHOTS = process.env.SHOTS_DIR ?? '/tmp/shots';
const photos = readdirSync('assets/demo-photos')
  .filter((f) => f.endsWith('.jpg'))
  .map((f) => resolve('assets/demo-photos', f));

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage({ viewport: { width: 1500, height: 950 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://127.0.0.1:5173/');
await page.setInputFiles('input[type=file][accept="image/*"]', photos);
await page.setInputFiles('input[type=file][accept="audio/*"]', resolve('assets/ohayou.mp3'));
await page.waitForSelector('.segments .segment', { timeout: 120000 });

// --- 3. BPM がタイムライン内にあるか -----------------------------
const bpmInTimeline = await page.evaluate(() => {
  const bpm = document.querySelector('.bpm');
  const timeline = document.querySelector('.app__main .panel:nth-child(2)');
  const settings = document.querySelector('.app__side');
  return {
    inTimeline: !!(bpm && timeline?.contains(bpm)),
    inSidebar: !!(bpm && settings?.contains(bpm)),
  };
});
console.log('BPM がタイムライン内 :', bpmInTimeline.inTimeline, '/ 左メニュー内:', bpmInTimeline.inSidebar);

// --- 1. スクロールが戻らないか -----------------------------------
await page.click('button[aria-label="タイムラインを拡大"]');
await page.click('button[aria-label="タイムラインを拡大"]');
await page.waitForTimeout(400);

const setScroll = (x) =>
  page.evaluate((v) => {
    const el = document.querySelector('.timeline');
    el.scrollLeft = v;
    return el.scrollLeft;
  }, x);
const getScroll = () => page.evaluate(() => document.querySelector('.timeline').scrollLeft);

const target = await setScroll(900);
await page.waitForTimeout(500);
console.log('スクロール直後       :', target, '->', await getScroll());

// 以前はここで古い基準位置が適用されて戻っていた。
// 「全体」を押しても拡大率が変わらない状況を作ってから BPM を変える
await page.click('button[aria-label="タイムラインを縮小"]');
await page.click('button[aria-label="タイムラインを縮小"]');
await page.waitForTimeout(300);
await page.click('button[aria-label="タイムラインを縮小"]'); // すでに最小＝変化なし
await page.waitForTimeout(200);
await page.click('button[aria-label="タイムラインを拡大"]');
await page.click('button[aria-label="タイムラインを拡大"]');
await page.waitForTimeout(300);

const before = await setScroll(700);
await page.waitForTimeout(300);
// BPM を変えて再描画を起こす（ここで古い基準位置が効くと戻る）
await page.click('button[aria-label="BPM を 1 上げる"]');
await page.waitForTimeout(700);
const after = await getScroll();
console.log('BPM 変更をまたいで   :', before, '->', after);
const kept = Math.abs(after - before) < 60;
console.log('位置が保たれた       :', kept);

// 何度か往復させても戻らないか
let drifted = false;
for (const x of [300, 1200, 600, 1500]) {
  await setScroll(x);
  await page.waitForTimeout(280);
  const now = await getScroll();
  if (Math.abs(now - x) > 60) {
    drifted = true;
    console.log('  ズレ:', x, '->', now);
  }
}
console.log('往復しても戻らない   :', !drifted);

await page.screenshot({ path: `${SHOTS}/layout.jpg`, type: 'jpeg', quality: 76 });

// --- 2. 固定レイアウト -------------------------------------------
const layout = await page.evaluate(() => {
  const stage = document.querySelector('canvas.stage').getBoundingClientRect();
  const side = document.querySelector('.app__side');
  side.scrollTop = 400;
  return {
    pageScrolls: document.documentElement.scrollHeight > window.innerHeight + 2,
    sideScrollable: side.scrollHeight > side.clientHeight + 2,
    stageTop: Math.round(stage.top),
    stageBottom: Math.round(stage.bottom),
    viewport: window.innerHeight,
  };
});
await page.waitForTimeout(300);
const afterSideScroll = await page.evaluate(() => {
  const stage = document.querySelector('canvas.stage').getBoundingClientRect();
  return { scrollTop: document.querySelector('.app__side').scrollTop, stageTop: Math.round(stage.top) };
});

console.log('ページ自体は伸びない :', !layout.pageScrolls);
console.log('左メニューは動く     :', layout.sideScrollable, '(scrollTop', afterSideScroll.scrollTop, ')');
console.log('プレビューは動かない :', layout.stageTop === afterSideScroll.stageTop);
console.log('プレビューは画面内   :', layout.stageBottom <= layout.viewport);

await page.screenshot({ path: `${SHOTS}/layout-scrolled.jpg`, type: 'jpeg', quality: 76 });
await browser.close();

if (!bpmInTimeline.inTimeline) throw new Error('BPM がタイムラインに無い');
if (bpmInTimeline.inSidebar) throw new Error('BPM が左メニューに残っている');
if (!kept) throw new Error('スクロールが戻っている');
if (drifted) throw new Error('スクロールが安定しない');
if (layout.pageScrolls) throw new Error('ページ全体がスクロールしてしまう');
if (!layout.sideScrollable) throw new Error('左メニューがスクロールしない');
if (layout.stageTop !== afterSideScroll.stageTop) throw new Error('プレビューが固定されていない');
console.log('LAYOUT & SCROLL OK');
