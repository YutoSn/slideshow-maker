/**
 * 反復型 radix-2 FFT。解析用に毎フレーム呼ばれるため、
 * ビットリバース表と twiddle 係数はインスタンスに保持して使い回す。
 */
export class FFT {
  readonly size: number;
  private readonly rev: Uint32Array;
  private readonly cos: Float32Array;
  private readonly sin: Float32Array;
  private readonly re: Float32Array;
  private readonly im: Float32Array;

  constructor(size: number) {
    if ((size & (size - 1)) !== 0) throw new Error('FFT size must be a power of two');
    this.size = size;
    this.re = new Float32Array(size);
    this.im = new Float32Array(size);

    const bits = Math.log2(size);
    this.rev = new Uint32Array(size);
    for (let i = 0; i < size; i++) {
      let r = 0;
      for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
      this.rev[i] = r;
    }

    const half = size >> 1;
    this.cos = new Float32Array(half);
    this.sin = new Float32Array(half);
    for (let i = 0; i < half; i++) {
      this.cos[i] = Math.cos((-2 * Math.PI * i) / size);
      this.sin[i] = Math.sin((-2 * Math.PI * i) / size);
    }
  }

  /** 実数入力の振幅スペクトル（0..size/2）を out に書き込む。 */
  magnitudes(input: Float32Array, out: Float32Array): void {
    const { size, re, im, rev, cos, sin } = this;

    for (let i = 0; i < size; i++) {
      re[i] = input[rev[i]];
      im[i] = 0;
    }

    for (let len = 2; len <= size; len <<= 1) {
      const half = len >> 1;
      const step = size / len;
      for (let i = 0; i < size; i += len) {
        for (let j = 0, k = 0; j < half; j++, k += step) {
          const c = cos[k];
          const s = sin[k];
          const a = i + j;
          const b = a + half;
          const tr = re[b] * c - im[b] * s;
          const ti = re[b] * s + im[b] * c;
          re[b] = re[a] - tr;
          im[b] = im[a] - ti;
          re[a] += tr;
          im[a] += ti;
        }
      }
    }

    for (let i = 0; i <= size >> 1; i++) {
      out[i] = Math.hypot(re[i], im[i]);
    }
  }
}
