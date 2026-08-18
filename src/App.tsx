import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import PhotoPool from './components/PhotoPool';
import SettingsPanel from './components/SettingsPanel';
import Timeline from './components/Timeline';
import { analyzeInWorker, decodeAudioFile, formatTime } from './engine/audio';
import type { BeatAnalysis } from './engine/beatDetect';
import {
  analysisToJson,
  estimateSizeMb,
  exportVideo,
  QUALITY_PRESETS,
  type QualityPreset,
} from './engine/exporter';
import { renderFrame } from './engine/renderer';
import { applyOverrides, buildSegments } from './engine/segments';
import {
  DEFAULT_SETTINGS,
  type Photo,
  type ProjectSettings,
  type Segment,
  type SegmentOverride,
  type TransitionKind,
} from './engine/types';

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const AUDIO_BITRATE = 128_000;

/** ビート格子を BPM だけ差し替えて作り直す（手動補正用）。 */
function rebuildWithBpm(analysis: BeatAnalysis, bpm: number): BeatAnalysis {
  const period = 60 / bpm;
  const beats: number[] = [];
  for (let t = analysis.offset; t < analysis.duration; t += period) beats.push(t);
  return {
    ...analysis,
    bpm,
    beats,
    downbeats: beats.filter((_, i) => i % 4 === 0),
  };
}

