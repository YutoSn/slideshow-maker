import type { BeatAnalysis } from './beatDetect';
import type { PhotoFocus } from './renderer';
import type { ProjectSettings, SegmentOverride } from './types';

/**
 * プロジェクトの保存先。
 *
 * 写真と音源はローカルのファイルなので、JSON には書き出せない。
 * IndexedDB は File / Blob / Float32Array をそのまま入れられるので、
 * 素材ごと保存して、開き直したときに選び直さずに済むようにする。
 *
 * 素材（media）と編集内容（projects）は別々に置く。
 * 以前は編集内容と一緒に素材を毎回丸ごと書き直しており、動画の多い
 * プロジェクトでは、編集のたびに数 GB の書き込みが裏で走っていた。
 * いまは素材を最初に 1 回だけ書き、以降の保存は編集内容（数 KB）だけ。
 */

const DB_NAME = 'slideshow-maker';
const DB_VERSION = 2;
const PROJECTS = 'projects';
const MEDIA = 'media';
const META = 'meta';
const LAST_OPENED = 'lastOpenedId';

export interface StoredMedia {
  id: string;
  name: string;
  file: File;
}

export interface StoredProject {
  id: string;
  name: string;
  updatedAt: number;
  photos: StoredMedia[];
  audio: File | null;
  analysis: BeatAnalysis | null;
  settings: ProjectSettings;
  overrides: Record<string, SegmentOverride>;
  focus: Record<string, PhotoFocus>;
}

/** 一覧表示に使う、素材を含まない軽い情報。 */
export interface ProjectSummary {
  id: string;
  name: string;
  updatedAt: number;
  photoCount: number;
  audioName: string | null;
}

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);
    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(PROJECTS)) {
        db.createObjectStore(PROJECTS, { keyPath: 'id' });
      }
      if (!db.objectStoreNames.contains(META)) {
        db.createObjectStore(META);
      }
      // 素材の置き場。キーは「プロジェクト ID/種類/素材 ID」
      if (!db.objectStoreNames.contains(MEDIA)) {
        db.createObjectStore(MEDIA);
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('保存領域を開けませんでした'));
  });
}

function run<T>(
  store: string,
  mode: IDBTransactionMode,
  action: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return openDb().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(store, mode);
        const request = action(tx.objectStore(store));
        tx.oncomplete = () => {
          db.close();
          resolve(request.result);
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error ?? new Error('保存に失敗しました'));
        };
        tx.onabort = () => {
          db.close();
          reject(tx.error ?? new Error('保存が中断されました'));
        };
      }),
  );
}

export function isStorageAvailable(): boolean {
  return typeof indexedDB !== 'undefined';
}

/**
 * 保存される形。素材の File は MEDIA に置き、ここには ID と名前だけを持つ。
 * 古い版で保存したものは、photos[].file と audio に File が直接入っている。
 */
interface ProjectRecord {
  id: string;
  name: string;
  updatedAt: number;
  photos: { id: string; name: string; file?: File }[];
  /** 古い版の形（素材を直接持つ） */
  audio?: File | null;
  /** 新しい形。音源は MEDIA のこのキーに置く */
  audioRef?: { key: string; name: string } | null;
  analysis: BeatAnalysis | null;
  settings: ProjectSettings;
  overrides: Record<string, SegmentOverride>;
  focus: Record<string, PhotoFocus>;
}

function photoKey(projectId: string, mediaId: string): string {
  return `${projectId}/photo/${mediaId}`;
}

function audioKey(projectId: string, file: File): string {
  return `${projectId}/audio/${file.name}-${file.size}-${file.lastModified}`;
}

/** そのプロジェクトの素材のキーすべて */
function mediaRange(projectId: string): IDBKeyRange {
  return IDBKeyRange.bound(`${projectId}/`, `${projectId}/\uffff`);
}

/** 書き込み済みの素材のキー（プロジェクトごと）。同じ素材を書き直さないために使う */
const storedKeys = new Map<string, Set<string>>();

async function knownKeys(db: IDBDatabase, projectId: string): Promise<Set<string>> {
  const known = storedKeys.get(projectId);
  if (known) return known;
  const keys = await new Promise<IDBValidKey[]>((resolve, reject) => {
    const request = db.transaction(MEDIA, 'readonly').objectStore(MEDIA).getAllKeys(mediaRange(projectId));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error ?? new Error('保存領域を読めませんでした'));
  });
  const set = new Set(keys.map(String));
  storedKeys.set(projectId, set);
  return set;
}

function complete(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error ?? new Error('保存に失敗しました'));
    tx.onabort = () => reject(tx.error ?? new Error('保存が中断されました'));
  });
}

