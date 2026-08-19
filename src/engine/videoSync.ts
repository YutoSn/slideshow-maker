import type { RenderContext } from './renderer';
import { segmentAt } from './renderer';
import { isVideo, type MediaItem, type Segment } from './types';

/**
 * 動画クリップを、曲の時刻に合わせた位置に保つ。
 *
 * 再生中は video 要素に普通に再生させ、ズレたときだけ引き戻す。
 * 毎フレーム currentTime を代入するとシークが詰まって再生が破綻するため。
 * 停止中はシークだけを行う。
 */

/** これ以上ズレたら引き戻す（秒）。小さすぎるとシークが頻発する。 */
const DRIFT_LIMIT = 0.25;
/** 直前・直後どれだけ先のカットまで動かしておくか（秒） */
const PRELOAD_AHEAD = 1.5;

/** そのカットが、いま何秒目のコマを映すべきか。 */
export function clipTimeFor(segment: Segment, item: MediaItem, time: number): number {
  const into = Math.max(0, time - segment.start);
  const from = Math.max(0, segment.videoStart);
  if (item.duration <= 0.05) return from;
  // クリップがカットより短いときは、頭に戻って繰り返す
  const usable = Math.max(0.05, item.duration - from);
  return from + (into % usable);
}

/**
 * いま映すべきカット（とトランジション中の前のカット）の動画を合わせ、
 * それ以外は止めておく。関係ない動画を再生したままにすると重くなる。
 */
export function syncVideos(
  render: RenderContext,
  time: number,
  playing: boolean,
  transitionSeconds: number,
): void {
  const { segments, media } = render;
  if (segments.length === 0) return;

  const index = segmentAt(segments, time);
  const active = new Set<string>();

  // 表示中のカットと、重なって見えている前のカット
  const involved: Segment[] = [segments[index]];
  const previous = segments[index - 1];
  if (previous && time - segments[index].start < transitionSeconds) involved.push(previous);
  // 少し先のカットは、頭出しだけ済ませておく
  const next = segments[index + 1];
  if (next && next.start - time < PRELOAD_AHEAD) involved.push(next);

  for (const segment of involved) {
    const item = media.get(segment.mediaId);
    if (!item || !isVideo(item)) continue;
    active.add(item.id);

    const video = item.element;
    const wanted = clipTimeFor(segment, item, Math.max(time, segment.start));
    const isCurrent = segment === segments[index];

    if (playing && isCurrent) {
      if (video.paused) void video.play().catch(() => undefined);
      // 再生に任せ、ズレが大きくなったときだけ直す
      if (Math.abs(video.currentTime - wanted) > DRIFT_LIMIT) {
        video.currentTime = wanted;
      }
    } else {
      if (!video.paused) video.pause();
      if (Math.abs(video.currentTime - wanted) > 0.02) {
        video.currentTime = wanted;
      }
    }
  }

  // 使っていない動画は止める
  for (const item of media.values()) {
    if (!isVideo(item) || active.has(item.id)) continue;
    if (!item.element.paused) item.element.pause();
  }
}

/** 書き出しの前後などで、すべての動画を止める。 */
export function pauseAllVideos(media: Map<string, MediaItem>): void {
  for (const item of media.values()) {
    if (isVideo(item) && !item.element.paused) item.element.pause();
  }
}