export default function App() {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<BeatAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<ProjectSettings>(DEFAULT_SETTINGS);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [overrides, setOverrides] = useState<Record<string, SegmentOverride>>({});
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [quality, setQuality] = useState<QualityPreset>('standard');

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const exportAbort = useRef<AbortController | null>(null);

  const photoMap = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);
  const audioUrl = useMemo(() => (audioFile ? URL.createObjectURL(audioFile) : null), [audioFile]);

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  const addPhotos = useCallback((files: FileList) => {
    const images = Array.from(files).filter((f) => f.type.startsWith('image/'));
    const loaded = images.map(
      (file) =>
        new Promise<Photo | null>((resolve) => {
          const url = URL.createObjectURL(file);
          const image = new Image();
          image.onload = () =>
            resolve({
              id: `${file.name}-${file.size}-${file.lastModified}`,
              name: file.name,
              url,
              image,
              width: image.naturalWidth,
              height: image.naturalHeight,
            });
          // HEIC などブラウザが表示できない形式は静かに読み飛ばす
          image.onerror = () => {
            URL.revokeObjectURL(url);
            resolve(null);
          };
          image.src = url;
        }),
    );

    void Promise.all(loaded).then((results) => {
      const next = results.filter((p): p is Photo => p !== null);
      const skipped = results.length - next.length;
      if (skipped > 0) {
        setError(`${skipped} 件はブラウザが対応しない画像形式のため読み飛ばしました（HEIC など）`);
      }
      setPhotos((current) => {
        const seen = new Set(current.map((p) => p.id));
        return [...current, ...next.filter((p) => !seen.has(p.id))];
      });
    });
  }, []);

  const loadAudio = useCallback(async (file: File) => {
    setAudioFile(file);
    setAnalyzing(true);
    setError(null);
    try {
      const buffer = await decodeAudioFile(file);
      setAnalysis(await analyzeInWorker(buffer));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '音源を解析できませんでした');
      setAnalysis(null);
    } finally {
      setAnalyzing(false);
    }
  }, []);

  // 素材か設定が変わったら組み直し、その上にカット単位の手編集を重ねる。
  // こうすると「1 枚あたりの拍数」を変えても割り当てが消えない。
  useEffect(() => {
    if (!analysis || photos.length === 0) {
      setSegments([]);
      return;
    }
    const base = buildSegments(photos, analysis, settings);
    const available = new Set(photos.map((p) => p.id));
    setSegments(applyOverrides(base, overrides, analysis, available));
  }, [analysis, photos, settings, overrides]);

  const renderContext = useMemo(
    () => (analysis ? { segments, photos: photoMap, analysis, settings } : null),
    [segments, photoMap, analysis, settings],
  );

  // 再生中の描画ループ。React の状態更新は毎フレームだと重いので、
  // 描画は ref を見て回し、UI 向けの時刻更新だけ間引く。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !renderContext || !playing) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    let handle = 0;
    let lastPublished = 0;

    const loop = () => {
      const audio = audioRef.current;
      if (!audio) return;
      const time = audio.currentTime;
      renderFrame(ctx, time, renderContext);

      // タイムラインの再描画は 10 回/秒あれば十分
      if (time - lastPublished > 0.1 || time < lastPublished) {
        lastPublished = time;
        setCurrentTime(time);
      }
      handle = requestAnimationFrame(loop);
    };

    handle = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(handle);
  }, [renderContext, playing]);

  // 停止中は、シークや設定変更のたびに 1 枚だけ描き直す。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !renderContext || playing) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (ctx) renderFrame(ctx, currentTime, renderContext);
  }, [renderContext, playing, currentTime]);

  const patchOverride = useCallback((segmentId: string, patch: SegmentOverride) => {
    setOverrides((current) => ({ ...current, [segmentId]: { ...current[segmentId], ...patch } }));
  }, []);

  /** 写真をカットに当てはめる。クリック割り当てでは次のカットへ自動で進む。 */
  const assignPhoto = useCallback(
    (segmentId: string, photoId: string, advance: boolean) => {
      patchOverride(segmentId, { photoId });
      if (!advance) return;
      setSegments((current) => {
        const index = current.findIndex((s) => s.id === segmentId);
        const next = current[index + 1];
        if (next) setSelectedId(next.id);
        return current;
      });
    },
    [patchOverride],
  );

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (audio) audio.currentTime = time;
    setCurrentTime(time);
  }, []);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  }, []);

  const handleExport = useCallback(async () => {
    if (!renderContext || !audioFile) return;
    audioRef.current?.pause();
    const controller = new AbortController();
    exportAbort.current = controller;
    setExportProgress(0);
    setError(null);
    try {
      const preset = QUALITY_PRESETS[quality];
      const blob = await exportVideo(renderContext, audioFile, {
        width: preset.width,
        height: preset.height,
        fps: 30,
        videoBitsPerSecond: preset.videoBitsPerSecond,
        audioBitsPerSecond: AUDIO_BITRATE,
        onProgress: setExportProgress,
        signal: controller.signal,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'slideshow.webm';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '書き出しに失敗しました');
    } finally {
      setExportProgress(null);
      exportAbort.current = null;
    }
  }, [renderContext, audioFile, quality]);

  const selected = segments.find((s) => s.id === selectedId) ?? null;
  const usedPhotoIds = useMemo(
    () => new Set(segments.map((s) => s.photoId)),
    [segments],
  );
  const ready = analysis !== null && photos.length > 0 && segments.length > 0;

  return (
    <div className="app">
      <header className="app__head">
        <h1>Slideshow Maker</h1>
        <p>写真を音楽のビートに合わせて切り替える、ブラウザ完結のスライドショー作成ツール</p>
      </header>

      {error && (
        <div className="notice" role="status">
          {error}
          <button type="button" onClick={() => setError(null)} aria-label="閉じる">
            ×
          </button>
        </div>
      )}

      <div className="app__body">
        <div className="app__side">
          <PhotoPool
            photos={photos}
            audioName={audioFile?.name ?? null}
            analyzing={analyzing}
            usedPhotoIds={usedPhotoIds}
            hasSelection={selectedId !== null}
            onAssign={(photoId) => {
              if (selectedId) assignPhoto(selectedId, photoId, true);
            }}
            onPhotos={addPhotos}
            onAudio={(file) => void loadAudio(file)}
            onRemovePhoto={(id) => {
              setPhotos((current) => current.filter((p) => p.id !== id));
            }}
          />

          <SettingsPanel
            settings={settings}
            analysis={analysis}
            selected={selected}
            onChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
            onBpmOverride={(bpm) =>
              setAnalysis((current) => (current ? rebuildWithBpm(current, bpm) : current))
            }
            onResizeSelected={(delta) => {
              if (!selected) return;
              patchOverride(selected.id, { beats: Math.max(1, selected.beats + delta) });
            }}
            onTransitionForSelected={(kind: TransitionKind) => {
              if (!selected) return;
              patchOverride(selected.id, { transition: kind });
            }}
            onClearOverride={() => {
              if (!selected) return;
              setOverrides((current) => {
                const next = { ...current };
                delete next[selected.id];
                return next;
              });
            }}
            hasOverrides={Object.keys(overrides).length > 0}
            onClearAllOverrides={() => setOverrides({})}
          />
        </div>

        <main className="app__main">
          <section className="panel panel--stage">
            <canvas
              ref={canvasRef}
              width={CANVAS_WIDTH}
              height={CANVAS_HEIGHT}
              className="stage"
              onClick={togglePlay}
            />
            {!ready && (
              <p className="stage__empty">写真と音源を読み込むとプレビューが始まります</p>
            )}

            <div className="transport">
              <button type="button" onClick={togglePlay} disabled={!ready}>
                {playing ? '一時停止' : '再生'}
              </button>
              <button type="button" onClick={() => seek(0)} disabled={!ready}>
                先頭へ
              </button>
              <span className="muted">
                {formatTime(currentTime)} / {formatTime(analysis?.duration ?? 0)}
              </span>
              <div className="transport__spacer" />
              <select
                value={quality}
                onChange={(e) => setQuality(e.target.value as QualityPreset)}
                disabled={exportProgress !== null}
                className="transport__quality"
                aria-label="書き出し画質"
              >
                {(Object.keys(QUALITY_PRESETS) as QualityPreset[]).map((key) => (
                  <option key={key} value={key}>
                    {QUALITY_PRESETS[key].label}
                    {analysis
                      ? ` — 約 ${estimateSizeMb(
                          analysis.duration,
                          QUALITY_PRESETS[key].videoBitsPerSecond,
                          AUDIO_BITRATE,
                        ).toFixed(0)}MB`
                      : ''}
                  </option>
                ))}
              </select>
              <button
                type="button"
                className="primary"
                onClick={() => void handleExport()}
                disabled={!ready || exportProgress !== null}
              >
                {exportProgress !== null
                  ? `書き出し中 ${Math.round(exportProgress * 100)}%`
                  : '動画を書き出す'}
              </button>
              {exportProgress !== null && (
                <button type="button" onClick={() => exportAbort.current?.abort()}>
                  中止
                </button>
              )}
              {analysis && (
                <button
                  type="button"
                  onClick={() => {
                    const blob = new Blob([analysisToJson(analysis)], {
                      type: 'application/json',
                    });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement('a');
                    link.href = url;
                    link.download = 'beats.json';
                    link.click();
                    setTimeout(() => URL.revokeObjectURL(url), 10000);
                  }}
                >
                  解析結果を保存
                </button>
              )}
            </div>
            {exportProgress !== null && (
              <p className="muted">
                書き出しは実時間で録画するため、曲の長さぶんの時間がかかります。
                このタブを開いたままにしてください。
              </p>
            )}
          </section>

          {analysis && (
            <Timeline
              analysis={analysis}
              segments={segments}
              photos={photoMap}
              currentTime={currentTime}
              selectedId={selectedId}
              onSeek={seek}
              onSelect={setSelectedId}
              onDropPhoto={(segmentId, photoId) => assignPhoto(segmentId, photoId, false)}
            />
          )}
        </main>
      </div>

      {audioUrl && (
        <audio
          ref={audioRef}
          src={audioUrl}
          onPlay={() => setPlaying(true)}
          onPause={(e) => {
            setPlaying(false);
            // 間引いていたぶんのずれを、停止時に正確な位置へ合わせる
            setCurrentTime(e.currentTarget.currentTime);
          }}
          onEnded={() => setPlaying(false)}
          onSeeked={(e) => setCurrentTime(e.currentTarget.currentTime)}
        />
      )}
    </div>
  );
}
