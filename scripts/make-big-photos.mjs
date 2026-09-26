// 重さの確認用に、スマホの写真と同じ大きさ（4032×3024）のダミー写真を作る。
// 12 枚でおよそ 60MB。assets/big-photos に書き出す。
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';
const OUT = 'assets/big-photos';
mkdirSync(OUT, { recursive: true });
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();
for (let n = 0; n < 12; n++) {
  const data = await page.evaluate((n) => {
    const c = document.createElement('canvas');
    const portrait = n % 3 === 0;
    c.width = portrait ? 3024 : 4032; c.height = portrait ? 4032 : 3024;
    const x = c.getContext('2d');
    const g = x.createLinearGradient(0, 0, c.width, c.height);
    g.addColorStop(0, `hsl(${n * 30},80%,60%)`); g.addColorStop(1, `hsl(${n * 30 + 120},70%,30%)`);
    x.fillStyle = g; x.fillRect(0, 0, c.width, c.height);
    const img = x.getImageData(0, 0, c.width, c.height);
    for (let i = 0; i < img.data.length; i += 4) { const r = (Math.random() - 0.5) * 60; img.data[i] += r; img.data[i+1] += r; img.data[i+2] += r; }
    x.putImageData(img, 0, 0);
    x.fillStyle = '#fff'; x.font = 'bold 600px sans-serif'; x.fillText(String(n + 1), 300, 900);
    return c.toDataURL('image/jpeg', 0.9).split(',')[1];
  }, n);
  writeFileSync(`${OUT}/big-${String(n + 1).padStart(2, '0')}.jpg`, Buffer.from(data, 'base64'));
}
await browser.close();
