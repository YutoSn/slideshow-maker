import { segmentAt } from './renderer';
import type { MediaItem, Segment } from './types';

/**
 * プレビューに描く写真の置き場。
 *
 * スマホの写真（4032×3024 など）をそのまま毎コマ縮小して描くと重く、
 * 新しい写真を初めて描く瞬間には展開も走るため、切り替わりのたびに画面が止まっていた。
 * ここではプレビューに十分な大きさ（長辺 1600px）に縮めた画像を、メインスレッドの外で作って置いておく。
 *
 * すべての写真を持つとメモリを食うので、最近使ったものだけを残す。
 * 次に映るカットの分は先に作り始め、間に合わないときは小さな代役（lowres）を描く。
 * 書き出しはこの置き場を使わず、元の写真から作る。
 */

/** プレビュー用の長辺（px）。プレビューは最大 1280×720 で、寄りの演出ぶんの余裕を見る */
const PREVIEW_EDGE = 1600;
/** 置いておく枚数。長辺 1600px なら 1 枚およそ 8MB */
const LIMIT = 16;
/** いまのカットから、いくつ先まで準備しておくか */
const LOOKAHEAD_CUTS = 3;

/** 停止中は、再生を始めたときに備えてもう少し先まで用意しておく */
const LOOKAHEAD_CUTS_PAUSED = 6;

const cache = new Map<string, ImageBitmap>();
const listeners = new Set<() => void>();

/**
 * 作る順番待ち。一度に 1 枚ずつ、近いカットから作る。
 * まとめて何枚も作り始めると、展開の処理が描画と取り合って、かえって画が止まる。
 */
let queue: MediaItem[] = [];
let working: string | null = null;

function remember(id: string, bitmap: ImageBitmap): void {
  cache.set(id, bitmap);
  while (cache.size > LIMIT) {
    const oldest = cache.keys().next().value as string;
    cache.get(oldest)?.close();
    cache.delete(oldest);
  }
}

async function build(item: MediaItem): Promise<void> {
  const blob = await (await fetch(item.url)).blob();
  const scale = Math.min(1, PREVIEW_EDGE / Math.max(item.width, item.height));
  const bitmap = await createImageBitmap(
    blob,
    scale < 1
      ? {
          resizeWidth: Math.max(1, Math.round(item.width * scale)),
          resizeHeight: Math.max(1, Math.round(item.height * scale)),
          resizeQuality: 'high',
        }
      : {},
  );
  remember(item.id, bitmap);
  for (const listener of listeners) listener();
}

function pump(): void {
  if (working !== null) return;
  const next = queue.shift();
  if (!next) return;
  if (cache.has(next.id)) {
    pump();
    return;
  }
  working = next.id;
  build(next)
    .catch(() => {
      // 作れなくても、代役か元の画像で描ける
    })
    .finally(() => {
      working = null;
      pump();
    });
}

/**
 * プレビュー用の画像を作る順番に並べる（作り済み・作成中なら何もしない）。
 * urgent なら列の先頭に入れる（いま映すのに要るもの）。
 */
export function requestPreview(item: MediaItem, urgent = false): void {
  if (item.kind !== 'photo' || cache.has(item.id) || working === item.id) return;
  if (typeof createImageBitmap !== 'function') return;
  queue = queue.filter((queued) => queued.id !== item.id);
  if (urgent) queue.unshift(item);
  else queue.push(item);
  pump();
}

/**
 * プレビューで描く画像。用意できていればプレビュー用、まだなら代役を返す。
 * 写真以外（動画）はそのまま。
 */
export function previewImage(item: MediaItem): CanvasImageSource {
  if (item.kind !== 'photo') return item.element;
  const ready = cache.get(item.id);
  if (ready) {
    // 最近使ったものとして後ろへ回す
    cache.delete(item.id);
    cache.set(item.id, ready);
    return ready;
  }
  if (!queue.some((queued) => queued.id === item.id)) requestPreview(item, true);
  return item.lowres ?? item.element;
}

let lastPrefetch = '';

/**
 * いま映っているカットと、その少し先のカットの画像を、近い順に作っておく。
 * 停止中は再生に備えて、さらに先まで用意する。
 */
export function prefetchAround(
  segments: Segment[],
  media: Map<string, MediaItem>,
  time: number,
  playing = true,
): void {
  if (segments.length === 0) return;
  const index = segmentAt(segments, time);
  // 同じカットにいるあいだは、何度も並べ直さない
  const key = `${segments.length}:${index}:${segments[index]?.mediaId}:${playing}`;
  if (key === lastPrefetch) return;
  lastPrefetch = key;

  const ahead = playing ? LOOKAHEAD_CUTS : LOOKAHEAD_CUTS_PAUSED;
  const order: MediaItem[] = [];
  const push = (i: number) => {
    const item = segments[i] && media.get(segments[i].mediaId);
    if (item && item.kind === 'photo' && !order.includes(item)) order.push(item);
  };
  for (let i = index; i <= index + ahead && i < segments.length; i++) push(i);
  // トランジションで重なる前のカットは最後でよい
  if (index > 0) push(index - 1);

  // 並べ直す。もう要らなくなった順番待ちは捨てる
  queue = [];
  for (const item of order) requestPreview(item);
}

/** プレビュー用の画像ができたら呼ばれる（停止中の描き直しに使う）。 */
export function onPreviewReady(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
