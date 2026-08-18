import { useEffect, useRef, useState } from 'react';
import type { BeatAnalysis } from '../engine/beatDetect';
import { formatTime } from '../engine/audio';
import type { Photo, Segment } from '../engine/types';

interface Props {
  analysis: BeatAnalysis;
  segments: Segment[];
  photos: Map<string, Photo>;
  currentTime: number;
  selectedId: string | null;
  onSeek: (time: number) => void;
  onSelect: (id: string) => void;
  /** プールからドラッグしてきた写真を、このカットに割り当てる */
  onDropPhoto: (segmentId: string, photoId: string) => void;
}

const HEIGHT = 74;

export default function Timeline({
  analysis,
  segments,
  photos,
  currentTime,
  selectedId,
  onSeek,
  onSelect,
  onDropPhoto,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // オンセット包絡線とビート格子を描く。曲全体を横幅に収める。
  useEffect(() => {
    const canvas = canvasRef.current;
    const wrap = wrapRef.current;
    if (!canvas || !wrap) return;

    const draw = () => {
      const width = wrap.clientWidth;
      const dpr = window.devicePixelRatio || 1;
      canvas.width = width * dpr;
      canvas.height = HEIGHT * dpr;
      canvas.style.width = `${width}px`;
      canvas.style.height = `${HEIGHT}px`;

      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      ctx.fillStyle = '#12121a';
      ctx.fillRect(0, 0, width, HEIGHT);

      const { onsetEnvelope, envelopeHopSeconds, duration, beats, downbeats } = analysis;

      ctx.fillStyle = '#3d4d7a';
      for (let x = 0; x < width; x++) {
        const time = (x / width) * duration;
        const index = Math.floor(time / envelopeHopSeconds);
        const value = onsetEnvelope[index] ?? 0;
        const h = Math.max(1, value * (HEIGHT - 20));
        ctx.fillRect(x, HEIGHT - 10 - h, 1, h);
      }

      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.beginPath();
      for (const beat of beats) {
        const x = Math.round((beat / duration) * width) + 0.5;
        ctx.moveTo(x, HEIGHT - 10);
        ctx.lineTo(x, HEIGHT - 4);
      }
      ctx.stroke();

      ctx.strokeStyle = 'rgba(120,200,255,0.55)';
      ctx.beginPath();
      for (const beat of downbeats) {
        const x = Math.round((beat / duration) * width) + 0.5;
        ctx.moveTo(x, 4);
        ctx.lineTo(x, HEIGHT - 4);
      }
      ctx.stroke();
    };

    draw();
    const observer = new ResizeObserver(draw);
    observer.observe(wrap);
    return () => observer.disconnect();
  }, [analysis]);

  const duration = analysis.duration || 1;
  const playheadPercent = `${(currentTime / duration) * 100}%`;

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>3. タイムライン</h2>
        <span className="muted">
          {analysis.bpm.toFixed(1)} BPM ／ {segments.length} カット ／ {formatTime(duration)}
        </span>
      </div>

      <div
        ref={wrapRef}
        className="timeline"
        onClick={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          onSeek(((e.clientX - rect.left) / rect.width) * duration);
        }}
      >
        <canvas ref={canvasRef} />
        <div className="timeline__playhead" style={{ left: playheadPercent }} />
      </div>

      <div className="segments">
        {segments.map((segment, index) => {
          const photo = photos.get(segment.photoId);
          const width = ((segment.end - segment.start) / duration) * 100;
          const active = currentTime >= segment.start && currentTime < segment.end;
          return (
            <button
              type="button"
              key={segment.id}
              className={[
                'segment',
                active ? 'segment--active' : '',
                selectedId === segment.id ? 'segment--selected' : '',
                dropTarget === segment.id ? 'segment--drop' : '',
              ]
                .filter(Boolean)
                .join(' ')}
              style={{ width: `${width}%` }}
              title={`カット ${index + 1}：${photo?.name ?? '(写真なし)'} — ${segment.beats} 拍`}
              onClick={() => {
                onSelect(segment.id);
                onSeek(segment.start);
              }}
              onDragOver={(e) => {
                // プールからの写真だけ受け取る
                if (!e.dataTransfer.types.includes('text/photo-id')) return;
                e.preventDefault();
                e.dataTransfer.dropEffect = 'copy';
                setDropTarget(segment.id);
              }}
              onDragLeave={() => setDropTarget((current) => (current === segment.id ? null : current))}
              onDrop={(e) => {
                e.preventDefault();
                setDropTarget(null);
                const photoId = e.dataTransfer.getData('text/photo-id');
                if (photoId) {
                  onDropPhoto(segment.id, photoId);
                  onSelect(segment.id);
                }
              }}
            >
              {photo && <img src={photo.url} alt="" />}
              <span className="segment__index">{index + 1}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}
