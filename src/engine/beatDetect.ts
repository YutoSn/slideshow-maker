import { FFT } from './fft';

export interface BeatAnalysis {
  /** 推定 BPM */
  bpm: number;
  /** 最初のビートの時刻（秒） */
  offset: number;
  /** ビート位置（秒）の配列 */
  beats: number[];
  /** 小節頭（4 拍ごと）の時刻（秒） */
  downbeats: number[];
  /** オンセット強度の包絡線（0..1 に正規化済み） */
  onsetEnvelope: Float32Array;
  /** 包絡線 1 サンプルあたりの秒数 */
  envelopeHopSeconds: number;
  /** 音源の長さ（秒） */
  duration: number;
}

const FRAME_SIZE = 2048;
const HOP_SIZE = 512;
const MIN_BPM = 70;
const MAX_BPM = 180;

/** 解析対象をモノラル 1 本の Float32Array にまとめる。 */
export function toMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  const mono = new Float32Array(buffer.length);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < data.length; i++) mono[i] += data[i];
  }
  if (channels > 1) {
    for (let i = 0; i < mono.length; i++) mono[i] /= channels;
  }
  return mono;
}

/**
 * スペクトルフラックス（正の変化分の総和）でオンセット包絡線を作る。
 * 打点は低〜中域に強く出るので、高域側は緩やかに重みを落とす。
 */
function onsetEnvelope(mono: Float32Array, sampleRate: number): Float32Array {
  const fft = new FFT(FRAME_SIZE);
  const bins = (FRAME_SIZE >> 1) + 1;
  const frame = new Float32Array(FRAME_SIZE);
  const spectrum = new Float32Array(bins);
  const previous = new Float32Array(bins);

  // Hann 窓
  const window = new Float32Array(FRAME_SIZE);
  for (let i = 0; i < FRAME_SIZE; i++) {
    window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FRAME_SIZE - 1));
  }

  // ビンごとの重み: 低域を厚く、8kHz 以上はほぼ無視する
  const weights = new Float32Array(bins);
  for (let i = 0; i < bins; i++) {
    const hz = (i * sampleRate) / FRAME_SIZE;
    weights[i] = hz < 200 ? 1.4 : hz < 2000 ? 1 : hz < 8000 ? 0.5 : 0.15;
  }

  const frameCount = Math.max(1, Math.floor((mono.length - FRAME_SIZE) / HOP_SIZE));
  const flux = new Float32Array(frameCount);

  for (let f = 0; f < frameCount; f++) {
    const start = f * HOP_SIZE;
    for (let i = 0; i < FRAME_SIZE; i++) frame[i] = mono[start + i] * window[i];
    fft.magnitudes(frame, spectrum);

    let sum = 0;
    for (let i = 0; i < bins; i++) {
      // 対数圧縮すると、静かな箇所の立ち上がりも大きい箇所と同程度に効く
      const value = Math.log1p(spectrum[i] * 8);
      const diff = value - previous[i];
      if (diff > 0) sum += diff * weights[i];
      previous[i] = value;
    }
    flux[f] = sum;
  }

  // 移動平均を引いて（適応的な閾値）0..1 に正規化する
  const smoothing = 16;
  const result = new Float32Array(frameCount);
  let peak = 0;
  for (let f = 0; f < frameCount; f++) {
    const from = Math.max(0, f - smoothing);
    const to = Math.min(frameCount, f + smoothing + 1);
    let mean = 0;
    for (let i = from; i < to; i++) mean += flux[i];
    mean /= to - from;
    const value = Math.max(0, flux[f] - mean);
    result[f] = value;
    if (value > peak) peak = value;
  }
  if (peak > 0) {
    for (let f = 0; f < frameCount; f++) result[f] /= peak;
  }
  return result;
}

