import type { BeatAnalysis } from './beatDetect';

/**
 * 音の立ち上がり（オンセット）の位置を取り出し、カットの境目とのずれを測る。
 *
 * 時刻はビート格子と同じ基準（包絡線のフレーム位置）で扱う。
 * どちらも同じ基準なので、ずれの比較や吸着はそのまま行える。
 */

export interface OnsetPeak {
  time: number;
  /** 0..1 の強さ */
  strength: number;
}

/** 前後これだけの範囲で一番大きいものだけを立ち上がりとみなす（秒） */
const PEAK_RADIUS_SECONDS = 0.05;
/** 周り（前後 0.5 秒）の平均の何倍あれば立ち上がりとみなすか */
const PEAK_CONTRAST = 1.6;
/** 小さすぎるものは無視する */
const PEAK_FLOOR = 0.08;

const peakCache = new WeakMap<Float32Array, OnsetPeak[]>();

/** はっきりした音の立ち上がりを時刻順に返す。解析結果ごとに一度だけ計算する。 */
export function onsetPeaks(analysis: BeatAnalysis): OnsetPeak[] {
  const envelope = analysis.onsetEnvelope;
  const cached = peakCache.get(envelope);
  if (cached) return cached;

  const hop = analysis.envelopeHopSeconds;
  const radius = Math.max(1, Math.round(PEAK_RADIUS_SECONDS / hop));
  const context = Math.max(radius + 1, Math.round(0.5 / hop));

  // 周りの平均は累積和で求める
  const sums = new Float64Array(envelope.length + 1);
  for (let i = 0; i < envelope.length; i++) sums[i + 1] = sums[i] + envelope[i];

  const peaks: OnsetPeak[] = [];
  for (let i = 0; i < envelope.length; i++) {
    const value = envelope[i];
    if (value < PEAK_FLOOR) continue;

    let isMax = true;
    for (let j = Math.max(0, i - radius); j <= Math.min(envelope.length - 1, i + radius); j++) {
      // 同じ高さが並ぶときは先頭だけを採る
      if (envelope[j] > value || (envelope[j] === value && j < i)) {
        isMax = false;
        break;
      }
    }
    if (!isMax) continue;

    const from = Math.max(0, i - context);
    const to = Math.min(envelope.length, i + context + 1);
    const mean = (sums[to] - sums[from]) / (to - from);
    if (value < mean * PEAK_CONTRAST) continue;

    peaks.push({ time: i * hop, strength: value });
  }

  peakCache.set(envelope, peaks);
  return peaks;
}

/** time に一番近い立ち上がり。window（秒）より遠ければ null。 */
export function nearestPeak(peaks: OnsetPeak[], time: number, window: number): OnsetPeak | null {
  // 時刻順なので二分探索
  let lo = 0;
  let hi = peaks.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (peaks[mid].time < time) lo = mid + 1;
    else hi = mid;
  }
  let best: OnsetPeak | null = null;
  for (const candidate of [peaks[lo - 1], peaks[lo]]) {
    if (!candidate) continue;
    const distance = Math.abs(candidate.time - time);
    if (distance <= window && (!best || distance < Math.abs(best.time - time))) best = candidate;
  }
  return best;
}

/** 近くに立ち上がりがあれば、そこへ吸着させた時刻を返す。 */
export function snapToOnset(
  analysis: BeatAnalysis,
  time: number,
  window = 0.12,
): { time: number; snapped: boolean } {
  const peak = nearestPeak(onsetPeaks(analysis), time, window);
  return peak ? { time: peak.time, snapped: true } : { time, snapped: false };
}

export type DriftLevel = 'good' | 'fair' | 'bad' | 'none';

/** これ以内なら合っている（秒） */
export const DRIFT_GOOD = 0.03;
/** これ以内ならおおむね合っている（秒） */
export const DRIFT_FAIR = 0.07;

export interface BoundaryDrift {
  time: number;
  /** 境目 − 音の立ち上がり（秒）。正なら画の切り替わりが音より遅い */
  drift: number | null;
  level: DriftLevel;
}

export interface DriftSummary {
  boundaries: BoundaryDrift[];
  /** 近くに音があった境目の数 */
  measured: number;
  good: number;
  /** 合っている・おおむね合っている境目のずれの中央値（秒）。全体のずらし量の目安 */
  median: number | null;
}

/**
 * カットの境目ごとに、近くの音の立ち上がりとのずれを測る。
 * 探す範囲は半拍まで（それより遠い音は別の拍のもの）。
 */
export function measureDrift(analysis: BeatAnalysis, boundaries: number[]): DriftSummary {
  const peaks = onsetPeaks(analysis);
  const window = Math.min(0.15, 30 / analysis.bpm / 2);

  const result: BoundaryDrift[] = boundaries.map((time) => {
    const peak = nearestPeak(peaks, time, window);
    if (!peak) return { time, drift: null, level: 'none' };
    const drift = time - peak.time;
    const size = Math.abs(drift);
    const level: DriftLevel = size <= DRIFT_GOOD ? 'good' : size <= DRIFT_FAIR ? 'fair' : 'bad';
    return { time, drift, level };
  });

  const close = result
    .filter((b) => b.level === 'good' || b.level === 'fair')
    .map((b) => b.drift as number)
    .sort((a, b) => a - b);

  return {
    boundaries: result,
    measured: result.filter((b) => b.level !== 'none').length,
    good: result.filter((b) => b.level === 'good').length,
    median: close.length > 0 ? close[Math.floor(close.length / 2)] : null,
  };
}

/**
 * 2 点 a・b の間を何拍とみなすか。
 *
 * いまの BPM から数えると、BPM がずれているときに 1 拍多く・少なく数えてしまう。
 * 近い候補（±3 拍）それぞれで格子を引き、間にある音の立ち上がりが
 * 一番よく拍に乗る拍数を選ぶ。
 */
export function twoPointBeats(analysis: BeatAnalysis, a: number, b: number): number {
  const from = Math.min(a, b);
  const to = Math.max(a, b);
  const span = to - from;
  const guess = Math.max(1, Math.round(span / (60 / analysis.bpm)));
  const peaks = onsetPeaks(analysis).filter((p) => p.time >= from - 0.05 && p.time <= to + 0.05);
  if (peaks.length === 0) return guess;

  let best = guess;
  let bestScore = -Infinity;
  for (let beats = Math.max(1, guess - 3); beats <= guess + 3; beats++) {
    const period = span / beats;
    if (60 / period < 30 || 60 / period > 300) continue;
    let score = 0;
    for (const peak of peaks) {
      // 一番近い拍までの距離。近いほど、強い音ほど点が高い
      const phase = (peak.time - from) / period;
      const distance = Math.abs(phase - Math.round(phase)) * period;
      if (distance < 0.04) score += peak.strength * (1 - distance / 0.04);
    }
    // 同点なら、いまの BPM に近いほう
    score -= Math.abs(beats - guess) * 1e-6;
    if (score > bestScore) {
      bestScore = score;
      best = beats;
    }
  }
  return best;
}

export function twoPointBpm(a: number, b: number, beats: number): number {
  const span = Math.abs(b - a);
  return span > 0 ? (60 * beats) / span : 0;
}
