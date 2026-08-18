// 書き出した動画が実際に再生・シークできるかをブラウザで確認し、
// 各時点のフレームを画像として取り出す。
import { chromium } from 'playwright';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';

const file = process.argv[2] ?? 'out/slideshow.webm';
const shots = process.env.SHOTS_DIR ?? '/tmp/shots';
mkdirSync(shots, { recursive: true });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.route('**/video.webm', (route) =>
  route.fulfill({ status: 200, contentType: 'video/webm', body: readFileSync(file) }),
);
await page.goto('http://127.0.0.1:5173/');

const result = await page.evaluate(async () => {
  // route.fulfill は Range 要求に応えないため、そのままだとシークできない。
  // ローカルファイルを開く場合と同じ条件にするため Blob URL を経由する。
  const blob = await (await fetch('/video.webm')).blob();
  const video = document.createElement('video');
  video.src = URL.createObjectURL(blob);
  video.muted = true;
  document.body.appendChild(video);

  await new Promise((resolve, reject) => {
    video.onloadedmetadata = resolve;
    video.onerror = () => reject(new Error('動画を読み込めません'));
  });

  const seekTo = (t) =>
    new Promise((resolve) => {
      video.onseeked = () => resolve();
      video.currentTime = t;
    });

  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  const ctx = canvas.getContext('2d');

  const frames = [];
  for (const t of [3, 45, 100, 160, 230, 288]) {
    await seekTo(t);
    await new Promise((r) => setTimeout(r, 300));
    ctx.drawImage(video, 0, 0);
    frames.push({ t, data: canvas.toDataURL('image/jpeg', 0.8).split(',')[1] });
  }

  return {
    bytes: blob.size,
    duration: video.duration,
    width: video.videoWidth,
    height: video.videoHeight,
    frames,
  };
});

console.log(`duration : ${result.duration}s`);
console.log(`size     : ${result.width}x${result.height}`);
for (const f of result.frames) {
  writeFileSync(`${shots}/frame-${String(f.t).padStart(3, '0')}s.jpg`, Buffer.from(f.data, 'base64'));
}
console.log(`wrote ${result.frames.length} frames to ${shots}`);

await browser.close();
if (!(result.duration > 290 && result.duration < 296)) throw new Error('総再生時間が不正');
if (result.width !== 1280 || result.height !== 720) throw new Error('解像度が不正');
console.log('OUTPUT OK');
