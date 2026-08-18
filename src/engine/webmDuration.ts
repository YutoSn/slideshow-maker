/**
 * MediaRecorder が書き出す WebM には Duration 要素が無く、
 * プレイヤー側で総再生時間が分からずシークできないことがある。
 * Segment > Info に Duration を差し込んで、これを補う。
 *
 * Segment のサイズは「不定（全バイト 1）」のまま有効なので、
 * 書き換えるのは Info のサイズだけで済む。
 */

const ID_SEGMENT = 0x18538067;
const ID_INFO = 0x1549a966;
const ID_DURATION = 0x4489;
const ID_TIMECODE_SCALE = 0x2ad7b1;

interface Vint {
  value: number;
  length: number;
  /** 全ビットが 1 の「サイズ不定」表現かどうか */
  unknown: boolean;
}

/** EBML の可変長整数を読む。marker を残すと要素 ID として使える。 */
function readVint(bytes: Uint8Array, offset: number, keepMarker: boolean): Vint | null {
  if (offset >= bytes.length) return null;
  const first = bytes[offset];
  if (first === 0) return null;

  let length = 1;
  for (let mask = 0x80; !(first & mask); mask >>= 1) length += 1;
  if (offset + length > bytes.length) return null;

  let value = keepMarker ? first : first & (0xff >> length);
  let unknown = (first & (0xff >> length)) === 0xff >> length;
  for (let i = 1; i < length; i++) {
    const byte = bytes[offset + i];
    if (byte !== 0xff) unknown = false;
    value = value * 256 + byte;
  }
  return { value, length, unknown };
}

/** 値を表現できる最小幅の可変長整数を書く（全ビット 1 は避ける）。 */
function writeVint(value: number): Uint8Array {
  let length = 1;
  while (length <= 8 && value >= 2 ** (7 * length) - 1) length += 1;
  if (length > 8) throw new Error('vint に収まらないサイズです');

  const out = new Uint8Array(length);
  let remaining = value;
  for (let i = length - 1; i >= 0; i--) {
    out[i] = remaining & 0xff;
    remaining = Math.floor(remaining / 256);
  }
  out[0] |= 0x80 >> (length - 1);
  return out;
}

interface Element {
  id: number;
  /** 要素の先頭（ID の 1 バイト目） */
  start: number;
  /** データ部の先頭 */
  dataStart: number;
  /** データ部の末尾（不定サイズなら親の末尾） */
  dataEnd: number;
  sizeLength: number;
  unknownSize: boolean;
}

/** [start, end) の範囲から直下の要素を順に読み出す。 */
function* children(bytes: Uint8Array, start: number, end: number): Generator<Element> {
  let offset = start;
  while (offset < end) {
    const id = readVint(bytes, offset, true);
    if (!id) return;
    const size = readVint(bytes, offset + id.length, false);
    if (!size) return;

    const dataStart = offset + id.length + size.length;
    const dataEnd = size.unknown ? end : Math.min(end, dataStart + size.value);

    yield {
      id: id.value,
      start: offset,
      dataStart,
      dataEnd,
      sizeLength: size.length,
      unknownSize: size.unknown,
    };

    // 不定サイズの要素は最後まで続くとみなす
    if (size.unknown) return;
    offset = dataEnd;
  }
}

function find(bytes: Uint8Array, start: number, end: number, id: number): Element | null {
  for (const element of children(bytes, start, end)) {
    if (element.id === id) return element;
  }
  return null;
}

function readFloat(bytes: Uint8Array, start: number, end: number): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset + start, end - start);
  if (end - start === 4) return view.getFloat32(0);
  if (end - start === 8) return view.getFloat64(0);
  return null;
}

/**
 * WebM に総再生時間を書き込んだ新しい Blob を返す。
 * 構造を解釈できなかった場合は、元の Blob をそのまま返す。
 */
export async function fixWebmDuration(blob: Blob, durationSeconds: number): Promise<Blob> {
  if (!(durationSeconds > 0)) return blob;

  try {
    const bytes: Uint8Array<ArrayBuffer> = new Uint8Array(await blob.arrayBuffer());

    const segment = find(bytes, 0, bytes.length, ID_SEGMENT);
    if (!segment) return blob;

    const info = find(bytes, segment.dataStart, segment.dataEnd, ID_INFO);
    if (!info || info.unknownSize) return blob;

    // Duration は TimecodeScale（既定 1,000,000ns = 1ms）を単位とする
    const scaleElement = find(bytes, info.dataStart, info.dataEnd, ID_TIMECODE_SCALE);
    let timecodeScale = 1000000;
    if (scaleElement) {
      let value = 0;
      for (let i = scaleElement.dataStart; i < scaleElement.dataEnd; i++) {
        value = value * 256 + bytes[i];
      }
      if (value > 0) timecodeScale = value;
    }
    const scaled = (durationSeconds * 1e9) / timecodeScale;

    const existing = find(bytes, info.dataStart, info.dataEnd, ID_DURATION);
    if (existing) {
      // すでにある場合は、同じ幅のまま値だけ差し替える
      if (readFloat(bytes, existing.dataStart, existing.dataEnd) === null) return blob;
      const patched: Uint8Array<ArrayBuffer> = bytes.slice();
      const view = new DataView(patched.buffer);
      if (existing.dataEnd - existing.dataStart === 4) {
        view.setFloat32(existing.dataStart, scaled);
      } else {
        view.setFloat64(existing.dataStart, scaled);
      }
      return new Blob([patched], { type: blob.type });
    }

    // Duration 要素（ID 2 バイト + サイズ 1 バイト + 倍精度 8 バイト）を組み立てる
    const duration = new Uint8Array(11);
    duration[0] = ID_DURATION >> 8;
    duration[1] = ID_DURATION & 0xff;
    duration[2] = 0x88;
    new DataView(duration.buffer).setFloat64(3, scaled);

    const infoSize = info.dataEnd - info.dataStart;
    const newSize = writeVint(infoSize + duration.length);
    const sizeStart = info.dataStart - info.sizeLength;

    const tail = bytes.length - info.dataStart;
    const out = new Uint8Array(sizeStart + newSize.length + duration.length + tail);
    out.set(bytes.subarray(0, sizeStart), 0);
    out.set(newSize, sizeStart);
    out.set(duration, sizeStart + newSize.length);
    out.set(bytes.subarray(info.dataStart), sizeStart + newSize.length + duration.length);
    return new Blob([out], { type: blob.type });
  } catch {
    // 解析に失敗しても、録画そのものは使えるので元の Blob を返す
    return blob;
  }
}
