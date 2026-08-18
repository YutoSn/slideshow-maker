// 動作確認用のダミー写真を生成する。実写真が用意できないときの代替。
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = 'assets/demo-photos';
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
const page = await browser.newPage();

const images = await page.evaluate(() => {
  const palettes = [
    ['#ff9a3c', '#ff6a88', '#7b2ff7'],
    ['#00c9ff', '#92fe9d', '#0f2027'],
    ['#f7971e', '#ffd200', '#e65c00'],
    ['#8e2de2', '#4a00e0', '#150050'],
    ['#11998e', '#38ef7d', '#0f3443'],
    ['#fc466b', '#3f5efb', '#1c1c3c'],
    ['#f857a6', '#ff5858', '#2b1055'],
    ['#43cea2', '#185a9d', '#02111b'],
    ['#ffe259', '#ffa751', '#7f3f00'],
    ['#c94b4b', '#4b134f', '#12000f'],
    ['#00b4db', '#0083b0', '#001f2d'],
    ['#f5af19', '#f12711', '#3a0a00'],
  ];

  const out = [];
  for (let i = 0; i < 18; i++) {
    // 縦横比を混ぜて、cover 表示や Ken Burns の挙動も確認できるようにする
    const portrait = i % 4 === 3;
    const w = portrait ? 1200 : 1800;
    const h = portrait ? 1800 : 1200;
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext('2d');
    const palette = palettes[i % palettes.length];

    const grad = ctx.createLinearGradient(0, 0, w, h);
    grad.addColorStop(0, palette[0]);
    grad.addColorStop(0.55, palette[1]);
    grad.addColorStop(1, palette[2]);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, w, h);

    // 目印になる図形を散らす（切り替わりが視認しやすいように）
    for (let s = 0; s < 26; s++) {
      ctx.beginPath();
      const r = 40 + ((i * 37 + s * 53) % 220);
      ctx.arc((s * 211 + i * 97) % w, (s * 307 + i * 61) % h, r, 0, Math.PI * 2);
      ctx.fillStyle = `rgba(255,255,255,${0.03 + ((s % 5) * 0.02)})`;
      ctx.fill();
    }

    ctx.fillStyle = 'rgba(0,0,0,0.35)';
    ctx.fillRect(0, h - 250, w, 250);
    ctx.fillStyle = '#fff';
    ctx.font = `bold ${Math.round(w / 9)}px system-ui, sans-serif`;
    ctx.textBaseline = 'middle';
    ctx.fillText(String(i + 1).padStart(2, '0'), 70, h - 125);
    ctx.font = `${Math.round(w / 26)}px system-ui, sans-serif`;
    ctx.fillText(portrait ? 'PORTRAIT' : 'LANDSCAPE', 70 + w / 5, h - 125);

    out.push(canvas.toDataURL('image/jpeg', 0.85).split(',')[1]);
  }
  return out;
});

images.forEach((b64, i) => {
  writeFileSync(`${OUT}/photo-${String(i + 1).padStart(2, '0')}.jpg`, Buffer.from(b64, 'base64'));
});

console.log(`generated ${images.length} demo photos in ${OUT}`);
await browser.close();
