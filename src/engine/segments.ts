import type { BeatAnalysis } from './beatDetect';
import type { Photo, ProjectSettings, Segment, TransitionKind } from './types';

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
  photos: Photo[],
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
      photoId: photo.id,
      start,
      end,
      beats: Math.min(beatsPerPhoto, beats.length - 1 - beatIndex),
      transition:
        settings.transition === 'mixed'
          ? TRANSITIONS[n % TRANSITIONS.length]
          : settings.transition,
      seed: 1000 + n * 7919,
    });

    beatIndex = nextIndex;
    n += 1;
  }

  return segments;
}

/** 1 つのセグメントの長さを拍単位で変え、以降のセグメントを詰め直す。 */
export function resizeSegment(
  segments: Segment[],
  analysis: BeatAnalysis,
  segmentId: string,
  beatsDelta: number,
): Segment[] {
  const index = segments.findIndex((s) => s.id === segmentId);
  if (index === -1) return segments;

  const target = segments[index];
  const nextBeats = Math.max(1, target.beats + beatsDelta);
  if (nextBeats === target.beats) return segments;

  const { beats, duration } = analysis;
  const startIndex = nearestBeatIndex(beats, target.start);

  const updated = segments.slice(0, index);
  let beatIndex = startIndex;

  for (let i = index; i < segments.length; i++) {
    const source = segments[i];
    const beatCount = i === index ? nextBeats : source.beats;
    const start = beats[beatIndex] ?? duration;
    if (start >= duration) break;
    const endIndex = beatIndex + beatCount;
    const end = endIndex < beats.length ? beats[endIndex] : duration;
    updated.push({ ...source, start, end, beats: beatCount });
    beatIndex = endIndex;
  }

  return updated;
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
