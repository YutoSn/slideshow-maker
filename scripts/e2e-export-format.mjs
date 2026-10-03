// 書き出しの形式（MP4 を優先・作れなければ WebM）と、画面の向き・解像度を確かめる。
// - 縦長 9:16 にすると、プレビューも縦長になる
// - 最高画質（1080p）で 1920x1080、縦長の軽量で 540x960 の動画ができる
// - H.264 を符号化できるブラウザでは MP4、できなければ WebM と知らせが出る
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { readdirSync, mkdirSync } from 'node:fs';
import { resolve } from 'node:path';

const SHOTS = process.env.SHOTS_DIR ?? '/tmp/shots';
const OUT = 'out';
mkdirSync(OUT, { recursive: true });
mkdirSync(SHOTS, { recursive: true });

const photos = readdirSync('assets/demo-photos')
  .filter((f) => f.endsWith('.jpg'))
  .slice(0, 3)
  .map((f) => resolve('assets/demo-photos', f));
const audio = resolve('assets/demo-audio', 'click-10s.webm');

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1400, height: 900 } });
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://127.0.0.1:5173/');
await page.setInputFiles('input[type=file][multiple]', photos);
await page.setInputFiles('input[type=file][accept="audio/*"]', audio);
await page.waitForSelector('.segments .segment', { timeout: 120000 });
await page.waitForTimeout(600);

// このブラウザが MP4（H.264）を作れるか。作れないなら WebM になるのが正しい
const canMp4 = await page.evaluate(async () => {
  if (typeof VideoEncoder === 'undefined') return false;
  const { supported } = await VideoEncoder.isConfigSupported({
    codec: 'avc1.640028',
    width: 1280,
    height: 720,
    bitrate: 1_500_000,
    framerate: 30,
  });
  return Boolean(supported);
});
const expected = canMp4 ? 'mp4' : 'webm';
console.log('H.264 を符号化できるか:', canMp4, '→ 期待する形式:', expected);

/** 書き出して保存し、ffprobe で形式と大きさを読む */
async function exportAs(quality, name) {
  await page.selectOption('.transport__quality', quality);
  const downloaded = page.waitForEvent('download', { timeout: 5 * 60 * 1000 });
  await page.click('button.primary:has-text("動画を書き出す")');
  const download = await downloaded;
  const suggested = download.suggestedFilename();
  const file = resolve(OUT, `${name}-${suggested}`);
  await download.saveAs(file);
  const probe = JSON.parse(
    execFileSync('ffprobe', [
      '-v', 'error', '-show_entries', 'format=format_name,duration:stream=codec_type,codec_name,width,height',
      '-of', 'json', file,
    ]).toString(),
  );
  const video = probe.streams.find((s) => s.codec_type === 'video');
  const sound = probe.streams.find((s) => s.codec_type === 'audio');
  const info = {
    suggested,
    format: probe.format.format_name,
    duration: Number(probe.format.duration),
    video: `${video.codec_name} ${video.width}x${video.height}`,
    audio: sound?.codec_name,
    width: video.width,
    height: video.height,
  };
  console.log(name, info);
  await page.waitForSelector('button.primary:has-text("動画を書き出す")');
  return info;
}

const failures = [];
const check = (ok, message) => {
  if (!ok) failures.push(message);
};

// 横長・1080p
const landscape = await exportAs('full', 'landscape-1080p');
check(landscape.width === 1920 && landscape.height === 1080, `横長 1080p の大きさが違う: ${landscape.video}`);
check(landscape.suggested.endsWith(`.${expected}`), `拡張子が違う: ${landscape.suggested}`);
check(landscape.format.includes(expected === 'mp4' ? 'mp4' : 'webm'), `入れ物が違う: ${landscape.format}`);
check(Boolean(landscape.audio), '音声が入っていない');
check(Math.abs(landscape.duration - 10) < 0.5, `長さが曲と違う: ${landscape.duration}`);
if (expected === 'mp4') {
  check(landscape.video.startsWith('h264') && landscape.audio === 'aac', `MP4 のコーデックが違う: ${landscape.video} / ${landscape.audio}`);
} else {
  const notice = await page.textContent('.panel--stage');
  check(notice.includes('WebM で書き出しました'), 'WebM になったのに知らせが出ていない');
}

// 縦長に切り替えると、プレビューも縦長になる
await page.selectOption('.panel--global select >> nth=0', 'portrait');
await page.waitForTimeout(500);
const stage = await page.$eval('canvas.stage', (c) => {
  const rect = c.getBoundingClientRect();
  return { width: c.width, height: c.height, cssWidth: rect.width, cssHeight: rect.height };
});
console.log('縦長のプレビュー:', stage);
check(stage.height > stage.width, 'プレビューの描画が縦長になっていない');
check(Math.abs(stage.cssWidth / stage.cssHeight - 9 / 16) < 0.02, 'プレビューの表示が 9:16 になっていない');
await page.screenshot({ path: `${SHOTS}/portrait-preview.png` });

// 縦長・軽量（540p → 540x960）
const portrait = await exportAs('light', 'portrait-540p');
check(portrait.width === 540 && portrait.height === 960, `縦長 540p の大きさが違う: ${portrait.video}`);

// 縦長は保存され、開き直しても残る
await page.waitForTimeout(2500);
await page.reload();
await page.waitForSelector('.segments .segment', { timeout: 120000 });
const restored = await page.$eval('.panel--global select', (s) => s.value);
console.log('開き直したときの向き:', restored);
check(restored === 'portrait', '縦長の設定が保存されていない');

await browser.close();

if (failures.length > 0) {
  for (const f of failures) console.log('NG:', f);
  process.exit(1);
}
console.log('EXPORT FORMAT OK');
