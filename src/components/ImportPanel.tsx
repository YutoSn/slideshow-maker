import { useRef, useState } from 'react';
import type { Photo } from '../engine/types';

interface Props {
  photos: Photo[];
  audioName: string | null;
  analyzing: boolean;
  onPhotos: (files: FileList) => void;
  onAudio: (file: File) => void;
  onRemovePhoto: (id: string) => void;
}

export default function ImportPanel({
  photos,
  audioName,
  analyzing,
  onPhotos,
  onAudio,
  onRemovePhoto,
}: Props) {
  const photoInput = useRef<HTMLInputElement>(null);
  const audioInput = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);

  return (
    <section className="panel">
      <h2>1. 素材を読み込む</h2>

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
          Google ドライブから落とした JPEG / PNG と、MP3 などの音源をまとめて置けます
        </p>
      </div>

      <div className="row">
        <button type="button" onClick={() => photoInput.current?.click()}>
          写真を選ぶ
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
        onChange={(e) => e.target.files && onPhotos(e.target.files)}
      />
      <input
        ref={audioInput}
        type="file"
        accept="audio/*"
        hidden
        onChange={(e) => e.target.files?.[0] && onAudio(e.target.files[0])}
      />

      <p className="status">
        写真 {photos.length} 枚 ／ 音源{' '}
        {analyzing ? '解析中…' : (audioName ?? '未選択')}
      </p>

      {photos.length > 0 && (
        <ul className="tray">
          {photos.map((photo) => (
            <li key={photo.id} className="tray__item">
              <img src={photo.url} alt={photo.name} />
              <button
                type="button"
                className="tray__remove"
                onClick={() => onRemovePhoto(photo.id)}
                aria-label={`${photo.name} を外す`}
              >
                ×
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
