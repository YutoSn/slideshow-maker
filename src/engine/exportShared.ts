import type { MediaItem } from './types';

export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  /** 映像のビットレート（bps）。ファイルサイズはおおむねこれで決まる。 */
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
  onProgress: (ratio: number) => void;
  /** どちらの方式で書き出すかが決まったときに呼ばれる */
  onMode?: (mode: ExportMode) => void;
  signal: AbortSignal;
}

/**
 * offline: WebCodecs で 1 コマずつ描いて符号化する。コマの時刻が正確で、
 *          カクつかず、実時間より速く終わる。
 * realtime: 対応していないブラウザ向け。画面を録画する方式で、曲の長さぶんかかる。
 */
export type ExportMode = 'offline' | 'realtime';

/** 進捗表示を更新する間隔（ms）。毎フレーム画面全体を描き直すと録画が詰まる */
export const PROGRESS_INTERVAL_MS = 250;

/**
 * 拡大の演出（Ken Burns・拍の拡大・ズーム系のトランジション）で
 * 最大どれくらい大きく描かれるか。これを見込んで縮小しておく。
 */
const MAX_DRAW_SCALE = 1.6;

/**
 * 写真を書き出しの解像度まで縮め、デコード済みの ImageBitmap にしておく。
 *
 * 元の写真（数千 px の JPEG）を毎フレーム縮小して描くと重く、
 * カットが切り替わる瞬間にはデコードも走るため、そこで録画がカクつく。
 */
export async function prepareMedia(
  media: Map<string, MediaItem>,
  width: number,
  height: number,
): Promise<{ media: Map<string, MediaItem>; release: () => void }> {
  const bitmaps: ImageBitmap[] = [];
  const prepared = new Map<string, MediaItem>();

  await Promise.all(
    Array.from(media.values()).map(async (item) => {
      if (item.kind !== 'photo' || typeof createImageBitmap !== 'function') {
        prepared.set(item.id, item);
        return;
      }
      const scale = Math.max(width / item.width, height / item.height) * MAX_DRAW_SCALE;
      try {
        const bitmap =
          scale >= 1
            ? await createImageBitmap(item.element as HTMLImageElement)
            : await createImageBitmap(item.element as HTMLImageElement, {
                resizeWidth: Math.max(1, Math.round(item.width * scale)),
                resizeHeight: Math.max(1, Math.round(item.height * scale)),
                resizeQuality: 'high',
              });
        bitmaps.push(bitmap);
        // 縦横比の計算は元の大きさのまま使う（drawImage が描く大きさに合わせる）
        prepared.set(item.id, { ...item, element: bitmap });
      } catch {
        prepared.set(item.id, item);
      }
    }),
  );

  return {
    media: prepared,
    release: () => {
      for (const bitmap of bitmaps) bitmap.close();
    },
  };
}

/** 書き出しを中止したときに投げる。呼び出し側はこれをエラーとして扱わない */
export class ExportAborted extends Error {
  constructor() {
    super('書き出しを中止しました');
    this.name = 'ExportAborted';
  }
}
