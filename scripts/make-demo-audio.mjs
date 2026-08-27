// 書き出しの確認用に、短いクリック音源を作る。
// 本番の曲（約 5 分）で試すと 1 回の確認に 5 分かかるため。
import { chromium } from 'playwright';
import { writeFileSync, mkdirSync } from 'node:fs';

const OUT = process.env.OUT ?? 'assets/demo-audio';
const SECONDS = Number(process.env.SECONDS ?? 10);
const BPM = Number(process.env.BPM ?? 120);
mkdirSync(OUT, { recursive: true });

const browser = await chromium.launch({
  executablePath: '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await browser.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto('http://127.0.0.1:5173/');

const base64 = await page.evaluate(
  async ({ seconds, bpm }) => {
    const ctx = new AudioContext();
    const destination = ctx.createMediaStreamDestination();
    const recorder = new MediaRecorder(destination.stream);
    const chunks = [];
    recorder.ondataavailable = (e) => e.data.size > 0 && chunks.push(e.data);

    // 拍がはっきり出るよう、短い減衰音を等間隔に並べる
    const period = 60 / bpm;
    const start = ctx.currentTime + 0.1;
    for (let i = 0; i * period < seconds; i++) {
      const at = start + i * period;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = i % 4 === 0 ? 880 : 440;
      gain.gain.setValueAtTime(0.9, at);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.12);
      osc.connect(gain).connect(destination);
      osc.start(at);
      osc.stop(at + 0.14);
    }

    recorder.start();
    await new Promise((r) => setTimeout(r, seconds * 1000 + 300));
    recorder.stop();
    const blob = await new Promise((res) => {
      recorder.onstop = () => res(new Blob(chunks, { type: 'audio/webm' }));
    });
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    void ctx.close();
    return btoa(binary);
  },
  { seconds: SECONDS, bpm: BPM },
);

const path = `${OUT}/click-${SECONDS}s.webm`;
writeFileSync(path, Buffer.from(base64, 'base64'));
console.log(`${path}: ${(base64.length / 1365).toFixed(0)} KB (${SECONDS}s / ${BPM} BPM)`);
await browser.close();