export async function saveProject(project: StoredProject): Promise<void> {
  const db = await openDb();
  try {
    const known = await knownKeys(db, project.id);
    const wanted = new Map<string, File>();
    for (const photo of project.photos) wanted.set(photoKey(project.id, photo.id), photo.file);
    const audioRef = project.audio
      ? { key: audioKey(project.id, project.audio), name: project.audio.name }
      : null;
    if (project.audio && audioRef) wanted.set(audioRef.key, project.audio);

    const record: ProjectRecord = {
      id: project.id,
      name: project.name,
      updatedAt: project.updatedAt,
      photos: project.photos.map(({ id, name }) => ({ id, name })),
      audioRef,
      analysis: project.analysis,
      settings: project.settings,
      overrides: project.overrides,
      focus: project.focus,
    };

    // 素材の追加・削除と編集内容を、1 つのトランザクションでまとめて書く
    const tx = db.transaction([PROJECTS, MEDIA, META], 'readwrite');
    const media = tx.objectStore(MEDIA);
    const added: string[] = [];
    for (const [key, file] of wanted) {
      if (known.has(key)) continue;
      media.put(file, key);
      added.push(key);
    }
    const removed = [...known].filter((key) => !wanted.has(key));
    for (const key of removed) media.delete(key);
    tx.objectStore(PROJECTS).put(record);
    tx.objectStore(META).put(project.id, LAST_OPENED);
    await complete(tx);

    for (const key of added) known.add(key);
    for (const key of removed) known.delete(key);
  } catch (cause) {
    // 失敗したときは、次の保存で書き込み済みかどうかを読み直す
    storedKeys.delete(project.id);
    throw cause;
  } finally {
    db.close();
  }
}

export async function loadProject(id: string): Promise<StoredProject | null> {
  const db = await openDb();
  try {
    const tx = db.transaction([PROJECTS, MEDIA], 'readonly');
    const get = <T>(store: string, key: IDBValidKey) =>
      new Promise<T | undefined>((resolve, reject) => {
        const request = tx.objectStore(store).get(key);
        request.onsuccess = () => resolve(request.result as T | undefined);
        request.onerror = () => reject(request.error ?? new Error('読み込めませんでした'));
      });

    const record = await get<ProjectRecord>(PROJECTS, id);
    if (!record) return null;

    const photos: StoredMedia[] = [];
    for (const photo of record.photos) {
      // 古い版は File を直接持っている
      const file = photo.file ?? (await get<File>(MEDIA, photoKey(id, photo.id)));
      if (file) photos.push({ id: photo.id, name: photo.name, file });
    }
    const audio = record.audio ?? (record.audioRef ? await get<File>(MEDIA, record.audioRef.key) : undefined);

    // 古い版の保存（素材を直接持つ）は、次の保存で新しい形に移す。
    // そのとき素材は MEDIA に 1 回だけ書かれる
    if (record.photos.some((p) => p.file) || record.audio) storedKeys.set(id, new Set());

    return {
      id: record.id,
      name: record.name,
      updatedAt: record.updatedAt,
      photos,
      audio: audio ?? null,
      analysis: record.analysis,
      settings: record.settings,
      overrides: record.overrides,
      focus: record.focus,
    };
  } finally {
    db.close();
  }
}

export async function deleteProject(id: string): Promise<void> {
  const db = await openDb();
  try {
    const tx = db.transaction([PROJECTS, MEDIA], 'readwrite');
    tx.objectStore(PROJECTS).delete(id);
    tx.objectStore(MEDIA).delete(mediaRange(id));
    await complete(tx);
    storedKeys.delete(id);
  } finally {
    db.close();
  }
  const last = await getLastOpenedId();
  if (last === id) await run(META, 'readwrite', (store) => store.delete(LAST_OPENED));
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const all = await run<ProjectRecord[]>(PROJECTS, 'readonly', (store) => store.getAll());
  return all
    .map((p) => ({
      id: p.id,
      name: p.name,
      updatedAt: p.updatedAt,
      photoCount: p.photos.length,
      audioName: p.audioRef?.name ?? p.audio?.name ?? null,
    }))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export async function getLastOpenedId(): Promise<string | null> {
  const id = await run<string | undefined>(META, 'readonly', (store) => store.get(LAST_OPENED));
  return id ?? null;
}

export async function setLastOpenedId(id: string | null): Promise<void> {
  if (id === null) await run(META, 'readwrite', (store) => store.delete(LAST_OPENED));
  else await run(META, 'readwrite', (store) => store.put(id, LAST_OPENED));
}

export function newProjectId(): string {
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** 保存量の目安。写真が多いと保存できないことがあるので、UI に出して知らせる。 */
export async function estimateUsage(): Promise<{ usedMb: number; quotaMb: number } | null> {
  if (!navigator.storage?.estimate) return null;
  const { usage = 0, quota = 0 } = await navigator.storage.estimate();
  return { usedMb: usage / 1e6, quotaMb: quota / 1e6 };
}
