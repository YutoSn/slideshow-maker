import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Output,
  Quality,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
} from 'mediabunny';
import { decodeAudioFile } from './audio';
import {
  ExportAborted,
  PROGRESS_INTERVAL_MS,
  prepareMedia,
  type ExportOptions,
} from './exportShared';
import { renderFrame, segmentAt, type RenderContext } from './renderer';
import { isVideo, type Segment } from './types';
import { clipTimeFor, pauseAllVideos } from './videoSync';

/**
 * WebCodecs による書き出し。mediabunny ごと重いので、書き出すときにだけ読み込む
 * （exporter.ts から動的に import される）。
 */

/** WebCodecs で書き出せるなら、使う映像コーデックを返す。 */
export async function offlineVideoCodec(options: ExportOptions): Promise<'vp9' | 'vp8' | null> {
  try {
    const audioOk = await canEncodeAudio('opus', {
      numberOfChannels: 2,
      sampleRate: OPUS_SAMPLE_RATE,
      quality: new Quality({ bitrate: options.audioBitsPerSecond }),
    });
    if (!audioOk) return null;
    for (const codec of ['vp9', 'vp8'] as const) {
      const videoOk = await canEncodeVideo(codec, {
        width: options.width,
        height: options.height,
        frameRate: options.fps,
        quality: new Quality({ bitrate: options.videoBitsPerSecond }),
      });
      if (videoOk) return codec;
    }
  } catch {
    // 読み込めない・判定できないときは録画方式に任せる
  }
  return null;
}

/** Opus は 48kHz で符号化する */
const OPUS_SAMPLE_RATE = 48_000;

/** 音源を 48kHz・ステレオにそろえる（Opus の符号化器が受け付ける形） */
async function audioForOpus(file: File): Promise<AudioBuffer> {
  const decoded = await decodeAudioFile(file);
  const frames = Math.ceil(decoded.duration * OPUS_SAMPLE_RATE);
  const offline = new OfflineAudioContext(2, Math.max(1, frames), OPUS_SAMPLE_RATE);
  const source = offline.createBufferSource();
  source.buffer = decoded;
  source.connect(offline.destination);
  source.start();
  return offline.startRendering();
}

/** 動画のシークが終わるのを待つ（終わらないときも固まらないよう上限を設ける） */
function seekVideo(video: HTMLVideoElement, time: number): Promise<void> {
  if (Math.abs(video.currentTime - time) < 0.001 && video.readyState >= 2) return Promise.resolve();
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      video.removeEventListener('seeked', done);
      resolve();
    };
    const timer = setTimeout(done, 2000);
    video.addEventListener('seeked', done);
    video.currentTime = time;
  });
}

/** この時刻に映る（トランジションで重なる前のカットも含む）動画を、正しいコマに合わせる */
async function seekVideosAt(
  job: RenderContext,
  time: number,
  transitionSeconds: number,
): Promise<void> {
  const { segments, media } = job;
  if (segments.length === 0) return;
  const index = segmentAt(segments, time);
  const involved: Segment[] = [segments[index]];
  const previous = segments[index - 1];
  if (previous && time - segments[index].start < transitionSeconds) involved.push(previous);

  for (const segment of involved) {
    const item = media.get(segment.mediaId);
    if (!item || !isVideo(item)) continue;
    await seekVideo(item.element, clipTimeFor(segment, item, Math.max(time, segment.start)));
  }
}

/**
 * WebCodecs で書き出す。1/fps 秒ごとの時刻で 1 コマずつ描いて符号化するので、
 * 端末が重くてもコマが抜けたり時刻がずれたりしない。
 * 音声は元の音源をそのまま符号化する（録音しないので、音質も落ちない）。
 */
export async function exportOffline(
  render: RenderContext,
  audioFile: File,
  options: ExportOptions,
  videoCodec: 'vp9' | 'vp8',
): Promise<Blob> {
  const { width, height, fps, videoBitsPerSecond, audioBitsPerSecond, onProgress, signal } =
    options;

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d', { alpha: false });
  if (!ctx) throw new Error('2D コンテキストを取得できませんでした');

  const [{ media, release }, audioBuffer] = await Promise.all([
    prepareMedia(render.media, width, height),
    audioForOpus(audioFile),
  ]);
  // プレビュー用の縮めた画像ではなく、書き出し用に用意した画像で描く
  const job: RenderContext = { ...render, media, imageFor: undefined };
  pauseAllVideos(job.media);

  const output = new Output({ format: new WebMOutputFormat(), target: new BufferTarget() });
  const video = new CanvasSource(canvas, {
    codec: videoCodec,
    quality: new Quality({ bitrate: videoBitsPerSecond }),
    keyFrameInterval: 2,
  });
  const audio = new AudioBufferSource({
    codec: 'opus',
    quality: new Quality({ bitrate: audioBitsPerSecond }),
  });
  output.addVideoTrack(video, { frameRate: fps });
  output.addAudioTrack(audio);

  const duration = job.analysis.duration;
  const transitionSeconds = (job.settings.transitionBeats * 60) / job.analysis.bpm;
  const total = Math.max(1, Math.round(duration * fps));

  try {
    await output.start();
    await audio.add(audioBuffer);
    audio.close();

    let lastYield = performance.now();
    let lastProgress = 0;
    for (let frame = 0; frame < total; frame++) {
      if (signal.aborted) throw new ExportAborted();
      const time = frame / fps;
      await seekVideosAt(job, time, transitionSeconds);
      renderFrame(ctx, time, job);
      await video.add(time, 1 / fps);

      // ときどき手を離して、進捗の表示や中止ボタンが動けるようにする
      const now = performance.now();
      if (now - lastProgress >= PROGRESS_INTERVAL_MS) {
        lastProgress = now;
        onProgress(frame / total);
      }
      if (now - lastYield >= 50) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        lastYield = performance.now();
      }
    }
    video.close();
    await output.finalize();
    onProgress(1);

    const buffer = output.target.buffer;
    if (!buffer) throw new Error('書き出した動画を取り出せませんでした');
    return new Blob([buffer], { type: 'video/webm' });
  } catch (cause) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel();
    throw cause;
  } finally {
    release();
    pauseAllVideos(job.media);
  }
}
