import { useRef, useState } from 'react';
import type { MediaItem } from '../engine/types';

interface Props {
  photos: MediaItem[];
  audioName: string | null;
  analyzing: boolean;
  /** タイムラインで使われている写真の ID */
  usedMediaIds: Set<string>;
  /** 割り当て先として選ばれているカット。無ければクリック割り当ては効かない */
  hasSelection: boolean;
  onPhotos: (files: FileList) => void;
  onAudio: (file: File) => void;
  onRemovePhoto: (id: string) => void;
  onAssign: (mediaId: string) => void;
  /** タイムラインからカットをドラッグしてきたとき、その写真に差し替える */
  onDropCut: (cutIndex: number, mediaId: string) => void;
}

export default function MediaPool({
  photos,
  audioName,
  analyzing,
  usedMediaIds,
  hasSelection,
  onPhotos,
  onAudio,
  onRemovePhoto,
  onAssign,
  onDropCut,
}: Props) {
  const photoInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const [showUnusedOnly, setShowUnusedOnly] = useState(false);
  const [cutOver, setCutOver] = useState<string | null>(null);

  const visible = showUnusedOnly ? photos.filter((p) => !usedMediaIds.has(p.id)) : photos;
  const unusedCount = photos.filter((p) => !usedMediaIds.has(p.id)).length;
  const videoCount = photos.filter((p) => p.kind === 'video').length;

  return (
    <section className="panel">
      <h2>1. 素材プール</h2>

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
          if (
            Array.from(files).some(
              (f) => f.type.startsWith('image/') || f.type.startsWith('video/'),
            )
          ) {
            onPhotos(files);
          }
        }}
        onClick={() => photoInput.current?.click()}
      >
        <p className="dropzone__title">写真・動画と音源をここにドロップ</p>
        <p className="dropzone__hint">
          JPEG / PNG / MP4 と MP3 などをまとめて置けます。素材は何点でも足せます
        </p>
      </div>

      <div className="row">
        <button type="button" onClick={() => photoInput.current?.click()}>
          素材を足す
        </button>
        <button type="button" onClick={() => audioInput.current?.click()}>
          音源を選ぶ
        </button>
      </div>

      <input
        ref={photoInput}
        type="file"
        accept="image/*,video/*"
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
        素材 {photos.length} 点
        {videoCount > 0 && `（うち動画 ${videoCount}）`}
        ／ 未使用 {unusedCount} ／ 音源{' '}
        {analyzing ? '解析中…' : (audioName ?? '未選択')}
      </p>

      {photos.length > 0 && (
        <>
          <p className="hint">
            {hasSelection
              ? '写真をクリックすると、選択中のカットに割り当てます'
              : 'タイムラインでカットを選ぶと、クリックで割り当てられます'}
            。写真とカットは、どちらの向きにドラッグしても差し替えられます。
          </p>

          {unusedCount > 0 && (
            <label className="field--inline field--tight">
              <input
                type="checkbox"
                checked={showUnusedOnly}
                onChange={(e) => setShowUnusedOnly(e.target.checked)}
              />
              <span>未使用の素材だけ表示</span>
            </label>
          )}

          <ul className="tray">
            {visible.map((photo) => {
              const used = usedMediaIds.has(photo.id);
              return (
                <li
                  key={photo.id}
                  className={[
                    'tray__item',
                    used ? '' : 'tray__item--unused',
                    cutOver === photo.id ? 'tray__item--drop' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/photo-id', photo.id);
                    e.dataTransfer.effectAllowed = 'copy';
                  }}
                  onDragOver={(e) => {
                    // タイムラインから運ばれてきたカットだけ受け取る
                    if (!e.dataTransfer.types.includes('text/cut-index')) return;
                    e.preventDefault();
                    // カット側は effectAllowed = 'move' で始まる。
                    // 許可されていない dropEffect を指定するとドロップが拒否される
                    e.dataTransfer.dropEffect = 'move';
                    setCutOver(photo.id);
                  }}
                  onDragLeave={() =>
                    setCutOver((current) => (current === photo.id ? null : current))
                  }
                  onDrop={(e) => {
                    const raw = e.dataTransfer.getData('text/cut-index');
                    if (raw === '') return;
                    e.preventDefault();
                    setCutOver(null);
                    const index = Number(raw);
                    if (Number.isInteger(index)) onDropCut(index, photo.id);
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
                    <img src={photo.thumbnail} alt={photo.name} />
                  </button>
                  {photo.kind === 'video' && (
                    <span className="tray__kind" title={`動画 ${photo.duration.toFixed(1)} 秒`}>
                      ▶ {photo.duration < 60
                        ? `${photo.duration.toFixed(0)}s`
                        : `${Math.floor(photo.duration / 60)}:${String(
                            Math.round(photo.duration % 60),
                          ).padStart(2, '0')}`}
                    </span>
                  )}
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
