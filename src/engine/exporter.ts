import type { BeatAnalysis } from './beatDetect';
import { renderFrame, type RenderContext } from './renderer';
import type { MediaItem } from './types';
import { pauseAllVideos, syncVideos } from './videoSync';
import { fixWebmDuration } from './webmDuration';

export interface ExportOptions {
  width: number;
  height: number;
  fps: number;
  /** 映像のビットレート（bps）。ファイルサイズはおおむねこれで決まる。 */
  videoBitsPerSecond: number;
  audioBitsPerSecond: number;
  onProgress: (ratio: number) => void;
  signal: AbortSignal;
}

export type QualityPreset = 'high' | 'standard' | 'light';

export const QUALITY_PRESETS: Record<
  QualityPreset,
  { label: string; width: number; height: number; videoBitsPerSecond: number }
> = {
  high: { label: '高画質（720p）', width: 1280, height: 720, videoBitsPerSecond: 4_000_000 },
  standard: { label: '標準（720p）', width: 1280, height: 720, videoBitsPerSecond: 1_500_000 },
  light: { label: '軽量（540p）', width: 960, height: 540, videoBitsPerSecond: 600_000 },
};

/** 書き出し後のおおよそのファイルサイズ（MB）。 */
export function estimateSizeMb(
  durationSeconds: number,
  videoBitsPerSecond: number,
  audioBitsPerSecond: number,
): number {
  return ((videoBitsPerSecond + audioBitsPerSecond) * durationSeconds) / 8 / 1e6;
}

/** ブラウザが実際に書き出せる形式を選ぶ。 */
function pickMimeType(): string {
  const candidates = [
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
    'video/mp4',
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}

/** 進捗表示を更新する間隔（ms）。毎フレーム画面全体を描き直すと録画が詰まる */
const PROGRESS_INTERVAL_MS = 250;

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
async function prepareMedia(
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

/**
 * canvas の描画と音声を 1 本の MediaStream にまとめて録画する。
 * MediaRecorder は実時間でしか録れないため、書き出しには曲の長さぶんかかる。
 */
export async function exportVideo(
  render: RenderContext,
  audioFile: File,
  options: ExportOptions,
): Promise<Blob> {
  const { width, height, fps, videoBitsPerSecond, audioBitsPerSecond, onProgress, signal } =
    options;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D コンテキストを取得できませんでした');

  const { media, release } = await prepareMedia(render.media, width, height);
  const job: RenderContext = { ...render, media };

  const audio = new Audio(URL.createObjectURL(audioFile));
  audio.crossOrigin = 'anonymous';
  try {
    await new Promise<void>((resolve, reject) => {
      audio.onloadedmetadata = () => resolve();
      audio.onerror = () => reject(new Error('音源を読み込めませんでした'));
    });
  } catch (cause) {
    release();
    URL.revokeObjectURL(audio.src);
    throw cause;
  }

  const audioContext = new AudioContext();
  const source = audioContext.createMediaElementSource(audio);
  const destination = audioContext.createMediaStreamDestination();
  source.connect(destination);

  // コマは自分で送る（captureStream(0) + requestFrame）。
  // 描いた時刻どおりの一定間隔になり、画面の更新周期とのズレでコマが
  // 重複したり抜けたりしない。対応していないブラウザでは従来どおり自動で取り込む。
  let stream = canvas.captureStream(0);
  let track = stream.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
  const manualFrames = typeof track?.requestFrame === 'function';
  if (!manualFrames) {
    for (const t of stream.getTracks()) t.stop();
    stream = canvas.captureStream(fps);
    track = undefined;
  }
  for (const t of destination.stream.getAudioTracks()) stream.addTrack(t);

  const mimeType = pickMimeType();
  const recorder = new MediaRecorder(stream, {
    ...(mimeType ? { mimeType } : {}),
    videoBitsPerSecond,
    audioBitsPerSecond,
  });
  const chunks: BlobPart[] = [];
  recorder.ondataavailable = (event) => {
    if (event.data.size > 0) chunks.push(event.data);
  };

  const duration = job.analysis.duration;
  // 動画クリップを進めるのに必要（プレビューと同じ計算にそろえる）
  const transitionSeconds = (job.settings.transitionBeats * 60) / job.analysis.bpm;
  let frameHandle = 0;

  const cleanup = () => {
    cancelAnimationFrame(frameHandle);
    pauseAllVideos(job.media);
    audio.pause();
    for (const t of stream.getTracks()) t.stop();
    void audioContext.close();
    URL.revokeObjectURL(audio.src);
    release();
  };

  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
    recorder.onerror = () => reject(new Error('録画中にエラーが発生しました'));
  });

  /**
   * 録画の時計。audio.currentTime はブラウザによって数十 ms 刻みでしか
   * 進まず、そのまま使うと動きが階段状になる。経過時間で補間し、
   * 大きくズレたときだけ音声の位置に合わせ直す。
   */
  let clockBase = { media: 0, wall: performance.now() };
  const clock = (): number => {
    const media = audio.currentTime;
    const now = performance.now();
    const estimated = clockBase.media + (now - clockBase.wall) / 1000;
    if (audio.paused || Math.abs(estimated - media) > 0.08) {
      clockBase = { media, wall: now };
      return media;
    }
    return estimated;
  };

  let lastFrame = -1;
  let lastProgressAt = 0;

  const tick = () => {
    if (signal.aborted) {
      if (recorder.state !== 'inactive') recorder.stop();
      return;
    }
    const now = clock();
    if (audio.ended || now >= duration - 0.05) {
      onProgress(1);
      if (recorder.state !== 'inactive') recorder.stop();
      return;
    }

    // 1/fps 秒ごとの決まった時刻で 1 コマずつ描く
    const frame = Math.floor(now * fps);
    if (frame !== lastFrame) {
      lastFrame = frame;
      const time = manualFrames ? frame / fps : now;
      // これを呼ばないと動画は止まったコマのまま録画される
      syncVideos(job, time, true, transitionSeconds);
      renderFrame(ctx, time, job);
      track?.requestFrame();
    }

    const wall = performance.now();
    if (wall - lastProgressAt >= PROGRESS_INTERVAL_MS) {
      lastProgressAt = wall;
      onProgress(Math.min(1, now / duration));
    }
    frameHandle = requestAnimationFrame(tick);
  };

  await audioContext.resume();
  // 先頭のコマを合わせてから録り始める
  syncVideos(job, 0, false, transitionSeconds);
  renderFrame(ctx, 0, job);
  recorder.start(1000);
  track?.requestFrame();
  await audio.play();
  clockBase = { media: audio.currentTime, wall: performance.now() };
  tick();

  try {
    const recorded = await finished;
    // MediaRecorder は総再生時間を書かないので、ここで補ってから返す
    return await fixWebmDuration(recorded, audio.currentTime || duration);
  } finally {
    cleanup();
  }
}

/** 解析結果を JSON で持ち出せるようにする（編集結果の共有・再現用）。 */
export function analysisToJson(analysis: BeatAnalysis): string {
  return JSON.stringify(
    {
      bpm: Number(analysis.bpm.toFixed(2)),
      offset: Number(analysis.offset.toFixed(4)),
      duration: Number(analysis.duration.toFixed(3)),
      beatCount: analysis.beats.length,
      beats: analysis.beats.map((t) => Number(t.toFixed(4))),
      downbeats: analysis.downbeats.map((t) => Number(t.toFixed(4))),
    },
    null,
    2,
  );
}
