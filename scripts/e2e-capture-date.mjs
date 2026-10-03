// 撮影日時順に並べられるかを確かめる。
// - JPEG の EXIF（DateTimeOriginal・時差つき）を読む
// - 動画（MP4）の作成日時を読む
// - 記録の無い写真はファイルの日付で代用する
// - HEIC のように EXIF がファイルの後ろにあっても読める（読み取り部分だけを直接確かめる）
// - 「素材の並び順」を撮影日時順にすると、素材プールとカットの順が撮影日時の古い順になる
// - 並び順は保存され、以前の「シャッフル」設定も引き継がれる
import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

const DIR = resolve('out/capture-date');
mkdirSync(DIR, { recursive: true });

/** EXIF（ビッグエンディアンの TIFF）を作る。DateTimeOriginal と OffsetTimeOriginal を入れる */
function exifTiff(dateText, offsetText) {
  const ascii = (text) => Buffer.concat([Buffer.from(text, 'ascii'), Buffer.from([0])]);
  const date = ascii(dateText); // 20 バイト
  const offset = ascii(offsetText); // 7 バイト
  // 並び: ヘッダ(8) / IFD0(2+12+4) / EXIF IFD(2+12*2+4) / 日付 / 時差
  const ifd0At = 8;
  const exifAt = ifd0At + 2 + 12 + 4;
  const dataAt = exifAt + 2 + 12 * 2 + 4;
  const buf = Buffer.alloc(dataAt + date.length + offset.length);
  buf.write('MM', 0, 'ascii');
  buf.writeUInt16BE(42, 2);
  buf.writeUInt32BE(ifd0At, 4);
  // IFD0: ExifIFD へのポインタ
  buf.writeUInt16BE(1, ifd0At);
  buf.writeUInt16BE(0x8769, ifd0At + 2);
  buf.writeUInt16BE(4, ifd0At + 4);
  buf.writeUInt32BE(1, ifd0At + 6);
  buf.writeUInt32BE(exifAt, ifd0At + 10);
  buf.writeUInt32BE(0, ifd0At + 14);
  // EXIF IFD: DateTimeOriginal と OffsetTimeOriginal
  buf.writeUInt16BE(2, exifAt);
  let entry = exifAt + 2;
  for (const [tag, value, at] of [
    [0x9003, date, dataAt],
    [0x9011, offset, dataAt + date.length],
  ]) {
    buf.writeUInt16BE(tag, entry);
    buf.writeUInt16BE(2, entry + 2);
    buf.writeUInt32BE(value.length, entry + 4);
    buf.writeUInt32BE(at, entry + 8);
    entry += 12;
  }
  buf.writeUInt32BE(0, entry);
  date.copy(buf, dataAt);
  offset.copy(buf, dataAt + date.length);
  return buf;
}

/** JPEG の先頭（SOI の直後）に EXIF の APP1 を差し込む */
function withExif(jpeg, dateText, offsetText) {
  const payload = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), exifTiff(dateText, offsetText)]);
  const header = Buffer.alloc(4);
  header.writeUInt16BE(0xffe1, 0);
  header.writeUInt16BE(payload.length + 2, 2);
  return Buffer.concat([jpeg.subarray(0, 2), header, payload, jpeg.subarray(2)]);
}

const demo = readdirSync('assets/demo-photos')
  .filter((f) => f.endsWith('.jpg'))
  .slice(0, 3)
  .map((f) => readFileSync(resolve('assets/demo-photos', f)));

// 入れる順と撮影日時の順をわざとずらす
const march = resolve(DIR, 'a-march.jpg'); // 2024-03-03（日本時間）
const january = resolve(DIR, 'b-january.jpg'); // 2024-01-01（日本時間）
const noExif = resolve(DIR, 'c-no-exif.jpg'); // 記録なし。ファイルの日付を 2024-02-02 にする
writeFileSync(march, withExif(demo[0], '2024:03:03 10:00:00', '+09:00'));
writeFileSync(january, withExif(demo[1], '2024:01:01 10:00:00', '+09:00'));
writeFileSync(noExif, demo[2]);
utimesSync(noExif, new Date('2024-02-02T00:00:00Z'), new Date('2024-02-02T00:00:00Z'));

// 動画: 作成日時 2024-02-15（VP9 を MP4 に入れる。検証用の Chromium は H.264 を再生できない）
const video = resolve(DIR, 'd-february.mp4');
execFileSync('ffmpeg', [
  '-v', 'error', '-y',
  '-f', 'lavfi', '-i', 'testsrc=size=320x240:rate=30:duration=2',
  '-c:v', 'libvpx-vp9', '-b:v', '300k',
  '-metadata', 'creation_time=2024-02-15T03:00:00Z',
  video,
]);
// ファイルの日付は新しいままにして、記録された日時を読んでいることを確かめる
utimesSync(video, new Date(), new Date());

const audio = resolve('assets/demo-audio', 'click-10s.webm');

const browser = await chromium.launch({
  executablePath: process.env.CHROME_PATH ?? '/opt/pw-browsers/chromium',
  args: ['--autoplay-policy=no-user-gesture-required'],
});
const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

const failures = [];
const check = (ok, message) => {
  console.log(ok ? 'ok  ' : 'NG  ', message);
  if (!ok) failures.push(message);
};

await page.goto('http://127.0.0.1:5173/');

