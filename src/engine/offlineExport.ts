import {
  AudioBufferSource,
  BufferTarget,
  CanvasSource,
  Mp4OutputFormat,
  Output,
  Quality,
  WebMOutputFormat,
  canEncodeAudio,
  canEncodeVideo,
  type AudioCodec,
  type VideoCodec,
} from 'mediabunny';
import { decodeAudioFile } from './audio';
import {
  ExportAborted,
  PROGRESS_INTERVAL_MS,
  prepareMedia,
  type ExportContainer,
  type ExportOptions,
} from './exportShared';
import { renderFrame, segmentAt, type RenderContext } from './renderer';
import { isVideo, type Segment } from './types';
import { clipTimeFor, pauseAllVideos } from './videoSync';

/**
 * WebCodecs による書き出し。mediabunny ごと重いので、書き出すときにだけ読み込む
 * （exporter.ts から動的に import される）。
 */

/** 書き出しに使う入れ物とコーデックの組み合わせ */
export interface OfflineCodecs {
  container: ExportContainer;
  video: VideoCodec;
  audio: AudioCodec;
}

/**
 * MP4（H.264 + AAC）を優先する。iPhone の写真アプリや LINE・SNS へそのまま渡せるため。
 * H.264 を符号化できないブラウザでは、従来の WebM（VP9 / VP8 + Opus）にする。
 */
const CANDIDATES: OfflineCodecs[] = [
  { container: 'mp4', video: 'avc', audio: 'aac' },
  { container: 'webm', video: 'vp9', audio: 'opus' },
  { container: 'webm', video: 'vp8', audio: 'opus' },
];

/** WebAssembly 版の AAC 符号化器を登録したか（何度も書き出すときに重ねて登録しない） */
let aacEncoderRegistered = false;

async function canEncodeAudioCodec(codec: AudioCodec, options: ExportOptions): Promise<boolean> {
  const config = {
    numberOfChannels: 2,
    sampleRate: AUDIO_SAMPLE_RATE,
    quality: new Quality({ bitrate: options.audioBitsPerSecond }),
  };
  if (await canEncodeAudio(codec, config)) return true;
  if (codec !== 'aac' || aacEncoderRegistered) return false;
  // AAC を符号化できないブラウザ（Firefox や Linux 版 Chromium など）では、
  // WebAssembly 版の AAC 符号化器を足す。約 1MB あるので、要るときにだけ読み込む
  try {
    const { registerAacEncoder } = await import('@mediabunny/aac-encoder');
    registerAacEncoder();
    aacEncoderRegistered = true;
    return await canEncodeAudio(codec, config);
  } catch {
    return false;
  }
}

/** WebCodecs で書き出せるなら、使う入れ物とコーデックを返す。 */
export async function offlineCodecs(options: ExportOptions): Promise<OfflineCodecs | null> {
  for (const candidate of CANDIDATES) {
    try {
      const videoOk = await canEncodeVideo(candidate.video, {
        width: options.width,
        height: options.height,
        frameRate: options.fps,
        quality: new Quality({ bitrate: options.videoBitsPerSecond }),
      });
      if (!videoOk) continue;
      if (await canEncodeAudioCodec(candidate.audio, options)) return candidate;
    } catch {
      // 判定できない組み合わせは飛ばす
    }
  }
  return null;
}

/** 音声は 48kHz で符号化する（Opus はこれしか受け付けず、AAC もこれで問題ない） */
const AUDIO_SAMPLE_RATE = 48_000;

/** 音源を 48kHz・ステレオにそろえる（符号化器が受け付ける形） */
async function audioForEncoding(file: File): Promise<AudioBuffer> {
  const decoded = await decodeAudioFile(file);
  const frames = Math.ceil(decoded.duration * AUDIO_SAMPLE_RATE);
  const offline = new OfflineAudioContext(2, Math.max(1, frames), AUDIO_SAMPLE_RATE);
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
  codecs: OfflineCodecs,
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
    audioForEncoding(audioFile),
  ]);
  // プレビュー用の縮めた画像ではなく、書き出し用に用意した画像で描く
  const job: RenderContext = { ...render, media, imageFor: undefined };
  pauseAllVideos(job.media);

  const format =
    codecs.container === 'mp4'
      ? // 先頭に目次（moov）を置く。スマホなどで読み込みながら再生できる
        new Mp4OutputFormat({ fastStart: 'in-memory' })
      : new WebMOutputFormat();
  const output = new Output({ format, target: new BufferTarget() });
  const video = new CanvasSource(canvas, {
    codec: codecs.video,
    quality: new Quality({ bitrate: videoBitsPerSecond }),
    keyFrameInterval: 2,
  });
  const audio = new AudioBufferSource({
    codec: codecs.audio,
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
    return new Blob([buffer], { type: codecs.container === 'mp4' ? 'video/mp4' : 'video/webm' });
  } catch (cause) {
    if (output.state !== 'finalized' && output.state !== 'canceled') await output.cancel();
    throw cause;
  } finally {
    release();
    pauseAllVideos(job.media);
  }
}
