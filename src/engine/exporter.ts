import type { BeatAnalysis } from './beatDetect';
import { renderFrame, type RenderContext } from './renderer';
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

  const audio = new Audio(URL.createObjectURL(audioFile));
  audio.crossOrigin = 'anonymous';
  await new Promise<void>((resolve, reject) => {
    audio.onloadedmetadata = () => resolve();
    audio.onerror = () => reject(new Error('音源を読み込めませんでした'));
  });

  const audioContext = new AudioContext();
  const source = audioContext.createMediaElementSource(audio);
  const destination = audioContext.createMediaStreamDestination();
  source.connect(destination);

  const stream = canvas.captureStream(fps);
  for (const track of destination.stream.getAudioTracks()) stream.addTrack(track);

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

  const duration = render.analysis.duration;
  let frameHandle = 0;

  const cleanup = () => {
    cancelAnimationFrame(frameHandle);
    audio.pause();
    for (const track of stream.getTracks()) track.stop();
    void audioContext.close();
    URL.revokeObjectURL(audio.src);
  };

  const finished = new Promise<Blob>((resolve, reject) => {
    recorder.onstop = () => resolve(new Blob(chunks, { type: mimeType || 'video/webm' }));
    recorder.onerror = () => reject(new Error('録画中にエラーが発生しました'));
  });

  const tick = () => {
    if (signal.aborted) {
      if (recorder.state !== 'inactive') recorder.stop();
      return;
    }
    const time = audio.currentTime;
    renderFrame(ctx, time, render);
    onProgress(Math.min(1, time / duration));
    if (audio.ended || time >= duration - 0.05) {
      if (recorder.state !== 'inactive') recorder.stop();
      return;
    }
    frameHandle = requestAnimationFrame(tick);
  };

  await audioContext.resume();
  recorder.start(1000);
  await audio.play();
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
