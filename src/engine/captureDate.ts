/**
 * 素材の撮影日時を読む。撮影日時順に並べるために使う。
 *
 * - 写真（JPEG / HEIC）: EXIF の DateTimeOriginal（無ければ DateTimeDigitized・DateTime）
 * - 動画（MP4 / MOV）: iPhone の creationdate などのタグ、無ければ mvhd の作成時刻
 * - どれも読めなければ、ファイルの更新日時（lastModified）で代用する
 *
 * ファイル全体は読まず、必要なところだけを切り出して読む（数百枚でも軽く済むように）。
 */

export type CaptureDateSource = 'metadata' | 'file';

export interface CaptureDate {
  /** 撮影日時（エポックからのミリ秒） */
  time: number;
  /** metadata: 写真や動画に記録された撮影日時 / file: ファイルの日付で代用 */
  source: CaptureDateSource;
}

/** 写真の先頭から読む量。JPEG の EXIF は先頭 64KB 以内に収まる決まり */
const HEAD_BYTES = 256 * 1024;
/** HEIC で EXIF が先頭に無いとき、探しにいく上限 */
const HEIC_SCAN_LIMIT = 64 * 1024 * 1024;

async function readBytes(file: Blob, start: number, end: number): Promise<Uint8Array> {
  return new Uint8Array(await file.slice(start, Math.min(end, file.size)).arrayBuffer());
}

// ---------------------------------------------------------------- EXIF

const TAG_EXIF_IFD = 0x8769;
const TAG_DATETIME = 0x0132;
const TAG_DATETIME_ORIGINAL = 0x9003;
const TAG_DATETIME_DIGITIZED = 0x9004;
const TAG_OFFSET_TIME_ORIGINAL = 0x9011;
const TAG_SUBSEC_ORIGINAL = 0x9291;

/**
 * "2024:05:01 12:34:56" を時刻にする。
 * 時差（OffsetTimeOriginal）が記録されていればそれを使い、無ければ端末の時刻帯とみなす。
 */
export function parseExifDate(text: string, offset?: string, subsec?: string): number | null {
  const m = /^(\d{4}):(\d{2}):(\d{2})[ T](\d{2}):(\d{2}):(\d{2})/.exec(text.trim());
  if (!m) return null;
  const [year, month, day, hour, minute, second] = m.slice(1).map(Number);
  // 未設定のカメラは 0000:00:00 などを書くことがある
  if (year < 1971 || month < 1 || month > 12 || day < 1) return null;
  const ms = subsec && /^\d+$/.test(subsec.trim()) ? Number(`0.${subsec.trim()}`) * 1000 : 0;

  const tz = offset ? /^([+-])(\d{2}):?(\d{2})$/.exec(offset.trim()) : null;
  if (tz) {
    const sign = tz[1] === '-' ? -1 : 1;
    const minutes = sign * (Number(tz[2]) * 60 + Number(tz[3]));
    return Date.UTC(year, month - 1, day, hour, minute, second) + ms - minutes * 60_000;
  }
  return new Date(year, month - 1, day, hour, minute, second).getTime() + ms;
}

/** TIFF（EXIF の中身）から撮影日時を読む。tiff は "II*\0" か "MM\0*" から始まる */
function dateFromTiff(view: DataView, tiff: number): number | null {
  if (tiff + 8 > view.byteLength) return null;
  const order = view.getUint16(tiff);
  if (order !== 0x4949 && order !== 0x4d4d) return null;
  const little = order === 0x4949;
  const u16 = (at: number) => view.getUint16(at, little);
  const u32 = (at: number) => view.getUint32(at, little);
  if (u16(tiff + 2) !== 42) return null;

  /** IFD のタグを読む（文字列のタグと、EXIF IFD への位置だけ扱う） */
  const readIfd = (offset: number) => {
    const tags = new Map<number, string | number>();
    const at = tiff + offset;
    if (at + 2 > view.byteLength) return tags;
    const count = u16(at);
    for (let i = 0; i < count; i++) {
      const entry = at + 2 + i * 12;
      if (entry + 12 > view.byteLength) break;
      const tag = u16(entry);
      const type = u16(entry + 2);
      const length = u32(entry + 4);
      if (type === 4 || type === 13) {
        tags.set(tag, u32(entry + 8));
      } else if (type === 2) {
        const start = length > 4 ? tiff + u32(entry + 8) : entry + 8;
        if (start + length > view.byteLength) continue;
        let text = '';
        for (let j = 0; j < length; j++) {
          const code = view.getUint8(start + j);
          if (code === 0) break;
          text += String.fromCharCode(code);
        }
        tags.set(tag, text);
      }
    }
    return tags;
  };

  const ifd0 = readIfd(u32(tiff + 4));
  const exifOffset = ifd0.get(TAG_EXIF_IFD);
  const exif = typeof exifOffset === 'number' ? readIfd(exifOffset) : new Map();
  const text = (tags: Map<number, string | number>, tag: number) => {
    const value = tags.get(tag);
    return typeof value === 'string' ? value : undefined;
  };

  const offset = text(exif, TAG_OFFSET_TIME_ORIGINAL);
  const subsec = text(exif, TAG_SUBSEC_ORIGINAL);
  for (const [tags, tag] of [
    [exif, TAG_DATETIME_ORIGINAL],
    [exif, TAG_DATETIME_DIGITIZED],
    [ifd0, TAG_DATETIME],
  ] as const) {
    const value = text(tags, tag);
    const time = value ? parseExifDate(value, offset, tag === TAG_DATETIME_ORIGINAL ? subsec : undefined) : null;
    if (time !== null) return time;
  }
  return null;
}

