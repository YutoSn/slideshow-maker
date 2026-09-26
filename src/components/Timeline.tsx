import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { BeatAnalysis } from '../engine/beatDetect';
import { formatTime } from '../engine/audio';
import BpmField from './BpmField';
import { onPlayhead } from '../engine/playhead';
import type { DriftLevel, DriftSummary } from '../engine/onsets';
import type { MediaItem, Segment } from '../engine/types';

interface Props {
  analysis: BeatAnalysis;
  segments: Segment[];
  photos: Map<string, MediaItem>;
  currentTime: number;
  playing: boolean;
  selectedId: string | null;
  onSeek: (time: number) => void;
  onSelect: (id: string) => void;
  /** プールからドラッグしてきた写真を、このカットに割り当てる */
  onDropPhoto: (segmentId: string, mediaId: string) => void;
  /** カットを掴んで別の位置へ動かす（間のカットは順にずれる） */
  onReorder: (fromIndex: number, toIndex: number) => void;
  /** BPM を直すときに動かさないカット（選択中のカット）の番号。無ければ -1 */
  anchorIndex: number;
  onBpmOverride: (bpm: number) => void;
  /** 格子全体を秒単位でずらす */
  onGridShift: (deltaSeconds: number) => void;
  /** カットの境目ごとの、音とのずれ（ルーラーに色で出す） */
  drift: DriftSummary | null;
  /** 「2 点で合わせる」の A・B（ルーラーに印を出す） */
  marks: { label: string; time: number }[];
  /** 素材を差し替えた直後に光らせるカット（`カット ID:時刻`。時刻が変われば光らせ直す） */
  flashId: string | null;
  /** 解析結果（BPM・拍の位置）を JSON で保存する */
  onSaveBeats: () => void;
  /** 操作列の下に置く道具（合わせ方・クリック音など） */
  children?: ReactNode;
}

