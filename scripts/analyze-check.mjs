// ビート検出を実ブラウザ（decodeAudioData を含む本番と同じ経路）で確認する。
import { chromium } from 'playwright';
import { readFileSync } from 'node:fs';

const audioPath = process.argv[2] ?? 'assets/ohayou.mp3';
const base64 = readFileSync(audioPath).toString('base64');

const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium', args: ['--autoplay-policy=no-user-gesture-required'] });
const page = await browser.newPage();
page.on('console', (m) => console.log('[browser]', m.text()));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://127.0.0.1:5173/');
await page.waitForLoadState('networkidle');

const result = await page.evaluate(async (b64) => {
  const { analyzeBeats, toAnalysisInput } = await import('/src/engine/beatDetect.ts');
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);

  const ctx = new AudioContext();
  const t0 = performance.now();
  const buffer = await ctx.decodeAudioData(bytes.buffer);
  const decodeMs = performance.now() - t0;

  const t1 = performance.now();
  const analysis = analyzeBeats(toAnalysisInput(buffer));
  const analyzeMs = performance.now() - t1;

  return {
    decodeMs: Math.round(decodeMs),
    analyzeMs: Math.round(analyzeMs),
    sampleRate: buffer.sampleRate,
    duration: Number(buffer.duration.toFixed(2)),
    bpm: Number(analysis.bpm.toFixed(2)),
    offset: Number(analysis.offset.toFixed(3)),
    beatCount: analysis.beats.length,
    downbeatCount: analysis.downbeats.length,
    firstBeats: analysis.beats.slice(0, 8).map((t) => Number(t.toFixed(3))),
    firstDownbeats: analysis.downbeats.slice(0, 4).map((t) => Number(t.toFixed(3))),
  };
}, base64);

console.log(JSON.stringify(result, null, 2));
await browser.close();
