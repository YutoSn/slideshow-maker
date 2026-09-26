// 曲と切り替わりを合わせる道具の確認。
// - 境目ごとのずれの集計（BPM を崩すと一致が減る）
// - 2 点で合わせる（120 BPM のクリック音源なら 120 前後に戻る）
// - 全体のずれを「揃える」ボタンで打ち消せる
// - クリック音が再生中に予約される
import { chromium } from 'playwright';
import { readdirSync } from 'node:fs';
import { resolve } from 'node:path';

const photos = readdirSync('assets/demo-photos')
  .filter((f) => f.endsWith('.jpg'))
  .map((f) => resolve('assets/demo-photos', f));
const audio = resolve('assets/demo-audio', process.env.AUDIO_FILE ?? 'click-40s.webm');

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage({ viewport: { width: 1500, height: 1050 } });
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
// クリック音の予約を数える
await page.addInitScript(() => {
  window.__clicks = 0;
  const original = AudioContext.prototype.createOscillator;
  AudioContext.prototype.createOscillator = function (...args) {
    window.__clicks += 1;
    return original.apply(this, args);
  };
});

await page.goto('http://127.0.0.1:5173/');
await page.setInputFiles('input[type=file][multiple]', photos);
await page.setInputFiles('input[type=file][accept="audio/*"]', audio);
await page.waitForSelector('.segments .segment', { timeout: 120000 });
await page.waitForTimeout(300);

let failed = false;
const expect = (label, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${label}${detail ? `: ${detail}` : ''}`);
};

const score = async () => {
  const text = (await page.textContent('.sync__score b')) ?? '';
  const [good, measured] = text.split('/').map((v) => Number(v.trim()));
  return { good, measured };
};
const median = async () => {
  const text = (await page.textContent('.sync__score .muted').catch(() => '')) ?? '';
  const match = text.match(/([+-]?\d+)ms/);
  return match ? Number(match[1]) : 0;
};
const bpm = async () => Number(await page.inputValue('.bpm input'));

// --- ずれの集計 ---
const initial = await score();
console.log(`     検出直後: ${initial.good}/${initial.measured}  BPM ${await bpm()}`);
expect('クリック音源なら境目はほぼ一致', initial.good >= initial.measured * 0.8, `${initial.good}/${initial.measured}`);

// 最初のカットを基準に BPM を崩すと、後ろほどずれて一致が減る
await page.locator('.segments .segment').nth(0).click();
for (let i = 0; i < 2; i++) await page.click('button[aria-label="BPM を 1 上げる"]');
await page.waitForTimeout(200);
const broken = await score();
console.log(`     BPM +2 後: ${broken.good}/${broken.measured}  BPM ${await bpm()}`);
expect('BPM を崩すと一致が減る', broken.good < initial.good, `${initial.good} → ${broken.good}`);

// --- 2 点で合わせる ---
await page.click('.sync__toggle');
const ruler = page.locator('.timeline__ruler');
const box = await ruler.boundingBox();
const duration = await page.evaluate(() => document.querySelector('audio').duration);
const clickAt = async (seconds) => {
  await page.mouse.click(box.x + (seconds / duration) * box.width, box.y + 30);
  await page.waitForTimeout(150);
};
await clickAt(2.05);
await page.click('.twopoint button:has-text("A をここにする")');
await clickAt(36.1);
await page.click('.twopoint button:has-text("B をここにする")');
await page.waitForTimeout(150);
const pointText = await page.textContent('.twopoint');
console.log('     ', (await page.textContent('.twopoint__row:nth-of-type(2)'))?.replace(/\s+/g, ' ').trim());
expect('A と B が置かれた', pointText.includes('A: 0:') && pointText.includes('B: 0:'));
await page.click('.twopoint button:has-text("この 2 点で合わせる")');
await page.waitForTimeout(250);
const aligned = await score();
const alignedBpm = await bpm();
console.log(`     2 点合わせ後: ${aligned.good}/${aligned.measured}  BPM ${alignedBpm}`);
expect('BPM が 120 前後に戻る', Math.abs(alignedBpm - 120) < 0.6, String(alignedBpm));
expect('一致が戻る', aligned.good >= aligned.measured * 0.8, `${aligned.good}/${aligned.measured}`);

// --- 全体のずれを揃える ---
for (let i = 0; i < 5; i++) await page.click('button[aria-label="拍の位置を 10ms 遅らせる"]');
await page.waitForTimeout(200);
const shifted = await median();
console.log(`     +50ms ずらした後の全体のずれ: ${shifted}ms`);
expect('全体のずれとして出る', shifted >= 35 && shifted <= 65, `${shifted}ms`);
await page.click('.sync__score button');
await page.waitForTimeout(200);
const fixed = await median();
expect('「揃える」で打ち消せる', Math.abs(fixed) <= 10, `${fixed}ms`);

// --- クリック音 ---
await page.selectOption('.sync__click select', 'beat');
await page.click('.transport button:has-text("先頭へ")');
const before = await page.evaluate(() => window.__clicks);
await page.click('.transport button:has-text("再生")');
await page.waitForTimeout(2000);
await page.click('.transport button:has-text("一時停止")');
const during = (await page.evaluate(() => window.__clicks)) - before;
expect('再生中に拍ごとのクリックが予約される', during >= 3 && during <= 6, `${during} 回 / 2 秒`);
await page.selectOption('.sync__click select', 'off');
const afterOff = await page.evaluate(() => window.__clicks);
await page.click('.transport button:has-text("再生")');
await page.waitForTimeout(1000);
await page.click('.transport button:has-text("一時停止")');
expect('「なし」では鳴らない', (await page.evaluate(() => window.__clicks)) === afterOff);

await page.waitForTimeout(300);
const label = (await page.textContent('.transport button'))?.trim();
const paused = await page.evaluate(() => document.querySelector('audio').paused);
expect('停止後は「再生」表示', label === '再生' && paused, `${label} / paused=${paused}`);
await page.screenshot({ path: process.env.SHOT ?? '/tmp/sync-tools.png' });
await browser.close();
if (failed) {
  console.log('FAILED');
  process.exit(1);
}
console.log('ALL OK');
