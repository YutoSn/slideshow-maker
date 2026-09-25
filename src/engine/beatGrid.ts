import type { BeatAnalysis } from './beatDetect';

/**
 * 手直し用のビート格子の作り直し。
 *
 * 以前は曲の頭（offset）を起点に等間隔の格子を作り直していた。
 * これだと BPM を 0.1 変えただけで後半ほど大きくずれ、
 * いま合わせたい場所が流れていってしまう。
 *
 * ここでは「基準の時刻」（選んでいるカットの頭）を動かさずに、
 * その前後へ伸び縮みさせる。基準より前にあるカットの拍数も保つので、
 * 基準のカットの頭はそのままの位置に残る。
 */
export interface GridAnchor {
  /** 動かさずに保つ時刻（秒）。格子はここを必ず通る */
  time: number;
  /** 最初のカットの頭から、基準の時刻までの拍数 */
  beatsBefore: number;
}

/** 最初のカットの前に置いてよい拍数の上限（これを超えるなら小節の位相だけ保つ） */
const MAX_LEAD_BEATS = 8;

export function rebuildGrid(
  analysis: BeatAnalysis,
  bpm: number,
  anchor: GridAnchor,
): BeatAnalysis {
  const period = 60 / bpm;
  const { duration } = analysis;
  const time = Math.min(Math.max(0, anchor.time), Math.max(0, duration - 0.001));

  // 基準の時刻が何拍目にあたるか。格子はここを必ず通る
  const anchorIndex = Math.floor(time / period + 1e-6);
  const beats: number[] = [];
  for (let i = 0; ; i++) {
    const t = time + (i - anchorIndex) * period;
    if (t >= duration) break;
    beats.push(Math.max(0, t));
  }

  // 最初のカットを置く拍。基準のカットの頭が動かないように逆算する
  let first = anchorIndex - Math.max(0, Math.round(anchor.beatsBefore));
  if (first < 0 || first >= MAX_LEAD_BEATS) {
    // 大きく変えたとき（×2 など）は詰め直せないので、小節の位相だけ保つ
    first = ((first % 4) + 4) % 4;
  }
  const downbeats = beats.filter((_, i) => i >= first && (i - first) % 4 === 0);

  return {
    ...analysis,
    bpm,
    offset: beats[0] ?? 0,
    beats,
    downbeats,
  };
}

/** 格子全体を秒単位でずらす（BPM はそのまま）。 */
export function shiftGrid(
  analysis: BeatAnalysis,
  deltaSeconds: number,
  anchor: GridAnchor,
): BeatAnalysis {
  const time = anchor.time + deltaSeconds;
  if (time < 0 || time >= analysis.duration) return analysis;
  return rebuildGrid(analysis, analysis.bpm, { ...anchor, time });
}
