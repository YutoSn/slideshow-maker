import { createMediaClock } from './mediaClock';

/**
 * 再生中の曲に重ねてクリック音を鳴らす。拍や切り替わりが曲と合っているかを
 * 耳で確かめるためのもの。
 *
 * クリックは Web Audio で少し先まで予約しておく（setTimeout で鳴らすと
 * タイマーの遅れがそのまま音のずれになる）。
 */

/** どれだけ先まで予約するか（秒） */
const LOOKAHEAD = 0.15;
/** 予約を見直す間隔（ms） */
const TICK_MS = 25;

export interface ClickTime {
  time: number;
  /** 小節頭・カットの切り替わりなど、強く鳴らすもの */
  accent: boolean;
}

export function startMetronome(audio: HTMLMediaElement, clicks: ClickTime[]): () => void {
  const context = new AudioContext();
  const clock = createMediaClock(audio);
  const output = context.createGain();
  output.gain.value = 0.35;
  output.connect(context.destination);

  let index = -1;
  let last = -Infinity;

  const seekIndex = (time: number) => {
    let lo = 0;
    let hi = clicks.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (clicks[mid].time < time) lo = mid + 1;
      else hi = mid;
    }
    index = lo;
  };

  const click = (when: number, accent: boolean) => {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.frequency.value = accent ? 1760 : 1100;
    gain.gain.setValueAtTime(0, when);
    gain.gain.linearRampToValueAtTime(accent ? 1 : 0.6, when + 0.002);
    gain.gain.exponentialRampToValueAtTime(0.001, when + 0.05);
    osc.connect(gain).connect(output);
    osc.start(when);
    osc.stop(when + 0.06);
  };

  const tick = () => {
    if (audio.paused) return;
    const now = clock();
    // シークしたら、予約の位置を探し直す
    if (index < 0 || now < last - 0.05 || now > last + 0.5) seekIndex(now);
    last = now;

    while (index < clicks.length && clicks[index].time < now + LOOKAHEAD) {
      const { time, accent } = clicks[index];
      const when = context.currentTime + (time - now);
      if (when >= context.currentTime - 0.005) click(Math.max(context.currentTime, when), accent);
      index += 1;
    }
  };

  void context.resume();
  const timer = window.setInterval(tick, TICK_MS);
  tick();

  return () => {
    window.clearInterval(timer);
    void context.close();
  };
}
