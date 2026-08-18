import { useRef, useState } from 'react';
import type { Photo } from '../engine/types';

interface Props {
  photos: Photo[];
  audioName: string | null;
  analyzing: boolean;
  /** タイムラインで使われている写真の ID */
  usedPhotoIds: Set<string>;
  /** 割り当て先として選ばれているカット。無ければクリック割り当ては効かない */
  hasSelection: boolean;
  onPhotos: (files: FileList) => void;
  onAudio: (file: File) => void;
  onRemovePhoto: (id: string) => void;
  onAssign: (photoId: string) => void;
}

export default function PhotoPool({
  photos,
  audioName,
  analyzing,
  usedPhotoIds,
  hasSelection,
  onPhotos,
  onAudio,
  onRemovePhoto,
  onAssign,
}: Props) {
  const photoInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [showUnusedOnly, setShowUnusedOnly] = useState(false);

  const visible = showUnusedOnly ? photos.filter((p) => !usedPhotoIds.has(p.id)) : photos;
  const unusedCount = photos.filter((p) => !usedPhotoIds.has(p.id)).length;

  return (
    <section className="panel">
      <h2>1. 写真プール</h2>

      <div
        className={`dropzone${dragging ? ' dropzone--active' : ''}`}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={(e) => {
          e.preventDefault();
          setDragging(false);
          const files = e.dataTransfer.files;
          const audio = Array.from(files).find((f) => f.type.startsWith('audio/'));
          if (audio) onAudio(audio);
          if (Array.from(files).some((f) => f.type.startsWith('image/'))) onPhotos(files);
        }}
        onClick={() => photoInput.current?.click()}
      >
        <p className="dropzone__title">写真と音源をここにドロップ</p>
        <p className="dropzone__hint">
          JPEG / PNG と MP3 などをまとめて置けます。写真は何枚でも足せます
        </p>
      </div>

      <div className="row">
        <button type="button" onClick={() => photoInput.current?.click()}>
          写真を足す
        </button>
        <button type="button" onClick={() => audioInput.current?.click()}>
          音源を選ぶ
        </button>
      </div>

      <input
        ref={photoInput}
        type="file"
        accept="image/*"
        multiple
        hidden
        onChange={(e) => {
          if (e.target.files) onPhotos(e.target.files);
          e.target.value = '';
        }}
      />
      <input
        ref={audioInput}
        type="file"
        accept="audio/*"
        hidden
        onChange={(e) => {
          if (e.target.files?.[0]) onAudio(e.target.files[0]);
          e.target.value = '';
        }}
      />

      <p className="status">
        写真 {photos.length} 枚（未使用 {unusedCount} 枚） ／ 音源{' '}
        {analyzing ? '解析中…' : (audioName ?? '未選択')}
      </p>

      {photos.length > 0 && (
        <>
          <p className="hint">
            {hasSelection
              ? '写真をクリックすると、選択中のカットに割り当てます'
              : 'タイムラインでカットを選ぶと、クリックで割り当てられます'}
            。ドラッグしてカットに落としても割り当てられます。
          </p>

          {unusedCount > 0 && (
            <label className="field--inline field--tight">
              <input
                type="checkbox"
                checked={showUnusedOnly}
                onChange={(e) => setShowUnusedOnly(e.target.checked)}
              />
              <span>未使用の写真だけ表示</span>
            </label>
          )}

          <ul className="tray">
            {visible.map((photo) => {
              const used = usedPhotoIds.has(photo.id);
              return (
                <li
                  key={photo.id}
                  className={`tray__item${used ? '' : ' tray__item--unused'}`}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/photo-id', photo.id);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                >
                  <button
                    type="button"
                    className="tray__assign"
                    title={
                      hasSelection
                        ? `${photo.name} を選択中のカットに割り当てる`
                        : `${photo.name}（カットを選ぶと割り当てられます）`
                    }
                    onClick={() => onAssign(photo.id)}
                  >
                    <img src={photo.url} alt={photo.name} />
                  </button>
                  {!used && <span className="tray__badge">未</span>}
                  <button
                    type="button"
                    className="tray__remove"
                    onClick={() => onRemovePhoto(photo.id)}
                    aria-label={`${photo.name} をプールから外す`}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        </>
      )}
    </section>
  );
}