// --- 読み取り部分だけを直接確かめる（HEIC のように EXIF が後ろにある場合など）
const direct = await page.evaluate(async (tiffBytes) => {
  const { readCaptureDate, parseExifDate } = await import('/src/engine/captureDate.ts');
  const tiff = new Uint8Array(tiffBytes);
  // ISOBMFF 風: ftyp の箱、300KB の詰め物、その後ろに "Exif\0\0" + TIFF
  const ftyp = new Uint8Array([0, 0, 0, 16, 0x66, 0x74, 0x79, 0x70, 0x68, 0x65, 0x69, 0x63, 0, 0, 0, 0]);
  const marker = new TextEncoder().encode('Exif\0\0');
  const heic = new File([ftyp, new Uint8Array(300 * 1024), marker, tiff], 'late.heic', {
    type: 'image/heic',
    lastModified: 0,
  });
  const late = await readCaptureDate(heic, 'photo');
  const none = await readCaptureDate(new File([new Uint8Array(100)], 'x.png', { lastModified: 1234 }), 'photo');
  return {
    late,
    none,
    noOffset: parseExifDate('2024:01:01 00:00:00'),
    localMidnight: new Date(2024, 0, 1).getTime(),
    subsec: parseExifDate('2024:01:01 00:00:00', '+00:00', '25'),
    zero: parseExifDate('0000:00:00 00:00:00'),
  };
}, [...exifTiff('2023:12:24 18:30:00', '+09:00')]);
check(
  direct.late.source === 'metadata' && direct.late.time === Date.UTC(2023, 11, 24, 9, 30),
  `後ろにある EXIF を読める: ${new Date(direct.late.time).toISOString()}`,
);
check(direct.none.source === 'file' && direct.none.time === 1234, '記録が無ければファイルの日付');
check(direct.noOffset === direct.localMidnight, '時差の記録が無ければ端末の時刻帯とみなす');
check(direct.subsec === Date.UTC(2024, 0, 1) + 250, '1 秒未満（連写の順）も読む');
check(direct.zero === null, '0000:00:00 は日時なしとみなす');

// --- アプリに入れて並べる
await page.setInputFiles('input[type=file][multiple]', [march, noExif, january, video]);
await page.setInputFiles('input[type=file][accept="audio/*"]', audio);
await page.waitForSelector('.segments .segment', { timeout: 120000 });
await page.waitForFunction(() => document.querySelectorAll('.tray__item').length === 4);

const trayNames = () => page.$$eval('.tray__item img', (imgs) => imgs.map((i) => i.alt));
const cutOrder = async () => {
  // 1 枚 2 拍にして、全素材がカットに並ぶようにしてから、カットの順を読む
  const names = await trayNames();
  const thumbs = await page.$$eval('.tray__item img', (imgs) => imgs.map((i) => i.src));
  const cuts = await page.$$eval('.segments .segment img', (imgs) => imgs.map((i) => i.src));
  return cuts.slice(0, 4).map((src) => names[thumbs.indexOf(src)] ?? '?');
};

const orderSelect = page.locator('.panel--global label:has-text("素材の並び順") select');
await page.locator('.panel--global label:has-text("1 枚あたりの拍数") input').fill('2');
await page.waitForTimeout(300);

const added = await trayNames();
console.log('入れた順   :', added.join(', '));
check(added.join() === 'a-march.jpg,c-no-exif.jpg,b-january.jpg,d-february.mp4', '既定は入れた順');

await orderSelect.selectOption('taken');
await page.waitForTimeout(400);
const taken = await trayNames();
const expected = 'b-january.jpg,c-no-exif.jpg,d-february.mp4,a-march.jpg';
console.log('撮影日時順 :', taken.join(', '));
check(taken.join() === expected, '素材プールが撮影日時の古い順になる');
const cuts = await cutOrder();
console.log('カットの順 :', cuts.join(', '));
check(cuts.join() === expected, 'カットも撮影日時の古い順になる');

const hint = await page.textContent('.panel:has(.tray)');
check(hint.includes('記録が無い 1 点'), '日時の記録が無い素材の数を知らせる');
const title = await page.getAttribute('.tray__item:nth-child(1) .tray__assign', 'title');
check(title.includes('撮影 2024/01/01'), `日時がカーソルで見られる: ${title.split('\n')[1]}`);

// --- 保存して開き直しても、撮影日時順のまま
await page.waitForTimeout(2500);
await page.reload();
await page.waitForSelector('.segments .segment', { timeout: 120000 });
await page.waitForFunction(() => document.querySelectorAll('.tray__item').length === 4);
check((await orderSelect.inputValue()) === 'taken', '並び順が保存される');
check((await trayNames()).join() === expected, '開き直しても撮影日時順');

// --- 以前の「シャッフル」設定（shuffle: true）を開くと、並び順はシャッフルになる
const legacy = await page.evaluate(async () => {
  const { normalizeSettings } = await import('/src/engine/types.ts');
  return [normalizeSettings({ shuffle: true }).order, normalizeSettings({ shuffle: false }).order, normalizeSettings(null).order];
});
check(legacy.join() === 'shuffle,added,added', `以前の設定を引き継ぐ: ${legacy.join()}`);

await browser.close();

if (failures.length > 0) process.exit(1);
console.log('CAPTURE DATE OK');
