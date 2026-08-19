// 動作確認用の短い動画を作る。フレームごとに数字と色が変わるので、
// 「今どのコマが映っているか」を機械的に判定できる。
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = process.env.OUT ?? 'assets/demo-video';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:5173/');

for (const [name, hue, seconds] of [
  ['clip-a', 200, 6],
  ['clip-b', 20, 4],
]) {
  const base64 = await page.evaluate(
    async ({ hue, seconds }) => {
      const canvas = document.createElement('canvas');
      canvas.width = 960;
      canvas.height = 540;
      const ctx = canvas.getContext('2d');
      const stream = canvas.captureStream(25);
      const recorder = new MediaRecorder(stream, { videoBitsPerSecond: 1_200_000 });
      const chunks = [];
      recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);

      const started = performance.now();
      const draw = () => {
        const t = (performance.now() - started) / 1000;
        // 秒ごとに色相が回り、大きな数字で経過秒を出す
        ctx.fillStyle = `hsl(${(hue + t * 40) % 360} 70% ${28 + Math.sin(t * 3) * 8}%)`;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.fillStyle = '#fff';
        ctx.font = 'bold 220px system-ui, sans-serif';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.fillText(t.toFixed(1), canvas.width / 2, canvas.height / 2);
        // 進行を示す帯
        ctx.fillStyle = '#fff';
        ctx.fillRect(0, canvas.height - 18, (t / seconds) * canvas.width, 18);
      };

      recorder.start();
      await new Promise((resolve) => {
        const tick = () => {
          draw();
          if ((performance.now() - started) / 1000 >= seconds) return resolve();
          requestAnimationFrame(tick);
        };
        tick();
      });
      recorder.stop();

      const blob = await new Promise((resolve) => {
        recorder.onstop = () => resolve(new Blob(chunks, { type: 'video/webm' }));
      });
      const buffer = new Uint8Array(await blob.arrayBuffer());
      let binary = '';
      for (const byte of buffer) binary += String.fromCharCode(byte);
      return btoa(binary);
    },
    { hue, seconds },
  );

  const path = `${OUT}/${name}.webm`;
  writeFileSync(path, Buffer.from(base64, 'base64'));
  console.log(`${path}: ${(base64.length / 1365).toFixed(0)} KB`);
}

await browser.close();
