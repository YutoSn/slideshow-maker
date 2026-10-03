import type { MediaItem } from './types';

/**
 * ファイルから、canvas に描ける素材を作る。
 * 写真は img、動画は video。動画は一覧用にサムネイルも切り出す。
 */

export function mediaIdFor(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

/** 描画の代役に使う小さな画像の長辺（px）。本命の画像が間に合わないときに使う */
const LOWRES_EDGE = 480;
/** 一覧（素材プール・タイムライン）のサムネイルの長辺（px） */
const THUMB_EDGE = 200;

/**
 * 写真を長辺 edge px まで縮めた画像にする。
 * ファイルから直接 createImageBitmap すると、展開と縮小がメインスレッドの外で行われる。
 * 使えないブラウザでは、読み込み済みの img から canvas に縮めて描く。
 */
export async function shrinkPhoto(
  source: Blob,
  fallback: HTMLImageElement,
  width: number,
  height: number,
  edge: number,
): Promise<ImageBitmap | HTMLCanvasElement> {
  const scale = Math.min(1, edge / Math.max(width, height));
  const w = Math.max(1, Math.round(width * scale));
  const h = Math.max(1, Math.round(height * scale));
  try {
    return await createImageBitmap(source, {
      resizeWidth: w,
      resizeHeight: h,
      resizeQuality: 'high',
    });
  } catch {
    const canvas = document.createElement('canvas');
    canvas.width = w;
    canvas.height = h;
    canvas.getContext('2d')?.drawImage(fallback, 0, 0, w, h);
    return canvas;
  }
}

/** 小さな画像から、一覧用の JPEG を作って URL にする */
async function thumbnailFrom(image: CanvasImageSource, width: number, height: number): Promise<string> {
  const scale = Math.min(1, THUMB_EDGE / Math.max(width, height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width * scale));
  canvas.height = Math.max(1, Math.round(height * scale));
  canvas.getContext('2d')?.drawImage(image, 0, 0, canvas.width, canvas.height);
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, 'image/jpeg', 0.8),
  );
  return blob ? URL.createObjectURL(blob) : canvas.toDataURL('image/jpeg', 0.8);
}

/**
 * iPhone の写真（HEIC / HEIF）かどうか。
 * Windows では MIME が空になることがあるので、拡張子でも見る。
 */
export function isHeicFile(file: File): boolean {
  return /^image\/hei[cf](-sequence)?$/i.test(file.type) || /\.hei[cf]$/i.test(file.name);
}

/** HEIC の変換は重いので、1 枚ずつ順番に流す */
let heicQueue: Promise<unknown> = Promise.resolve();

/**
 * HEIC を JPEG に変換する。変換器（数 MB）は HEIC が来たときだけ読み込む。
 * 変換に失敗したら null。
 */
function heicToJpeg(file: File): Promise<Blob | null> {
  const run = heicQueue.then(async () => {
    try {
      const { heicTo } = await import('heic-to');
      return await heicTo({ blob: file, type: 'image/jpeg', quality: 0.92 });
    } catch {
      return null;
    }
  });
  heicQueue = run;
  return run;
}

/** URL の画像を img に読み込む。表示できない形式なら null。 */
function decodeImage(url: string): Promise<HTMLImageElement | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => resolve(null);
    image.src = url;
  });
}

/**
 * 写真を読み込む。
 *
 * スマホの写真（1200 万画素など）をそのまま一覧に並べたりプレビューに描いたりすると、
 * 展開に時間がかかり、切り替わりのたびに画面が止まる。
 * 読み込み時に小さな画像とサムネイルを作っておき、元の画像は書き出しにだけ使う。
 *
 * HEIC は Safari ならそのまま表示できるので、まずはそのまま試し、
 * 表示できなければ JPEG に変換してから読み込む。
 */
async function loadPhoto(file: File, url: string): Promise<MediaItem | null> {
  let source: Blob = file;
  let image = await decodeImage(url);
  if (!image && isHeicFile(file)) {
    URL.revokeObjectURL(url);
    const jpeg = await heicToJpeg(file);
    if (!jpeg) return null;
    source = jpeg;
    url = URL.createObjectURL(jpeg);
    image = await decodeImage(url);
  }
  // ブラウザが表示できず、変換もできない形式は静かに読み飛ばす
  if (!image) {
    URL.revokeObjectURL(url);
    return null;
  }

  const width = image.naturalWidth;
  const height = image.naturalHeight;
  const lowres = await shrinkPhoto(source, image, width, height, LOWRES_EDGE);
  const thumbnail = await thumbnailFrom(lowres, width, height).catch(() => url);
  return {
    id: mediaIdFor(file),
    name: file.name,
    url,
    kind: 'photo',
    element: image,
    width,
    height,
    duration: 0,
    thumbnail,
    lowres,
  };
}

/** 動画の先頭付近から 1 コマ取り出して、一覧用の小さな画像にする。 */
function grabThumbnail(video: HTMLVideoElement): string {
  const canvas = document.createElement('canvas');
  const scale = Math.min(1, 160 / Math.max(1, video.videoWidth));
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  const ctx = canvas.getContext('2d');
  if (!ctx) return '';
  ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas.toDataURL('image/jpeg', 0.7);
}

function loadVideo(file: File, url: string): Promise<MediaItem | null> {
  return new Promise((resolve) => {
    const video = document.createElement('video');
    video.src = url;
    video.muted = true; // 音は曲を使うので鳴らさない
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';

    let settled = false;
    const done = (item: MediaItem | null) => {
      if (settled) return;
      settled = true;
      resolve(item);
    };

    video.onloadeddata = () => {
      const finish = () => {
        done({
          id: mediaIdFor(file),
          name: file.name,
          url,
          kind: 'video',
          element: video,
          width: video.videoWidth,
          height: video.videoHeight,
          duration: Number.isFinite(video.duration) ? video.duration : 0,
          thumbnail: grabThumbnail(video) || url,
        });
      };

      // 先頭は真っ黒なことが多いので、少し進めた位置のコマを使う
      const at = Math.min(0.4, (video.duration || 1) * 0.1);
      if (video.currentTime < at - 0.01) {
        video.onseeked = () => {
          video.onseeked = null;
          finish();
        };
        video.currentTime = at;
      } else {
        finish();
      }
    };

    video.onerror = () => {
      URL.revokeObjectURL(url);
      done(null);
    };

    // 壊れたファイルで固まらないよう、頭打ちを設ける
    setTimeout(() => {
      if (!settled) {
        URL.revokeObjectURL(url);
        done(null);
      }
    }, 20000);
  });
}

/** 画像でも動画でも受け取れる読み込み口。対応していないものは null。 */
export function loadMedia(file: File): Promise<MediaItem | null> {
  const url = URL.createObjectURL(file);
  if (file.type.startsWith('video/')) return loadVideo(file, url);
  if (file.type.startsWith('image/') || isHeicFile(file)) return loadPhoto(file, url);
  URL.revokeObjectURL(url);
  return Promise.resolve(null);
}

export function isMediaFile(file: File): boolean {
  return file.type.startsWith('image/') || file.type.startsWith('video/') || isHeicFile(file);
}
