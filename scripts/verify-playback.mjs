// シークに頼らず、実際に再生しながらフレームを拾って中身を確かめる。
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
  const video = document.createElement('video');
  video.src = '/video.webm';
  video.muted = true;
  video.playbackRate = 16;
  document.body.appendChild(video);
  await new Promise((r) => (video.onloadedmetadata = r));

  const canvas = document.createElement('canvas');
  canvas.width = 320;
  canvas.height = 180;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });

  const frames = [];
  const seen = new Set();
  await video.play();

  await new Promise((resolve) => {
    const grab = () => {
      if (video.ended || video.currentTime >= video.duration - 0.5) return resolve();
      ctx.drawImage(video, 0, 0, 320, 180);
      // 中央の色を指紋代わりにして、画が変わったかを判定する
      const d = ctx.getImageData(160, 90, 1, 1).data;
      const key = `${d[0] >> 4},${d[1] >> 4},${d[2] >> 4}`;
      if (!seen.has(key)) {
        seen.add(key);
        frames.push({
          t: Number(video.currentTime.toFixed(1)),
          data: canvas.toDataURL('image/jpeg', 0.7).split(',')[1],
        });
      }
      requestAnimationFrame(grab);
    };
    requestAnimationFrame(grab);
  });

  return { distinct: seen.size, sampled: frames.length, frames: frames.slice(0, 10) };
});

console.log(`distinct centre-colours during playback: ${result.distinct}`);
for (const f of result.frames) {
  writeFileSync(`${shots}/play-${String(f.t).padStart(6, '0')}.jpg`, Buffer.from(f.data, 'base64'));
}
console.log(`wrote ${result.frames.length} sample frames`);
await browser.close();
if (result.distinct < 8) throw new Error(`中身が変化していない (distinct=${result.distinct})`);
console.log('PLAYBACK CONTENT OK');
