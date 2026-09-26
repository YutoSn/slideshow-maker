// 再生中の「このカットだけ」と選択の扱いを確認する。
// 再生中は選択を映っているカットに合わせない（切り替わりのたびに画面全体を
// 作り直すと、プレビューが止まるため）。そのかわり:
// - 再生中は「このカットだけ」を触れないようにして、そう表示する
// - 止めると、映っているカットが選ばれる
// - 再生中に素材プールの写真を押すと、止めてから映っているカットに当てはめる
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
const page = await browser.newPage({ viewport: { width: 1500, height: 1000 } });
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

const picked = async () => (await page.textContent('.panel--cut .stage__badge'))?.trim();
const activeCut = () =>
  page.evaluate(() => {
    const cuts = [...document.querySelectorAll('.segments .segment')];
    return `カット ${cuts.findIndex((el) => el.classList.contains('segment--active')) + 1}`;
  });

// カット 1 を選んで再生し、カット 2 に入るまで流す
await page.locator('.segments .segment').nth(0).click();
await page.click('.transport button:has-text("再生")');
await page.waitForFunction(
  () => {
    const cuts = [...document.querySelectorAll('.segments .segment')];
    return cuts.findIndex((el) => el.classList.contains('segment--active')) >= 1;
  },
  null,
  { timeout: 15000 },
);
const disabled = await page.locator('.panel--cut button:has-text("+ 1 拍")').isDisabled();
const note = (await page.textContent('.cut__playing').catch(() => '')) ?? '';
expect('再生中は「このカットだけ」を触れない', disabled);
expect('再生中であることを表示する', note.includes('再生中'), note);

// 止めると、映っているカットが選ばれる
await page.click('.transport button:has-text("一時停止")');
await page.waitForTimeout(300);
const visible = await activeCut();
expect('止めると映っているカットが選ばれる', (await picked()) === visible, `${await picked()} / ${visible}`);
expect('止めると触れるようになる', !(await page.locator('.panel--cut button:has-text("+ 1 拍")').isDisabled()));

// 再生中に写真を押すと、止めてから映っているカットに当てはめる
await page.click('.transport button:has-text("再生")');
await page.waitForTimeout(1200);
const poolSrc = await page.getAttribute('.tray__item:nth-child(15) img', 'src');
await page.click('.tray__item:nth-child(15) .tray__assign');
await page.waitForTimeout(400);
const paused = await page.evaluate(() => document.querySelector('audio').paused);
const target = await activeCut();
const index = Number(target.replace('カット ', '')) - 1;
const cutSrc = await page.locator('.segments .segment').nth(index).locator('img').getAttribute('src');
expect('再生中に写真を押すと止まる', paused);
expect('映っているカットに当てはめる', cutSrc === poolSrc && (await picked()) === target, target);

await browser.close();
if (failed) {
  console.log('FAILED');
  process.exit(1);
}
console.log('PLAY & SELECT OK');
