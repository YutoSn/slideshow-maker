import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { BeatAnalysis } from '../engine/beatDetect';
import { formatTime } from '../engine/audio';
import type { Photo, Segment } from '../engine/types';

interface Props {
  analysis: BeatAnalysis;
  segments: Segment[];
  photos: Map<string, Photo>;
  currentTime: number;
  playing: boolean;
  selectedId: string | null;
  onSeek: (time: number) => void;
  onSelect: (id: string) => void;
  /** プールからドラッグしてきた写真を、このカットに割り当てる */
  onDropPhoto: (segmentId: string, photoId: string) => void;
  /** カットを掴んで別の位置へ動かす（間のカットは順にずれる） */
  onReorder: (fromIndex: number, toIndex: number) => void;
  /** トランジションの長さ（秒）。カットを選んだときの表示位置に使う */
  transitionSeconds: number;
}

const HEIGHT = 74;
const MIN_ZOOM = 1;
const MAX_ZOOM = 40;

/** 目盛りの間隔（秒）。拡大率に応じて見やすい刻みを選ぶ。 */
function tickInterval(secondsPerPixel: number): number {
  const target = secondsPerPixel * 90; // 目盛りどうしを 90px 以上あける
  for (const step of [1, 2, 5, 10, 15, 30, 60, 120, 300]) {
    if (step >= target) return step;
  }
  return 600;
}

