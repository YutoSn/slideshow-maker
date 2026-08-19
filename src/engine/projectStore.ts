import type { BeatAnalysis } from './beatDetect';
import type { PhotoFocus } from './renderer';
import type { ProjectSettings, SegmentOverride } from './types';

/**
 * プロジェクトの保存先。
 *
 * 写真と音源はローカルのファイルなので、JSON には書き出せない。
 * IndexedDB は File / Blob / Float32Array をそのまま入れられるので、
 * 素材ごと保存して、開き直したときに選び直さずに済むようにする。
 */

const DB_NAME = 'slideshow-maker';
const DB_VERSION = 1;
const PROJECTS = 'projects';
const META = 'meta';
const LAST_OPENED = 'lastOpenedId';

export interface StoredPhoto {
  id: string;
  name: string;
  file: File;
}

export interface StoredProject {
  id: string;
  name: string;
  updatedAt: number;
  photos: StoredPhoto[];
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

export async function saveProject(project: StoredProject): Promise<void> {
  await run(PROJECTS, 'readwrite', (store) => store.put(project));
  await run(META, 'readwrite', (store) => store.put(project.id, LAST_OPENED));
}

export async function loadProject(id: string): Promise<StoredProject | null> {
  const found = await run<StoredProject | undefined>(PROJECTS, 'readonly', (store) =>
    store.get(id),
  );
  return found ?? null;
}

export async function deleteProject(id: string): Promise<void> {
  await run(PROJECTS, 'readwrite', (store) => store.delete(id));
  const last = await getLastOpenedId();
  if (last === id) await run(META, 'readwrite', (store) => store.delete(LAST_OPENED));
}

export async function listProjects(): Promise<ProjectSummary[]> {
  const all = await run<StoredProject[]>(PROJECTS, 'readonly', (store) => store.getAll());
  return all
    .map((p) => ({
      id: p.id,
      name: p.name,
      updatedAt: p.updatedAt,
      photoCount: p.photos.length,
      audioName: p.audio?.name ?? null,
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
