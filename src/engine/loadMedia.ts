import type { MediaItem } from './types';

/**
 * ファイルから、canvas に描ける素材を作る。
 * 写真は img、動画は video。動画は一覧用にサムネイルも切り出す。
 */

export function mediaIdFor(file: File): string {
  return `${file.name}-${file.size}-${file.lastModified}`;
}

function loadPhoto(file: File, url: string): Promise<MediaItem | null> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () =>
      resolve({
        id: mediaIdFor(file),
        name: file.name,
        url,
        kind: 'photo',
        element: image,
        width: image.naturalWidth,
        height: image.naturalHeight,
        duration: 0,
        thumbnail: url,
      });
    // HEIC などブラウザが表示できない形式は静かに読み飛ばす
    image.onerror = () => {
      URL.revokeObjectURL(url);
      resolve(null);
    };
    image.src = url;
  });
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
  if (file.type.startsWith('image/')) return loadPhoto(file, url);
  URL.revokeObjectURL(url);
  return Promise.resolve(null);
}

export function isMediaFile(file: File): boolean {
  return file.type.startsWith('image/') || file.type.startsWith('video/');
}
