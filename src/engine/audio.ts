import { toAnalysisInput, type BeatAnalysis } from './beatDetect';

/** File を AudioBuffer にデコードする。解析専用の AudioContext は使い終わり次第閉じる。 */
export async function decodeAudioFile(file: File): Promise<AudioBuffer> {
  const bytes = await file.arrayBuffer();
  const context = new AudioContext();
  try {
    return await context.decodeAudioData(bytes);
  } finally {
    void context.close();
  }
}

/**
 * 音源をデコードし、ビート解析を Worker で走らせる。
 * decodeAudioData は Worker から使えないため、デコードだけは呼び出し側で行う。
 */
export function analyzeInWorker(buffer: AudioBuffer): Promise<BeatAnalysis> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./analyze.worker.ts', import.meta.url), {
      type: 'module',
    });
    worker.onmessage = (event) => {
      worker.terminate();
      if (event.data.ok) resolve(event.data.analysis as BeatAnalysis);
      else reject(new Error(event.data.message));
    };
    worker.onerror = (event) => {
      worker.terminate();
      reject(new Error(event.message || '解析ワーカーの起動に失敗しました'));
    };

    const input = toAnalysisInput(buffer);
    worker.postMessage(input, [input.mono.buffer]);
  });
}

export function formatTime(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '0:00';
  const total = Math.floor(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}
