import type { BeatAnalysis } from './beatDetect';
import { PROGRESS_INTERVAL_MS, prepareMedia, type ExportOptions } from './exportShared';
import { createMediaClock } from './mediaClock';
import { renderFrame, type RenderContext } from './renderer';
import { pauseAllVideos, syncVideos } from './videoSync';
import { fixWebmDuration } from './webmDuration';

export { ExportAborted, type ExportMode, type ExportOptions } from './exportShared';



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


/**
 * canvas の描画と音声を 1 本の MediaStream にまとめて録画する。
 * MediaRecorder は実時間でしか録れないため、書き出しには曲の長さぶんかかる。
 */
async function exportRealtime(
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
    // MediaRecorder は総再生時間を書かないので、ここで補ってから返す
    return await fixWebmDuration(recorded, audio.currentTime || duration);
  } finally {
    cleanup();
  }
}

/** WebCodecs で書き出せるなら、その実装（書き出し時にだけ読み込む）と使うコーデックを返す。 */
async function loadOfflineExport(options: ExportOptions) {
  if (typeof VideoEncoder === 'undefined' || typeof AudioEncoder === 'undefined') return null;
  try {
    const module = await import('./offlineExport');
    const codec = await module.offlineVideoCodec(options);
    return codec ? { module, codec } : null;
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
): Promise<Blob> {
  const offline = await loadOfflineExport(options);
  if (offline) {
    options.onMode?.('offline');
    return offline.module.exportOffline(render, audioFile, options, offline.codec);
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
