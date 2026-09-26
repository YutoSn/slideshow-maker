// 自動保存で、素材を毎回書き直していないことを確認する。
// 以前は編集のたびに素材を丸ごと書き直していた（動画の多いプロジェクトでは数 GB）。
// - 編集を重ねても保存領域が増えない
// - 素材の置き場（media）には、素材 1 つにつき 1 件だけ
// - 古い版の保存（素材を直接持つ）も開けて、次の保存で新しい形に移る
// - プロジェクトを消すと素材も消える
import { chromium } from 'playwright';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const photoDir = process.env.PHOTO_DIR ?? 'assets/demo-photos';
const photos = readdirSync(photoDir)
  .filter((f) => f.endsWith('.jpg'))
  .map((f) => resolve(photoDir, f));
const audio = resolve('assets/demo-audio', process.env.AUDIO_FILE ?? 'click-40s.webm');

// 保存領域の大きさを実際に測るため、ディスクに残るプロファイルで開く
const profile = mkdtempSync(join(tmpdir(), 'slideshow-profile-'));
const context = await chromium.launchPersistentContext(profile, {
  executablePath: '/opt/pw-browsers/chromium',
  viewport: { width: 1500, height: 1000 },
});
const page = await context.newPage();
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

let failed = false;
const expect = (label, ok, detail = '') => {
  if (!ok) failed = true;
  console.log(`${ok ? 'ok  ' : 'NG  '} ${label}${detail ? `: ${detail}` : ''}`);
};

const status = () => page.textContent('.panel:has-text("プロジェクト") .muted');
const waitSaved = async () => {
  await page.waitForTimeout(300);
  for (let i = 0; i < 200; i++) {
    const s = (await status()) ?? '';
    if (s.includes('保存しました') || s.includes('に保存')) return;
    await page.waitForTimeout(50);
  }
};
const usageMb = () =>
  page.evaluate(async () => Math.round((await navigator.storage.estimate()).usage / 1e5) / 10);
/** IndexedDB の中身（保存の形）を覗く */
const inspect = () =>
  page.evaluate(
    () =>
      new Promise((resolve) => {
        const open = indexedDB.open('slideshow-maker');
        open.onsuccess = () => {
          const db = open.result;
          const tx = db.transaction(['projects', 'media'], 'readonly');
          const projects = tx.objectStore('projects').getAll();
          const keys = tx.objectStore('media').getAllKeys();
          tx.oncomplete = () => {
            db.close();
            resolve({
              projects: projects.result.map((p) => ({
                id: p.id,
                inlineFiles: p.photos.filter((x) => x.file).length + (p.audio ? 1 : 0),
                photos: p.photos.length,
              })),
              mediaKeys: keys.result.map(String),
            });
          };
        };
      }),
  );
const editOnce = async () => {
  await page.locator('.segments .segment').nth(1).click();
  await page.click('.panel--cut button:has-text("+ 1 拍")');
  await page.waitForTimeout(1700);
  await waitSaved();
};

await page.goto('http://127.0.0.1:5173/');
await page.setInputFiles('input[type=file][multiple]', photos);
await page.setInputFiles('input[type=file][accept="audio/*"]', audio);
await page.waitForSelector('.segments .segment', { timeout: 120000 });
await page.waitForTimeout(1700);
await waitSaved();

const first = await inspect();
const base = await usageMb();
console.log(`     初回保存: 保存領域 ${base}MB / 素材 ${first.mediaKeys.length} 件`);
expect('素材 1 つにつき 1 件（写真 + 音源）', first.mediaKeys.length === photos.length + 1, String(first.mediaKeys.length));
expect('編集内容には素材を持たない', first.projects[0]?.inlineFiles === 0);

for (let i = 0; i < 3; i++) await editOnce();
const after = await usageMb();
const again = await inspect();
console.log(`     編集 3 回のあと: 保存領域 ${after}MB / 素材 ${again.mediaKeys.length} 件`);
expect('編集しても保存領域が増えない', after <= base + 1, `${base}MB → ${after}MB`);
expect('素材の件数も変わらない', again.mediaKeys.length === first.mediaKeys.length);

// 再読み込みで、素材ごと戻る
await page.reload();
await page.waitForSelector('.segments .segment', { timeout: 120000 });
const restoredStatus = (await page.textContent('.status'))?.trim() ?? '';
expect('再読み込みで素材ごと戻る', restoredStatus.includes(`素材 ${photos.length} 点`), restoredStatus);

// 古い版の形（素材を直接持つ）を作って開く
const legacyId = await page.evaluate(
  () =>
    new Promise((resolve) => {
      const open = indexedDB.open('slideshow-maker');
      open.onsuccess = () => {
        const db = open.result;
        const read = db.transaction(['projects', 'media'], 'readonly');
        const projects = read.objectStore('projects').getAll();
        const media = read.objectStore('media');
        const files = new Map();
        const cursor = media.openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (c) {
            files.set(String(c.key), c.value);
            c.continue();
          }
        };
        read.oncomplete = () => {
          const current = projects.result[0];
          const id = 'p-legacy-test';
          const legacy = {
            ...current,
            id,
            name: '古い版のプロジェクト',
            photos: current.photos.map((p) => ({
              ...p,
              file: files.get(`${current.id}/photo/${p.id}`),
            })),
            audio: files.get(current.audioRef.key),
          };
          delete legacy.audioRef;
          const write = db.transaction(['projects', 'meta'], 'readwrite');
          write.objectStore('projects').put(legacy);
          write.objectStore('meta').put(id, 'lastOpenedId');
          write.oncomplete = () => {
            db.close();
            resolve(id);
          };
        };
      };
    }),
);
await page.reload();
await page.waitForSelector('.segments .segment', { timeout: 120000 });
const legacyStatus = (await page.textContent('.status'))?.trim() ?? '';
const legacyNotice = (await page.textContent('.notice--info').catch(() => '')) ?? '';
expect('古い版の保存も開ける', legacyNotice.includes('古い版のプロジェクト') && legacyStatus.includes(`素材 ${photos.length} 点`), legacyStatus);
await editOnce();
const migrated = await inspect();
const legacyRecord = migrated.projects.find((p) => p.id === legacyId);
expect('次の保存で新しい形に移る', legacyRecord?.inlineFiles === 0, JSON.stringify(legacyRecord));
expect(
  '古い版の素材も 1 件ずつ置かれる',
  migrated.mediaKeys.filter((k) => k.startsWith(`${legacyId}/`)).length === photos.length + 1,
);

// 消すと素材も消える
const deleteButtons = page.locator('.projects__delete');
const count = await deleteButtons.count();
for (let i = 0; i < count; i++) {
  await deleteButtons.first().click();
  await page.waitForTimeout(400);
}
const cleaned = await inspect();
expect('プロジェクトを消すと素材も消える', cleaned.mediaKeys.length === 0, `${cleaned.mediaKeys.length} 件残り`);

await context.close();
rmSync(profile, { recursive: true, force: true });
if (failed) {
  console.log('FAILED');
  process.exit(1);
}
console.log('SAVE MEDIA ONCE OK');