/** JPEG の APP1（Exif）を順にたどって撮影日時を読む */
function dateFromJpeg(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.byteLength < 4 || view.getUint16(0) !== 0xffd8) return null;
  let at = 2;
  while (at + 4 <= view.byteLength) {
    if (view.getUint8(at) !== 0xff) return null;
    const marker = view.getUint8(at + 1);
    // 画像データ（SOS）より後に EXIF は無い
    if (marker === 0xda || marker === 0xd9) return null;
    const length = view.getUint16(at + 2);
    if (
      marker === 0xe1 &&
      at + 10 <= view.byteLength &&
      view.getUint32(at + 4) === 0x45786966 && // "Exif"
      view.getUint16(at + 8) === 0
    ) {
      return dateFromTiff(view, at + 10);
    }
    at += 2 + length;
  }
  return null;
}

/**
 * "Exif\0\0" に続く TIFF を探して読む。HEIC では EXIF が箱の中のどこかにあるので、
 * 構造をたどらずに印で探す（iPhone の HEIC はこれで読める）。
 */
function dateFromExifMarker(bytes: Uint8Array): number | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let i = 0; i + 14 <= bytes.length; i++) {
    if (
      bytes[i] === 0x45 &&
      bytes[i + 1] === 0x78 &&
      bytes[i + 2] === 0x69 &&
      bytes[i + 3] === 0x66 &&
      bytes[i + 4] === 0 &&
      bytes[i + 5] === 0
    ) {
      const time = dateFromTiff(view, i + 6);
      if (time !== null) return time;
    }
  }
  return null;
}

async function photoDate(file: File): Promise<number | null> {
  const head = await readBytes(file, 0, HEAD_BYTES);
  if (head[0] === 0xff && head[1] === 0xd8) return dateFromJpeg(head);

  const found = dateFromExifMarker(head);
  if (found !== null || file.size <= HEAD_BYTES) return found;
  // HEIC では EXIF がファイルの後ろ（mdat の中）に置かれることもある
  if (!isIsoBmff(head)) return null;
  const chunk = 4 * 1024 * 1024;
  for (let start = HEAD_BYTES - 16; start < Math.min(file.size, HEIC_SCAN_LIMIT); start += chunk) {
    // 境目で印が切れないよう少し重ねて読む
    const time = dateFromExifMarker(await readBytes(file, start, start + chunk + 64 * 1024));
    if (time !== null) return time;
  }
  return null;
}

// ---------------------------------------------------------------- 動画

/** MP4 / MOV / HEIC のような箱（box）の並びか（2 つ目の箱が ftyp） */
function isIsoBmff(head: Uint8Array): boolean {
  return head.length >= 8 && String.fromCharCode(...head.slice(4, 8)) === 'ftyp';
}

/** 1904-01-01 から 1970-01-01 までの秒数（mvhd の時刻の起点） */
const MAC_EPOCH_OFFSET = 2_082_844_800;

/**
 * moov > mvhd の作成時刻（UTC）を読む。moov はファイルの末尾にあることも多いので、
 * 箱の大きさをたどって位置を求め、その箱だけを読む。
 */
async function mvhdDate(file: File): Promise<number | null> {
  let at = 0;
  for (let guard = 0; guard < 64 && at + 8 <= file.size; guard++) {
    const header = new DataView((await readBytes(file, at, at + 16)).buffer);
    let size = header.getUint32(0);
    const type = String.fromCharCode(
      header.getUint8(4),
      header.getUint8(5),
      header.getUint8(6),
      header.getUint8(7),
    );
    let headerSize = 8;
    if (size === 1 && header.byteLength >= 16) {
      size = Number(header.getBigUint64(8));
      headerSize = 16;
    } else if (size === 0) {
      size = file.size - at;
    }
    if (size < headerSize) return null;

    if (type === 'moov') {
      const moov = await readBytes(file, at + headerSize, at + Math.min(size, 4 * 1024 * 1024));
      const view = new DataView(moov.buffer);
      let inner = 0;
      while (inner + 8 <= view.byteLength) {
        const innerSize = view.getUint32(inner);
        const innerType = String.fromCharCode(...moov.slice(inner + 4, inner + 8));
        if (innerType === 'mvhd') {
          const version = view.getUint8(inner + 8);
          const seconds =
            version === 1
              ? Number(view.getBigUint64(inner + 12))
              : view.getUint32(inner + 12);
          // 0 や 1904 年のままの動画は日時が入っていないとみなす
          if (seconds <= MAC_EPOCH_OFFSET) return null;
          return (seconds - MAC_EPOCH_OFFSET) * 1000;
        }
        if (innerSize < 8) break;
        inner += innerSize;
      }
      return null;
    }
    at += size;
  }
  return null;
}

async function videoDate(file: File): Promise<number | null> {
  // iPhone の MOV などに入っている creationdate は、現地の時差つきで正確
  try {
    const { Input, BlobSource, ALL_FORMATS } = await import('mediabunny');
    const input = new Input({ source: new BlobSource(file), formats: ALL_FORMATS });
    try {
      const tags = await input.getMetadataTags();
      const time = tags.date?.getTime();
      if (time !== undefined && Number.isFinite(time) && time > 0) return time;
    } finally {
      input.dispose();
    }
  } catch {
    // 読めない形式は mvhd を見る
  }
  try {
    return await mvhdDate(file);
  } catch {
    return null;
  }
}

/** 素材の撮影日時を読む。読めなければファイルの日付で代用する */
export async function readCaptureDate(file: File, kind: 'photo' | 'video'): Promise<CaptureDate> {
  let time: number | null = null;
  try {
    time = kind === 'video' ? await videoDate(file) : await photoDate(file);
  } catch {
    time = null;
  }
  if (time !== null && Number.isFinite(time)) return { time, source: 'metadata' };
  return { time: file.lastModified || 0, source: 'file' };
}