export default function Timeline({
  analysis,
  segments,
  photos,
  currentTime,
  playing,
  selectedId,
  onSeek,
  onSelect,
  onDropPhoto,
  onReorder,
  transitionSeconds,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);

  // 拡大時に、どの位置を動かさずに保つか（拡大前の内容座標と、画面上の x）
  const anchorRef = useRef<{ ratio: number; offsetX: number } | null>(null);

  const duration = analysis.duration || 1;

  /**
   * 目盛りは「今見えている範囲」だけを描く。
   * 拡大すると内容は数万 px になり得るので、canvas 自体は画面幅のまま
   * 横スクロール位置に追従させる（canvas の最大サイズ制限も避けられる）。
   */
  const draw = useCallback(() => {
    const canvas = canvasRef.current;
    const scroll = scrollRef.current;
    const inner = innerRef.current;
    if (!canvas || !scroll || !inner) return;

    const viewWidth = scroll.clientWidth;
    const contentWidth = inner.clientWidth || viewWidth;
    const scrollLeft = scroll.scrollLeft;
    if (viewWidth === 0) return;

    const dpr = window.devicePixelRatio || 1;
    canvas.width = Math.round(viewWidth * dpr);
    canvas.height = Math.round(HEIGHT * dpr);
    canvas.style.width = `${viewWidth}px`;
    canvas.style.height = `${HEIGHT}px`;

    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.fillStyle = '#12121a';
    ctx.fillRect(0, 0, viewWidth, HEIGHT);

    const { onsetEnvelope, envelopeHopSeconds, beats, downbeats } = analysis;
    const secondsPerPixel = duration / contentWidth;

    // 画面上の x（0..viewWidth）と、曲の時刻との相互変換
    const timeAt = (x: number) => ((scrollLeft + x) / contentWidth) * duration;
    const xOf = (time: number) => (time / duration) * contentWidth - scrollLeft;

    // オンセット包絡線
    ctx.fillStyle = '#3d4d7a';
    for (let x = 0; x < viewWidth; x++) {
      const from = timeAt(x);
      const to = timeAt(x + 1);
      // 1px に複数フレームが入るときは、その中の最大値を使う
      let value = 0;
      const start = Math.floor(from / envelopeHopSeconds);
      const end = Math.max(start + 1, Math.ceil(to / envelopeHopSeconds));
      for (let i = start; i < end; i++) {
        const sample = onsetEnvelope[i];
        if (sample !== undefined && sample > value) value = sample;
      }
      const h = Math.max(1, value * (HEIGHT - 20));
      ctx.fillRect(x, HEIGHT - 10 - h, 1, h);
    }

    const visibleFrom = timeAt(0);
    const visibleTo = timeAt(viewWidth);

    // 拍。細かすぎて潰れるときは省く
    const beatSpacing = 60 / analysis.bpm / secondsPerPixel;
    if (beatSpacing > 3) {
      ctx.strokeStyle = 'rgba(255,255,255,0.14)';
      ctx.beginPath();
      for (const beat of beats) {
        if (beat < visibleFrom) continue;
        if (beat > visibleTo) break;
        const x = Math.round(xOf(beat)) + 0.5;
        ctx.moveTo(x, HEIGHT - 10);
        ctx.lineTo(x, HEIGHT - 4);
      }
      ctx.stroke();
    }

    // 小節頭
    ctx.strokeStyle = 'rgba(120,200,255,0.55)';
    ctx.beginPath();
    for (const beat of downbeats) {
      if (beat < visibleFrom) continue;
      if (beat > visibleTo) break;
      const x = Math.round(xOf(beat)) + 0.5;
      ctx.moveTo(x, 4);
      ctx.lineTo(x, HEIGHT - 4);
    }
    ctx.stroke();

    // 時刻の目盛り
    const interval = tickInterval(secondsPerPixel);
    ctx.fillStyle = 'rgba(232,232,240,0.5)';
    ctx.font = '10px ui-monospace, monospace';
    ctx.textBaseline = 'top';
    const firstTick = Math.floor(visibleFrom / interval) * interval;
    for (let t = firstTick; t <= visibleTo; t += interval) {
      if (t < 0) continue;
      const x = Math.round(xOf(t)) + 0.5;
      ctx.fillRect(x, 0, 1, 5);
      ctx.fillText(formatTime(t), x + 4, 1);
    }
  }, [analysis, duration]);

  // 拡大率・解析結果が変わったら描き直す。スクロールとリサイズにも追従する。
  useEffect(() => {
    draw();
    const scroll = scrollRef.current;
    const inner = innerRef.current;
    if (!scroll || !inner) return;

    const onScroll = () => draw();
    scroll.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(draw);
    observer.observe(scroll);
    observer.observe(inner);
    return () => {
      scroll.removeEventListener('scroll', onScroll);
      observer.disconnect();
    };
  }, [draw, zoom]);

  // 拡大の前後で、狙った位置が画面上の同じところに残るようにスクロールを合わせる
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    anchorRef.current = null;
    const scroll = scrollRef.current;
    const inner = innerRef.current;
    if (!anchor || !scroll || !inner) return;
    scroll.scrollLeft = anchor.ratio * inner.clientWidth - anchor.offsetX;
    draw();
  }, [zoom, draw]);

  /** 画面上の x を基準に拡大率を変える。x を省くと再生位置を基準にする。 */
  const applyZoom = useCallback(
    (next: number, offsetX?: number) => {
      const scroll = scrollRef.current;
      const inner = innerRef.current;
      const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
      if (!scroll || !inner) {
        setZoom(clamped);
        return;
      }
      const contentWidth = inner.clientWidth;
      const x = offsetX ?? scroll.clientWidth / 2;
      const ratio =
        offsetX === undefined
          ? currentTime / duration
          : (scroll.scrollLeft + x) / contentWidth;
      anchorRef.current = { ratio, offsetX: x };
      setZoom(clamped);
    },
    [currentTime, duration],
  );

  // 再生中は再生位置を画面内に保つ
  useEffect(() => {
    if (!playing || zoom === 1) return;
    const scroll = scrollRef.current;
    const inner = innerRef.current;
    if (!scroll || !inner) return;

    const x = (currentTime / duration) * inner.clientWidth - scroll.scrollLeft;
    const view = scroll.clientWidth;
    if (x < view * 0.1 || x > view * 0.9) {
      scroll.scrollLeft = (currentTime / duration) * inner.clientWidth - view / 2;
    }
  }, [currentTime, playing, zoom, duration]);

  const seekFromEvent = (clientX: number) => {
    const scroll = scrollRef.current;
    const inner = innerRef.current;
    if (!scroll || !inner) return;
    const rect = scroll.getBoundingClientRect();
    const contentX = scroll.scrollLeft + (clientX - rect.left);
    onSeek(Math.max(0, Math.min(duration, (contentX / inner.clientWidth) * duration)));
  };

  return (
    <section className="panel">
      <div className="panel__head">
        <h2>3. タイムライン</h2>
        <div className="zoom">
          <span className="muted">
            {analysis.bpm.toFixed(1)} BPM ／ {segments.length} カット ／ {formatTime(duration)}
          </span>
          <div className="zoom__controls">
            <button
              type="button"
              onClick={() => applyZoom(zoom / 1.6)}
              disabled={zoom <= MIN_ZOOM}
              aria-label="タイムラインを縮小"
              title="縮小"
            >
              −
            </button>
            <span className="zoom__level">×{zoom < 10 ? zoom.toFixed(1) : Math.round(zoom)}</span>
            <button
              type="button"
              onClick={() => applyZoom(zoom * 1.6)}
              disabled={zoom >= MAX_ZOOM}
              aria-label="タイムラインを拡大"
              title="拡大"
            >
              ＋
            </button>
            <button type="button" onClick={() => applyZoom(1)} disabled={zoom === 1} title="全体を表示">
              全体
            </button>
          </div>
        </div>
      </div>

      <div
        ref={scrollRef}
        className={`timeline${zoom > 1 ? ' timeline--zoomed' : ''}`}
        onWheel={(e) => {
          // Ctrl + ホイールで、カーソル位置を基準に拡大縮小
          if (!e.ctrlKey && !e.metaKey) return;
          e.preventDefault();
          const rect = e.currentTarget.getBoundingClientRect();
          applyZoom(zoom * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - rect.left);
        }}
      >
        <div ref={innerRef} className="timeline__inner" style={{ width: `${zoom * 100}%` }}>
          <canvas
            ref={canvasRef}
            className="timeline__ruler"
            onClick={(e) => seekFromEvent(e.clientX)}
          />

          <div className="segments">
            {segments.map((segment, index) => {
              const photo = photos.get(segment.photoId);
              // 実際の開始時刻で配置する。こうすると上段の拍の線と必ず揃う
              const left = (segment.start / duration) * 100;
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
                    draggingIndex === index ? 'segment--dragging' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`カット ${index + 1}：${photo?.name ?? '(写真なし)'} — ${segment.beats} 拍（ドラッグで並べ替え）`}
                  draggable
                  onClick={() => {
                    onSelect(segment.id);
                    // カットの先頭はクロスフェードの開始点で、まだ前の写真が
                    // 不透明のまま。切り替わりきった位置へ送って、選んだ写真を映す
                    const settled = segment.start + transitionSeconds;
                    const middle = (segment.start + segment.end) / 2;
                    onSeek(Math.min(Math.max(settled, segment.start), Math.max(middle, segment.start)));
                  }}
                  onDragStart={(e) => {
                    e.dataTransfer.setData('text/cut-index', String(index));
                    e.dataTransfer.effectAllowed = 'move';
                    setDraggingIndex(index);
                  }}
                  onDragEnd={() => {
                    setDraggingIndex(null);
                    setDropTarget(null);
                  }}
                  onDragOver={(e) => {
                    // プールからの写真か、タイムライン上の別のカットだけ受け取る
                    const types = e.dataTransfer.types;
                    const fromPool = types.includes('text/photo-id');
                    const fromCut = types.includes('text/cut-index');
                    if (!fromPool && !fromCut) return;
                    e.preventDefault();
                    e.dataTransfer.dropEffect = fromCut ? 'move' : 'copy';
                    setDropTarget(segment.id);
                  }}
                  onDragLeave={() =>
                    setDropTarget((current) => (current === segment.id ? null : current))
                  }
                  onDrop={(e) => {
                    e.preventDefault();
                    setDropTarget(null);

                    const cutIndex = e.dataTransfer.getData('text/cut-index');
                    if (cutIndex !== '') {
                      const from = Number(cutIndex);
                      if (Number.isInteger(from) && from !== index) onReorder(from, index);
                      onSelect(segment.id);
                      return;
                    }

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

          <div
            className="timeline__playhead"
            style={{ left: `${(currentTime / duration) * 100}%` }}
          />
        </div>
      </div>

      {zoom > 1 && (
        <p className="muted zoom__hint">
          横にスクロールして移動できます。Ctrl（Mac は ⌘）を押しながらホイールでも拡大縮小できます。
        </p>
      )}
    </section>
  );
}
