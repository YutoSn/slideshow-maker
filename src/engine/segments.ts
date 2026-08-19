import type { BeatAnalysis } from './beatDetect';
import type {
  MediaItem,
  ProjectSettings,
  Segment,
  SegmentOverride,
  TransitionKind,
} from './types';

const TRANSITIONS: TransitionKind[] = ['crossfade', 'zoom', 'slide', 'crossfade', 'whip'];

/** 決定的な擬似乱数（同じ種なら常に同じ演出になる）。 */
export function seededRandom(seed: number): () => number {
  let state = seed >>> 0 || 1;
  return () => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return ((state >>> 0) % 100000) / 100000;
  };
}

/**
 * ビート格子に沿ってセグメントを組み立てる。
 * 写真が足りなければ先頭から巡回して曲の最後まで敷き詰める。
 */
export function buildSegments(
  photos: MediaItem[],
  analysis: BeatAnalysis,
  settings: ProjectSettings,
): Segment[] {
  if (photos.length === 0 || analysis.beats.length < 2) return [];

  const order = photos.map((_, i) => i);
  if (settings.shuffle) {
    const random = seededRandom(20260818);
    for (let i = order.length - 1; i > 0; i--) {
      const j = Math.floor(random() * (i + 1));
      [order[i], order[j]] = [order[j], order[i]];
    }
  }

  const { beats, duration } = analysis;
  const beatsPerPhoto = Math.max(1, Math.round(settings.beatsPerPhoto));
  const segments: Segment[] = [];

  // 最初の小節頭から始めると、曲の入りと画の切り替わりが揃う
  const firstBeat = analysis.downbeats.length > 0 ? beats.indexOf(analysis.downbeats[0]) : 0;
  let beatIndex = Math.max(0, firstBeat);
  let n = 0;

  while (beatIndex < beats.length - 1) {
    const nextIndex = beatIndex + beatsPerPhoto;
    const start = beats[beatIndex];
    // 最後のセグメントはビートを越えて曲の終わりまで伸ばす
    const end = nextIndex < beats.length ? beats[nextIndex] : duration;
    if (end - start < 0.2) break;

    const photo = photos[order[n % order.length]];
    segments.push({
      id: `seg-${n}`,
      mediaId: photo.id,
      start,
      end,
      beats: Math.min(beatsPerPhoto, beats.length - 1 - beatIndex),
      transition:
        settings.transition === 'mixed'
          ? TRANSITIONS[n % TRANSITIONS.length]
          : settings.transition,
      fit: settings.fit,
      videoStart: 0,
      seed: 1000 + n * 7919,
    });

    beatIndex = nextIndex;
    n += 1;
  }

  return segments;
}

/**
 * 生成されたセグメント列に手編集を重ねる。
 * 尺を変えると以降のカットがずれるため、ビート格子の上で順に詰め直す。
 */
export function applyOverrides(
  base: Segment[],
  overrides: Record<string, SegmentOverride>,
  analysis: BeatAnalysis,
  availableMediaIds: Set<string>,
): Segment[] {
  if (base.length === 0) return base;

  const { beats, duration } = analysis;
  let beatIndex = nearestBeatIndex(beats, base[0].start);
  const result: Segment[] = [];

  for (const segment of base) {
    const override = overrides[segment.id];
    const beatCount = Math.max(1, Math.round(override?.beats ?? segment.beats));

    const start = beats[beatIndex];
    if (start === undefined || start >= duration) break;
    const endIndex = beatIndex + beatCount;
    const end = endIndex < beats.length ? beats[endIndex] : duration;
    if (end - start < 0.2) break;

    // 割り当て先の写真が外されていたら、自動割り当てに戻す
    const assigned =
      override?.mediaId && availableMediaIds.has(override.mediaId)
        ? override.mediaId
        : segment.mediaId;

    result.push({
      ...segment,
      mediaId: assigned,
      transition: override?.transition ?? segment.transition,
      fit: override?.fit ?? segment.fit,
      videoStart: override?.videoStart ?? segment.videoStart,
      start,
      end,
      beats: beatCount,
    });
    beatIndex = endIndex;
  }

  return result;
}

export function nearestBeatIndex(beats: number[], time: number): number {
  let best = 0;
  let bestDistance = Infinity;
  for (let i = 0; i < beats.length; i++) {
    const distance = Math.abs(beats[i] - time);
    if (distance < bestDistance) {
      bestDistance = distance;
      best = i;
    }
  }
  return best;
}