/** 包絡線の自己相関から BPM を推定する。 */
function estimateTempo(envelope: Float32Array, hopSeconds: number): number {
  const minLag = Math.max(1, Math.round(60 / MAX_BPM / hopSeconds));
  const maxLag = Math.min(envelope.length - 1, Math.round(60 / MIN_BPM / hopSeconds));

  let bestLag = minLag;
  let bestScore = -Infinity;

  for (let lag = minLag; lag <= maxLag; lag++) {
    let sum = 0;
    const limit = envelope.length - lag;
    for (let i = 0; i < limit; i++) sum += envelope[i] * envelope[i + lag];
    let score = sum / limit;

    // 倍/半テンポの取り違えを減らすため、2 倍・4 倍の周期も一致するラグを優遇する
    for (const multiple of [2, 3, 4]) {
      const far = lag * multiple;
      if (far >= envelope.length) break;
      let harmonic = 0;
      const harmonicLimit = envelope.length - far;
      for (let i = 0; i < harmonicLimit; i++) harmonic += envelope[i] * envelope[i + far];
      score += (harmonic / harmonicLimit) * (0.5 / multiple);
    }

    if (score > bestScore) {
      bestScore = score;
      bestLag = lag;
    }
  }

  let bpm = 60 / (bestLag * hopSeconds);
  // 実用的なテンポ帯（おおむね 70〜140）に畳み込む
  while (bpm > 145) bpm /= 2;
  while (bpm < 70) bpm *= 2;
  return bpm;
}

/** ビート格子の位相（最初のビート位置）を全探索で決める。 */
function estimatePhase(envelope: Float32Array, hopSeconds: number, bpm: number): number {
  const period = 60 / bpm;
  const periodFrames = period / hopSeconds;
  const steps = Math.max(1, Math.round(periodFrames));

  let bestOffset = 0;
  let bestScore = -Infinity;

  for (let step = 0; step < steps; step++) {
    let score = 0;
    for (let frame = step; frame < envelope.length; frame += periodFrames) {
      const index = Math.round(frame);
      if (index >= envelope.length) break;
      // 前後 1 フレームも見て、量子化ずれを吸収する
      score += Math.max(
        envelope[index],
        envelope[index - 1] ?? 0,
        envelope[index + 1] ?? 0,
      );
    }
    if (score > bestScore) {
      bestScore = score;
      bestOffset = step * hopSeconds;
    }
  }
  return bestOffset;
}

/**
 * 4 拍を 1 小節としたとき、どの拍を小節頭にすると
 * オンセットが最も強いかを調べる。
 */
function estimateDownbeatPhase(
  beats: number[],
  envelope: Float32Array,
  hopSeconds: number,
): number {
  let bestPhase = 0;
  let bestScore = -Infinity;
  for (let phase = 0; phase < 4; phase++) {
    let score = 0;
    for (let i = phase; i < beats.length; i += 4) {
      const index = Math.round(beats[i] / hopSeconds);
      if (index >= 0 && index < envelope.length) score += envelope[index];
    }
    if (score > bestScore) {
      bestScore = score;
      bestPhase = phase;
    }
  }
  return bestPhase;
}

/** Worker との受け渡しに使う、AudioBuffer に依存しない入力形式。 */
export interface AnalysisInput {
  mono: Float32Array;
  sampleRate: number;
  duration: number;
}

export function toAnalysisInput(buffer: AudioBuffer): AnalysisInput {
  return { mono: toMono(buffer), sampleRate: buffer.sampleRate, duration: buffer.duration };
}

/** 音源全体を解析してビート格子を返す。 */
export function analyzeBeats(input: AnalysisInput): BeatAnalysis {
  const { mono, sampleRate, duration } = input;
  const hopSeconds = HOP_SIZE / sampleRate;

  const envelope = onsetEnvelope(mono, sampleRate);
  const bpm = estimateTempo(envelope, hopSeconds);
  const offset = estimatePhase(envelope, hopSeconds, bpm);

  const period = 60 / bpm;
  const beats: number[] = [];
  for (let t = offset; t < duration; t += period) beats.push(t);

  const downbeatPhase = estimateDownbeatPhase(beats, envelope, hopSeconds);
  const downbeats = beats.filter((_, i) => (i - downbeatPhase) % 4 === 0 && i >= downbeatPhase);

  return {
    bpm,
    offset,
    beats,
    downbeats,
    onsetEnvelope: envelope,
    envelopeHopSeconds: hopSeconds,
    duration,
  };
}
