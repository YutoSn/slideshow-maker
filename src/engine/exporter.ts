import type { BeatAnalysis } from './beatDetect';
import {
  PROGRESS_INTERVAL_MS,
  prepareMedia,
  type ExportContainer,
  type ExportOptions,
  type ExportResult,
} from './exportShared';
import { createMediaClock } from './mediaClock';
import { renderFrame, type RenderContext } from './renderer';
import { pauseAllVideos, syncVideos } from './videoSync';
import { fixWebmDuration } from './webmDuration';

export {
  ExportAborted,
  type ExportContainer,
  type ExportMode,
  type ExportOptions,
  type ExportResult,
} from './exportShared';

export type QualityPreset = 'full' | 'high' | 'standard' | 'light';

/**
 * 画質の段階。大きさは短い辺で決め、向き（横長・縦長）は書き出し時に当てはめる
 * （`frameSize()`）。縦長でも画素数は同じなので、ビットレートも同じでよい。
 */
export const QUALITY_PRESETS: Record<
  QualityPreset,
  { label: string; shortSide: number; videoBitsPerSecond: number }
> = {
  full: { label: '最高画質（1080p）', shortSide: 1080, videoBitsPerSecond: 8_000_000 },
  high: { label: '高画質（720p）', shortSide: 720, videoBitsPerSecond: 4_000_000 },
  standard: { label: '標準（720p）', shortSide: 720, videoBitsPerSecond: 1_500_000 },
  light: { label: '軽量（540p）', shortSide: 540, videoBitsPerSecond: 600_000 },
};

/** 書き出し後のおおよそのファイルサイズ（MB）。 */
export function estimateSizeMb(
  durationSeconds: number,
  videoBitsPerSecond: number,
  audioBitsPerSecond: number,
): number {
  return ((videoBitsPerSecond + audioBitsPerSecond) * durationSeconds) / 8 / 1e6;
}

/** ブラウザが実際に書き出せる形式を選ぶ。スマホや SNS で扱いやすい MP4 を優先する。 */
function pickMimeType(): string {
  const candidates = [
    'video/mp4;codecs=avc1,mp4a.40.2',
    'video/mp4;codecs=avc1,opus',
    'video/mp4',
    'video/webm;codecs=vp9,opus',
    'video/webm;codecs=vp8,opus',
    'video/webm',
  ];
  for (const type of candidates) {
    if (MediaRecorder.isTypeSupported(type)) return type;
  }
  return '';
}


/**
 * canvas の描画と音声を 1 本の MediaStream にまとめて録画する。
 * MediaRecorder は実時間でしか録れないため、書き出しには曲の長さぶんかかる。
 */
async function exportRealtime(
  render: RenderContext,
  audioFile: File,
  options: ExportOptions,
): Promise<ExportResult> {
  const { width, height, fps, videoBitsPerSecond, audioBitsPerSecond, onProgress, signal } =
    options;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D コンテキストを取得できませんでした');

  const { media, release } = await prepareMedia(render.media, width, height);
  // プレビュー用の縮めた画像ではなく、書き出し用に用意した画像で描く
  const job: RenderContext = { ...render, media, imageFor: undefined };

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
  const container: ExportContainer = mimeType.startsWith('video/mp4') ? 'mp4' : 'webm';
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
    recorder.onstop = () =>
      resolve(new Blob(chunks, { type: container === 'mp4' ? 'video/mp4' : 'video/webm' }));
    recorder.onerror = () => reject(new Error('録画中にエラーが発生しました'));
  });

  // audio.currentTime の粗い刻みを、経過時間で補って滑らかにする
  let clock = createMediaClock(audio);

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
  clock = createMediaClock(audio);
  tick();

  try {
    const recorded = await finished;
    if (container === 'mp4') return { blob: recorded, container };
    // MediaRecorder の WebM には総再生時間が書かれないので、ここで補ってから返す
    const blob = await fixWebmDuration(recorded, audio.currentTime || duration);
    return { blob, container };
  } finally {
    cleanup();
  }
}

/** WebCodecs で書き出せるなら、その実装（書き出し時にだけ読み込む）と使う形式を返す。 */
async function loadOfflineExport(options: ExportOptions) {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') return null;
  try {
    const module = await import('./offlineExport');
    const codecs = await module.offlineCodecs(options);
    return codecs ? { module, codecs } : null;
  } catch {
    // 読み込めない・判定できないときは録画方式に任せる
    return null;
  }
}

/** 書き出す。WebCodecs が使えれば offline、使えなければ realtime。 */
export async function exportVideo(
  render: RenderContext,
  audioFile: File,
  options: ExportOptions,
): Promise<ExportResult> {
  const offline = await loadOfflineExport(options);
  if (offline) {
    options.onMode?.('offline');
    const blob = await offline.module.exportOffline(render, audioFile, options, offline.codecs);
    return { blob, container: offline.codecs.container };
  }
  options.onMode?.('realtime');
  return exportRealtime(render, audioFile, options);
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