const DRIFT_COLORS: Record<DriftLevel, string> = {
  good: '#5fd38d',
  fair: '#ffc46b',
  bad: '#ff6b6b',
  none: 'rgba(154,154,176,0.55)',
};

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
  anchorIndex,
  onBpmOverride,
  onGridShift,
  drift,
  marks,
  onSaveBeats,
  flashId,
  children,
}: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef<HTMLDivElement>(null);
  const segmentsRef = useRef<HTMLDivElement>(null);
  const activeIndexRef = useRef(-1);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [draggingIndex, setDraggingIndex] = useState<number | null>(null);
  const [zoom, setZoom] = useState(1);
  const zoomRef = useRef(1);
  zoomRef.current = zoom;

  // 拡大時に、どの位置を動かさずに保つか（拡大前の内容座標と、画面上の x）
  const anchorRef = useRef<{ ratio: number; offsetX: number } | null>(null);
  // 手で動かした直後の時刻。しばらくは再生位置の追尾をしない
  const userScrolledAt = useRef(0);

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

    // カットの境目ごとの、音とのずれ。下端に色の印を出す
    if (drift) {
      for (const boundary of drift.boundaries) {
        if (boundary.time < visibleFrom - 1 || boundary.time > visibleTo + 1) continue;
        const x = Math.round(xOf(boundary.time));
        ctx.fillStyle = DRIFT_COLORS[boundary.level];
        ctx.beginPath();
        ctx.moveTo(x - 4, HEIGHT);
        ctx.lineTo(x + 4, HEIGHT);
        ctx.lineTo(x, HEIGHT - 7);
        ctx.closePath();
        ctx.fill();
      }
    }

    // 「2 点で合わせる」の A・B
    ctx.font = 'bold 10px ui-monospace, monospace';
    for (const mark of marks) {
      if (mark.time < visibleFrom || mark.time > visibleTo) continue;
      const x = Math.round(xOf(mark.time)) + 0.5;
      ctx.fillStyle = '#e879f9';
      ctx.fillRect(x - 0.5, 12, 2, HEIGHT - 12);
      ctx.fillText(mark.label, x + 4, 13);
    }

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
  }, [analysis, duration, drift, marks]);

  // 拡大率・解析結果が変わったら描き直す。スクロールとリサイズにも追従する。
  useEffect(() => {
    draw();
    const scroll = scrollRef.current;
    const inner = innerRef.current;
    if (!scroll || !inner) return;

    const onScroll = () => draw();
    const markManual = () => {
      userScrolledAt.current = Date.now();
    };
    scroll.addEventListener('pointerdown', markManual);
    scroll.addEventListener('keydown', markManual);
    scroll.addEventListener('scroll', onScroll, { passive: true });
    const observer = new ResizeObserver(draw);
    observer.observe(scroll);
    observer.observe(inner);
    return () => {
      scroll.removeEventListener('scroll', onScroll);
      scroll.removeEventListener('pointerdown', markManual);
      scroll.removeEventListener('keydown', markManual);
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

      setZoom((current) => {
        const clamped = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, next));
        // 拡大率が変わらないときに基準位置を残すと、あとで別の理由で
        // 再描画されたときにその古い位置へ飛んでしまう
        if (clamped === current || !scroll || !inner) return clamped;

        const x = offsetX ?? scroll.clientWidth / 2;
        const ratio =
          offsetX === undefined
            ? currentTime / duration
            : (scroll.scrollLeft + x) / inner.clientWidth;
        anchorRef.current = { ratio, offsetX: x };
        return clamped;
      });
    },
    [currentTime, duration],
  );

  /**
   * 再生中の見た目の更新。
   * 毎フレーム React を動かすとスマホでは間に合わないので、
   * 線の位置と強調表示だけを直接書き換える。
   */
  useEffect(() => {
    if (!playing) return;
    return onPlayhead((time) => {
      const line = playheadRef.current;
      if (line) line.style.left = `${(time / duration) * 100}%`;

      const strip = segmentsRef.current;
      if (!strip) return;
      let index = -1;
      for (let i = 0; i < segments.length; i++) {
        if (time >= segments[i].start && time < segments[i].end) {
          index = i;
          break;
        }
      }
      if (index === activeIndexRef.current) return;
      strip.children[activeIndexRef.current]?.classList.remove('segment--active');
      strip.children[index]?.classList.add('segment--active');
      activeIndexRef.current = index;
    });
  }, [playing, duration, segments]);

  // 再生中は再生位置を画面内に保つ。
  // ただし手で動かした直後は、追尾が邪魔になるので少し待つ。
  useEffect(() => {
    if (!playing || zoom === 1) return;
    return onPlayhead((time) => {
      if (Date.now() - userScrolledAt.current < 3000) return;
      const scroll = scrollRef.current;
      const inner = innerRef.current;
      if (!scroll || !inner) return;

      const x = (time / duration) * inner.clientWidth - scroll.scrollLeft;
      const view = scroll.clientWidth;
      if (x < view * 0.1 || x > view * 0.9) {
        scroll.scrollLeft = (time / duration) * inner.clientWidth - view / 2;
      }
    });
  }, [playing, zoom, duration]);

  /**
   * ホイール操作。
   * React はホイールを passive で登録するため onWheel では preventDefault が
   * 効かず、Ctrl + ホイールでブラウザ側も拡大してしまう。
   * ここは自前で passive: false で登録する。
   */
  useEffect(() => {
    const scroll = scrollRef.current;
    if (!scroll) return;

    const onWheel = (e: WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        const rect = scroll.getBoundingClientRect();
        applyZoom(zoomRef.current * (e.deltaY < 0 ? 1.15 : 1 / 1.15), e.clientX - rect.left);
        return;
      }
      // 拡大中は、縦ホイールでも横に動かせるようにする
      const overflow = scroll.scrollWidth - scroll.clientWidth;
      if (overflow <= 0) return;
      const delta = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      if (delta === 0) return;
      e.preventDefault();
      userScrolledAt.current = Date.now();
      scroll.scrollLeft = Math.min(overflow, Math.max(0, scroll.scrollLeft + delta));
    };

    scroll.addEventListener('wheel', onWheel, { passive: false });
    return () => scroll.removeEventListener('wheel', onWheel);
  }, [applyZoom]);

  /** 目盛りの下の ▲ にマウスを乗せたときの説明 */
  const describeBoundaryAt = (clientX: number): string => {
    const scroll = scrollRef.current;
    const inner = innerRef.current;
    const fallback = 'クリックでその位置へ移動';
    if (!scroll || !inner || !drift) return fallback;
    const rect = scroll.getBoundingClientRect();
    const contentX = scroll.scrollLeft + (clientX - rect.left);
    const pxPerSecond = inner.clientWidth / duration;

    let best = -1;
    let bestDistance = 6; // px
    drift.boundaries.forEach((boundary, index) => {
      const distance = Math.abs(boundary.time * pxPerSecond - contentX);
      if (distance <= bestDistance) {
        best = index;
        bestDistance = distance;
      }
    });
    if (best < 0) return fallback;

    const { drift: offset, level } = drift.boundaries[best];
    const head = `カット ${best + 1} への切り替わり`;
    if (level === 'none' || offset === null) {
      return `${head}：近くに目立つ音が無く、判定できません（静かな所など）`;
    }
    const size = Math.round(Math.abs(offset) * 1000);
    const direction = size === 0 ? '音とぴったり' : `音より ${size}ms ${offset > 0 ? '遅い' : '早い'}`;
    const verdict = level === 'good' ? '合っている' : level === 'fair' ? '少しずれ' : 'ずれ';
    return `${head}：${direction}（${verdict}）`;
  };

  const seekFromEvent = (clientX: number) => {
    const scroll = scrollRef.current;
    const inner = innerRef.current;
    if (!scroll || !inner) return;
    const rect = scroll.getBoundingClientRect();
    const contentX = scroll.scrollLeft + (clientX - rect.left);
    onSeek(Math.max(0, Math.min(duration, (contentX / inner.clientWidth) * duration)));
  };

  return (
    <section className="panel panel--timeline">
      <div className="toolbar">
        <h2>3. タイムライン</h2>

        <BpmField
          bpm={analysis.bpm}
          onChange={onBpmOverride}
          onShift={onGridShift}
          anchorLabel={anchorIndex >= 0 ? `カット ${anchorIndex + 1}` : null}
        />

        <button
          type="button"
          className="linkish toolbar__save"
          onClick={onSaveBeats}
          title="検出した BPM とビート位置を JSON ファイルとして保存します"
        >
          解析結果を保存
        </button>

      </div>

      {/* 合わせる道具と表示範囲の操作は 1 行にまとめ、プレビューの高さを奪わないようにする */}
      <div className="timeline__tools">
        {children}
          <div className="toolbar__right">
            <span className="muted">
              {segments.length} カット ／ {formatTime(duration)}
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
      >
        <div ref={innerRef} className="timeline__inner" style={{ width: `${zoom * 100}%` }}>
          <canvas
            ref={canvasRef}
            className="timeline__ruler"
            onClick={(e) => seekFromEvent(e.clientX)}
            onMouseMove={(e) => {
              e.currentTarget.title = describeBoundaryAt(e.clientX);
            }}
          />

          <div className="segments" ref={segmentsRef}>
            {segments.map((segment, index) => {
              const photo = photos.get(segment.mediaId);
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
                    anchorIndex === index ? 'segment--anchor' : '',
                    flashId?.startsWith(`${segment.id}:`) ? 'segment--flash' : '',
                  ]
                    .filter(Boolean)
                    .join(' ')}
                  style={{ left: `${left}%`, width: `${width}%` }}
                  title={`カット ${index + 1}：${photo?.name ?? '(写真なし)'} — ${segment.beats} 拍（ドラッグで並べ替え）`}
                  draggable
                  // 選ぶと、プレビューもそのカットへ送られる（App 側でそろえる）
                  onClick={() => onSelect(segment.id)}
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

                    const mediaId = e.dataTransfer.getData('text/photo-id');
                    if (mediaId) {
                      onDropPhoto(segment.id, mediaId);
                      onSelect(segment.id);
                    }
                  }}
                >
                  {photo && <img src={photo.thumbnail} alt="" />}
                  <span className="segment__index">{index + 1}</span>
                </button>
              );
            })}
          </div>

          <div
            ref={playheadRef}
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
