import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent } from 'react';
import MediaPool from './components/MediaPool';
import ProjectPanel from './components/ProjectPanel';
import CutPanel from './components/CutPanel';
import { useEditHistory } from './useEditHistory';
import SettingsPanel from './components/SettingsPanel';
import SyncTools, { type ClickMode, type SyncPoints } from './components/SyncTools';
import Timeline from './components/Timeline';
import { analyzeInWorker, decodeAudioFile, formatTime } from './engine/audio';
import {
  deleteProject,
  estimateUsage,
  getLastOpenedId,
  isStorageAvailable,
  listProjects,
  loadProject,
  newProjectId,
  saveProject,
  setLastOpenedId,
  type ProjectSummary,
  type StoredProject,
} from './engine/projectStore';
import type { BeatAnalysis } from './engine/beatDetect';
import {
  analysisToJson,
  estimateSizeMb,
  ExportAborted,
  exportVideo,
  type ExportMode,
  QUALITY_PRESETS,
  type QualityPreset,
} from './engine/exporter';
import { coverSlack, renderFrame, segmentAt, type PhotoFocus } from './engine/renderer';
import { isMediaFile, loadMedia, mediaIdFor } from './engine/loadMedia';
import { emitPlayhead, onPlayhead } from './engine/playhead';
import { pauseAllVideos, syncVideos } from './engine/videoSync';
import { applyOverrides, buildSegments } from './engine/segments';
import { alignToTwoPoints, rebuildGrid, shiftGrid, type GridAnchor } from './engine/beatGrid';
import { startMetronome } from './engine/metronome';
import { measureDrift, snapToOnset } from './engine/onsets';
import {
  DEFAULT_SETTINGS,
  normalizeSettings,
  type MediaItem,
  type ProjectSettings,
  type FitMode,
  type Segment,
  type SegmentOverride,
  type TransitionKind,
} from './engine/types';

const AUDIO_BITRATE = 128_000;

/**
 * プレビューの描画解像度を決める。
 *
 * 表示は数百 px しかないのに 1280x720 で描くと、スマホでは 1 フレームに
 * 150ms 以上かかる。表示サイズと端末の性能から、必要なだけの大きさを選ぶ。
 * 書き出しは別の canvas を使うので、ここを下げても仕上がりの画質には影響しない。
 */
function previewSizeFor(cssWidth: number): { width: number; height: number } {
  const cores = navigator.hardwareConcurrency ?? 4;
  const dpr = Math.min(window.devicePixelRatio || 1, 1.5);
  const wanted = cssWidth * dpr;

  let width = 1280;
  if (wanted <= 720 || cores <= 4) width = 640;
  else if (wanted <= 1100 || cores <= 6) width = 960;

  return { width, height: Math.round((width * 9) / 16) };
}

export default function App() {
  const [photos, setPhotos] = useState<MediaItem[]>([]);
  const [audioFile, setAudioFile] = useState<File | null>(null);
  const [analysis, setAnalysis] = useState<BeatAnalysis | null>(null);
  const [analyzing, setAnalyzing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [settings, setSettings] = useState<ProjectSettings>(DEFAULT_SETTINGS);
  const [segments, setSegments] = useState<Segment[]>([]);
  const [overrides, setOverrides] = useState<Record<string, SegmentOverride>>({});
  // 写真ごとの「どこを見せるか」。プレビューのドラッグで決める
  const [focus, setFocus] = useState<Record<string, PhotoFocus>>({});

  // 元に戻す / やり直すの対象。ここに挙げた state の変更はすべて履歴に積まれる
  const edits = useEditHistory(
    { photos, analysis, settings, overrides, focus },
    (snapshot) => {
      setPhotos(snapshot.photos);
      setAnalysis(snapshot.analysis);
      setSettings(snapshot.settings);
      setOverrides(snapshot.overrides);
      setFocus(snapshot.focus);
    },
  );
  const resetHistory = edits.reset;

  // --- プロジェクトの保存 ---
  const [projectId, setProjectId] = useState<string | null>(null);
  const [projectName, setProjectName] = useState('無題のプロジェクト');
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [saveStatus, setSaveStatus] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [usage, setUsage] = useState<{ usedMb: number; quotaMb: number } | null>(null);
  const [restored, setRestored] = useState<string | null>(null);
  // 写真の File 本体は保存にしか使わないので、描画用の MediaItem とは別に持つ
  const photoFiles = useRef<Map<string, File>>(new Map());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [currentTime, setCurrentTime] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [exportProgress, setExportProgress] = useState<number | null>(null);
  const [quality, setQuality] = useState<QualityPreset>('standard');
  const [exportMode, setExportMode] = useState<ExportMode | null>(null);
  // 曲と合わせるための道具（2 点で合わせる・クリック音）
  const [syncPoints, setSyncPoints] = useState<SyncPoints>({ a: null, b: null });
  const [clickMode, setClickMode] = useState<ClickMode>('off');
  // 素材を割り当てた直後の知らせ（どのカットを何に差し替えたか）
  const [assigned, setAssigned] = useState<{
    segmentId: string;
    name: string;
    /** もともと同じ素材だった */
    same: boolean;
    at: number;
  } | null>(null);
  // 音源を替えたら、前の曲に置いた点は意味がない
  useEffect(() => setSyncPoints({ a: null, b: null }), [audioFile]);

  const canvasRef = useRef<HTMLCanvasElement>(null);
  const stageFrameRef = useRef<HTMLDivElement>(null);
  const playheadRef = useRef(0);
  const timeReadoutRef = useRef<HTMLSpanElement>(null);
  const [previewSize, setPreviewSize] = useState({ width: 1280, height: 720 });
  const audioRef = useRef<HTMLAudioElement>(null);
  const exportAbort = useRef<AbortController | null>(null);
  // ドラッグ終了時に呼びたいが、定義順の都合で ref 経由にする
  const togglePlayRef = useRef<(() => void) | null>(null);

  const mediaMap = useMemo(() => new Map(photos.map((p) => [p.id, p])), [photos]);
  const audioUrl = useMemo(() => (audioFile ? URL.createObjectURL(audioFile) : null), [audioFile]);

  useEffect(() => () => {
    if (audioUrl) URL.revokeObjectURL(audioUrl);
  }, [audioUrl]);

  const addPhotos = useCallback((files: FileList) => {
    const chosen = Array.from(files).filter(isMediaFile);
    if (chosen.length === 0) return;

    void Promise.all(
      chosen.map((file) =>
        loadMedia(file).then((item) => {
          if (item) photoFiles.current.set(mediaIdFor(file), file);
          return item;
        }),
      ),
    ).then((results) => {
      const next = results.filter((p): p is MediaItem => p !== null);
      const skipped = results.length - next.length;
      if (skipped > 0) {
        setError(
          `${skipped} 件はブラウザが対応しない形式のため読み飛ばしました（HEIC など）`,
        );
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
      const result = await analyzeInWorker(buffer);
      // 古い曲の拍に戻せても意味がないので、音源を替えたら履歴はここから
      resetHistory({ analysis: result });
      setAnalysis(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : '音源を解析できませんでした');
      resetHistory({ analysis: null });
      setAnalysis(null);
    } finally {
      setAnalyzing(false);
    }
  }, [resetHistory]);

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

  // 表示サイズが変わったら、描画解像度を選び直す
  useEffect(() => {
    const frame = stageFrameRef.current;
    if (!frame) return;
    const update = () => {
      const cssWidth = frame.clientWidth || window.innerWidth;
      setPreviewSize((current) => {
        const next = previewSizeFor(cssWidth);
        return next.width === current.width ? current : next;
      });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(frame);
    return () => observer.disconnect();
  }, []);

  const transitionSeconds = analysis
    ? (settings.transitionBeats * 60) / analysis.bpm
    : 0;

  const renderContext = useMemo(
    () => (analysis ? { segments, media: mediaMap, analysis, settings, focus } : null),
    [segments, mediaMap, analysis, settings, focus],
  );

  // 再生中の描画ループ。React の状態更新は毎フレームだと重いので、
  // 描画は ref を見て回し、UI 向けの時刻更新だけ間引く。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !renderContext || !playing) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;

    let handle = 0;

    const loop = () => {
      const audio = audioRef.current;
      if (!audio) return;
      // 別のタブを見ているときは描いても無駄なので、次の機会まで待つ
      if (document.hidden) {
        handle = requestAnimationFrame(loop);
        return;
      }
      const time = audio.currentTime;
      playheadRef.current = time;
      syncVideos(renderContext, time, true, transitionSeconds);
      renderFrame(ctx, time, renderContext);

      // 再生位置は DOM を直接更新して配る（React の再描画を挟まない）
      emitPlayhead(time);

      handle = requestAnimationFrame(loop);
    };

    handle = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(handle);
  }, [renderContext, playing, transitionSeconds]);

  // 停止中は、シークや設定変更のたびに 1 枚だけ描き直す。
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !renderContext || playing) return;
    const ctx = canvas.getContext('2d', { alpha: false });
    if (!ctx) return;
    syncVideos(renderContext, currentTime, false, transitionSeconds);
    renderFrame(ctx, currentTime, renderContext);

    // 動画はシークが終わってから描かないと、前のコマのままになる
    const pending = renderContext.segments[segmentAt(renderContext.segments, currentTime)];
    const item = pending ? renderContext.media.get(pending.mediaId) : undefined;
    if (item?.kind !== 'video') return;
    const video = item.element as HTMLVideoElement;
    const redraw = () => renderFrame(ctx, currentTime, renderContext);
    video.addEventListener('seeked', redraw);
    return () => video.removeEventListener('seeked', redraw);
  }, [renderContext, playing, currentTime, transitionSeconds]);

  const seek = useCallback((time: number) => {
    const audio = audioRef.current;
    if (audio) audio.currentTime = time;
    playheadRef.current = time;
    emitPlayhead(time);
    setCurrentTime(time);
  }, []);

  const patchOverride = useCallback((segmentId: string, patch: SegmentOverride) => {
    setOverrides((current) => ({ ...current, [segmentId]: { ...current[segmentId], ...patch } }));
  }, []);

  /**
   * カットを選ぶ。選択とプレビューの位置は必ずそろえる。
   * 片方だけ動かすと、映っていない別のカットを調整してしまう。
   *
   * カットの先頭はクロスフェードの開始点で、まだ前の写真が
   * 不透明のまま。切り替わりきった位置へ送って、選んだ写真を映す。
   */
  const selectCut = useCallback(
    (segment: Segment) => {
      const settled = segment.start + transitionSeconds;
      const middle = (segment.start + segment.end) / 2;
      setSelectedId(segment.id);
      seek(Math.min(Math.max(settled, segment.start), Math.max(middle, segment.start)));
    },
    [transitionSeconds, seek],
  );

  const selectCutById = useCallback(
    (id: string) => {
      const segment = segments.find((s) => s.id === id);
      if (segment) selectCut(segment);
    },
    [segments, selectCut],
  );

  // 選択は常に「いまプレビューに映っているカット」に合わせる。
  // ルーラーのクリックや再生・停止で位置だけが動いても、選択が取り残されない。
  useEffect(() => {
    if (segments.length === 0) return;
    const follow = (time: number) => {
      const visible = segments[segmentAt(segments, time)];
      if (visible) setSelectedId((current) => (current === visible.id ? current : visible.id));
    };
    if (!playing) {
      follow(currentTime);
      return;
    }
    // 再生中はカットが変わったときだけ React の状態を動かす
    return onPlayhead(follow);
  }, [segments, playing, currentTime]);

  /**
   * 写真をカットに当てはめる。選択はそのカットに留める。
   *
   * 以前は割り当てると次のカットへ自動で進んでいたが、差し替わったカットが
   * 選択から外れて見えなくなり、差し替わったか分からずにもう一度押すと
   * 次のカットにも同じ写真が入ってしまっていた。
   */
  const assignPhoto = useCallback(
    (segmentId: string, mediaId: string) => {
      const target = segments.find((s) => s.id === segmentId);
      if (!target) return;
      const same = target.mediaId === mediaId;
      if (!same) patchOverride(segmentId, { mediaId });
      selectCut(target);
      setAssigned({
        segmentId,
        name: mediaMap.get(mediaId)?.name ?? '',
        same,
        at: Date.now(),
      });
    },
    [patchOverride, segments, selectCut, mediaMap],
  );

  // 差し替えの知らせは少しで消す
  useEffect(() => {
    if (!assigned) return;
    const timer = setTimeout(() => setAssigned(null), 2500);
    return () => clearTimeout(timer);
  }, [assigned]);

  /**
   * カットを掴んで別の位置へ動かす。
   * 現在の並びを配列にしてから差し替えるので、間のカットは順にずれる。
   * 動かした時点で全カットの割り当てが確定する（設定を変えても崩れない）。
   */
  const reorderCut = useCallback(
    (fromIndex: number, toIndex: number) => {
      setSegments((current) => {
        if (
          fromIndex < 0 ||
          toIndex < 0 ||
          fromIndex >= current.length ||
          toIndex >= current.length
        ) {
          return current;
        }
        const order = current.map((s) => s.mediaId);
        const [moved] = order.splice(fromIndex, 1);
        order.splice(toIndex, 0, moved);

        setOverrides((previous) => {
          const next = { ...previous };
          current.forEach((segment, i) => {
            next[segment.id] = { ...next[segment.id], mediaId: order[i] };
          });
          return next;
        });
        return current;
      });
    },
    [],
  );

  /** いまプレビューに映っているカット（＝ドラッグで動かす対象） */
  const visibleSegment = segments.length > 0 ? segments[segmentAt(segments, currentTime)] : null;
  const visiblePhoto = visibleSegment ? mediaMap.get(visibleSegment.mediaId) : undefined;
  const canPan = visibleSegment?.fit === 'cover' && visiblePhoto !== undefined;
  // 見せる位置は写真ごとに持つので、同じ写真の別カットにも効く
  const sharedCuts = visiblePhoto
    ? segments.filter((s) => s.mediaId === visiblePhoto.id).length
    : 0;

  const panRef = useRef<{
    mediaId: string;
    startX: number;
    startY: number;
    origin: PhotoFocus;
    slack: { x: number; y: number };
    moved: boolean;
  } | null>(null);

  const beginPan = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      if (!canPan || !visiblePhoto) return;
      const canvas = e.currentTarget;
      const rect = canvas.getBoundingClientRect();
      // 表示サイズと canvas の実ピクセルの比
      const scale = canvas.width / rect.width;
      panRef.current = {
        mediaId: visiblePhoto.id,
        startX: e.clientX * scale,
        startY: e.clientY * scale,
        origin: focus[visiblePhoto.id] ?? { x: 0, y: 0 },
        slack: coverSlack(visiblePhoto, canvas.width, canvas.height),
        moved: false,
      };
      canvas.setPointerCapture(e.pointerId);
    },
    [canPan, visiblePhoto, focus],
  );

  const movePan = useCallback((e: PointerEvent<HTMLCanvasElement>) => {
    const pan = panRef.current;
    if (!pan) return;
    const canvas = e.currentTarget;
    const scale = canvas.width / canvas.getBoundingClientRect().width;
    const dx = e.clientX * scale - pan.startX;
    const dy = e.clientY * scale - pan.startY;
    if (Math.abs(dx) + Math.abs(dy) > 3) pan.moved = true;

    // 縦横ともはみ出しが無ければ、動かしようがないので何も記録しない
    if (pan.slack.x === 0 && pan.slack.y === 0) return;

    // はみ出し量が 0 の向き（写真と画面の比が同じ）は動かせない
    const nextX = pan.slack.x > 0 ? pan.origin.x + dx / pan.slack.x : pan.origin.x;
    const nextY = pan.slack.y > 0 ? pan.origin.y + dy / pan.slack.y : pan.origin.y;
    setFocus((current) => ({
      ...current,
      [pan.mediaId]: {
        x: Math.min(1, Math.max(-1, nextX)),
        y: Math.min(1, Math.max(-1, nextY)),
      },
    }));
  }, []);

  const endPan = useCallback(
    (e: PointerEvent<HTMLCanvasElement>) => {
      const pan = panRef.current;
      panRef.current = null;
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      // 動かしていなければ、ただのクリックとして再生／一時停止に使う
      if (pan && !pan.moved) togglePlayRef.current?.();
    },
    [],
  );

  /** 保存済みの File から素材を作り直す。 */
  const photosFromFiles = useCallback(
    (files: { id: string; name: string; file: File }[]): Promise<MediaItem[]> =>
      Promise.all(
        files.map((entry) =>
          loadMedia(entry.file).then((item) => {
            if (item) photoFiles.current.set(item.id, entry.file);
            return item;
          }),
        ),
      ).then((list) => list.filter((p): p is MediaItem => p !== null)),
    [],
  );

  const refreshProjects = useCallback(() => {
    if (!isStorageAvailable()) return;
    void listProjects().then(setProjects);
    void estimateUsage().then(setUsage);
  }, []);

  const applyProject = useCallback(
    async (project: StoredProject) => {
      const loaded = await photosFromFiles(project.photos);
      const restoredSettings = normalizeSettings(project.settings);
      // 開いた状態を起点にする（前のプロジェクトへは戻さない）
      resetHistory({
        photos: loaded,
        analysis: project.analysis,
        settings: restoredSettings,
        overrides: project.overrides,
        focus: project.focus,
      });
      setPhotos(loaded);
      setAudioFile(project.audio);
      setAnalysis(project.analysis);
      setSettings(restoredSettings);
      setOverrides(project.overrides);
      setFocus(project.focus);
      setProjectId(project.id);
      setProjectName(project.name);
      setSavedAt(project.updatedAt);
      setSelectedId(null);
      setCurrentTime(0);
    },
    [photosFromFiles, resetHistory],
  );

  const persist = useCallback(async () => {
    if (!isStorageAvailable()) return;
    if (photos.length === 0 && !audioFile) return;

    const id = projectId ?? newProjectId();
    setProjectId(id);
    setSaveStatus('saving');
    try {
      await saveProject({
        id,
        name: projectName.trim() || '無題のプロジェクト',
        updatedAt: Date.now(),
        photos: photos.map((p) => ({
          id: p.id,
          name: p.name,
          file: photoFiles.current.get(p.id)!,
        })),
        audio: audioFile,
        analysis,
        settings,
        overrides,
        focus,
      });
      setSavedAt(Date.now());
      setSaveStatus('saved');
      refreshProjects();
    } catch (cause) {
      setSaveStatus('error');
      const quota = cause instanceof DOMException && cause.name === 'QuotaExceededError';
      setError(
        quota
          ? 'ブラウザの保存容量が足りず、保存できませんでした。写真を減らすか、不要なプロジェクトを削除してください。'
          : cause instanceof Error
            ? `保存できませんでした: ${cause.message}`
            : '保存できませんでした',
      );
    }
  }, [photos, audioFile, analysis, settings, overrides, focus, projectId, projectName, refreshProjects]);

  // 起動時に、前回開いていたプロジェクトを復元する
  useEffect(() => {
    if (!isStorageAvailable()) return;
    refreshProjects();
    void (async () => {
      try {
        const id = await getLastOpenedId();
        if (!id) return;
        const project = await loadProject(id);
        if (!project) return;
        await applyProject(project);
        setRestored(project.name);
      } catch {
        // 復元できなくても、新規状態で使えればよい
      }
    })();
  }, [applyProject, refreshProjects]);

  // 新しく作ったプロジェクトも、素材を入れた時点で保存先を用意して自動保存に乗せる。
  // 以前は一度「保存」を押すまで保存先が無く、自動保存されなかった。
  const hasContent = photos.length > 0 || audioFile !== null;
  useEffect(() => {
    if (projectId || !hasContent || !isStorageAvailable()) return;
    setProjectId(newProjectId());
    // 名前を付けていなければ、一覧で見分けられるよう作った日時を入れる
    setProjectName((current) =>
      current.trim() === '' || current === '無題のプロジェクト'
        ? `無題のプロジェクト（${new Date().toLocaleString('ja-JP', {
            month: 'numeric',
            day: 'numeric',
            hour: '2-digit',
            minute: '2-digit',
          })}）`
        : current,
    );
  }, [projectId, hasContent]);

  // 編集内容が変わったら、少し待ってから自動保存する
  useEffect(() => {
    if (!projectId) return;
    setSaveStatus('idle');
    const timer = setTimeout(() => void persist(), 1500);
    return () => clearTimeout(timer);
  }, [projectId, persist]);

  const startNewProject = useCallback(() => {
    const noPhotos: MediaItem[] = [];
    const noOverrides: Record<string, SegmentOverride> = {};
    const noFocus: Record<string, PhotoFocus> = {};
    resetHistory({ photos: noPhotos, analysis: null, overrides: noOverrides, focus: noFocus });
    setPhotos(noPhotos);
    setAudioFile(null);
    setAnalysis(null);
    setOverrides(noOverrides);
    setFocus(noFocus);
    setSegments([]);
    setSelectedId(null);
    setCurrentTime(0);
    setProjectId(null);
    setProjectName('無題のプロジェクト');
    setSavedAt(null);
    setRestored(null);
    photoFiles.current.clear();
    void setLastOpenedId(null);
  }, [resetHistory]);

  // 再生中の時刻表示は、React を通さず書き換える
  useEffect(() => {
    if (!playing) return;
    let last = '';
    return onPlayhead((time) => {
      const text = formatTime(time);
      if (text !== last && timeReadoutRef.current) {
        last = text;
        timeReadoutRef.current.textContent = text;
      }
    });
  }, [playing]);

  const togglePlay = useCallback(() => {
    const audio = audioRef.current;
    if (!audio) return;
    if (audio.paused) void audio.play();
    else audio.pause();
  }, []);

  togglePlayRef.current = togglePlay;

  // Ctrl/⌘ + Z で元に戻す、Ctrl/⌘ + Shift + Z か Ctrl + Y でやり直す。
  // 文字入力欄では、その欄の文字の取り消しを優先する。
  const { undo, redo } = edits;
  useEffect(() => {
    // 書き出し中は描画中の内容を変えない
    if (exportProgress !== null) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      const target = e.target as HTMLElement | null;
      if (
        target?.isContentEditable ||
        target instanceof HTMLTextAreaElement ||
        (target instanceof HTMLInputElement && (target.type === 'text' || target.type === 'number'))
      ) {
        return;
      }
      const key = e.key.toLowerCase();
      if (key === 'z' && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === 'z' && e.shiftKey) || key === 'y') {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [undo, redo, exportProgress]);

  const handleExport = useCallback(async () => {
    if (!renderContext || !audioFile) return;
    audioRef.current?.pause();
    pauseAllVideos(mediaMap);
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
        onMode: setExportMode,
        signal: controller.signal,
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = 'slideshow.webm';
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10000);
    } catch (cause) {
      if (!(cause instanceof ExportAborted)) {
        setError(cause instanceof Error ? cause.message : '書き出しに失敗しました');
      }
    } finally {
      setExportProgress(null);
      setExportMode(null);
      exportAbort.current = null;
    }
  }, [renderContext, audioFile, quality]);

  const selected = segments.find((s) => s.id === selectedId) ?? null;
  const selectedIndex = selected ? segments.indexOf(selected) : -1;

  /**
   * BPM を直すときに動かさない位置。選んでいるカットの頭を基準にする。
   * 見ている場所が流れず、そこから前後に伸び縮みするので合わせやすい。
   */
  const gridAnchor = (): GridAnchor | null => {
    if (!analysis) return null;
    if (selectedIndex >= 0) {
      const beatsBefore = segments
        .slice(0, selectedIndex)
        .reduce((sum, s) => sum + s.beats, 0);
      return { time: segments[selectedIndex].start, beatsBefore };
    }
    return { time: analysis.downbeats[0] ?? analysis.offset, beatsBefore: 0 };
  };
  // 全体の設定が効かず、個別の手編集が優先されているカットの数
  const overrideCounts = useMemo(() => {
    const counts = { beats: 0, transition: 0, fit: 0, any: 0 };
    for (const segment of segments) {
      const override = overrides[segment.id];
      if (!override) continue;
      counts.any += 1;
      if (override.beats !== undefined) counts.beats += 1;
      if (override.transition !== undefined) counts.transition += 1;
      if (override.fit !== undefined) counts.fit += 1;
    }
    return counts;
  }, [segments, overrides]);
  const shiftBeatGrid = (deltaSeconds: number) => {
    const anchor = gridAnchor();
    if (anchor && analysis) setAnalysis(shiftGrid(analysis, deltaSeconds, anchor));
  };

  // カットの境目ごとの、音の立ち上がりとのずれ
  const drift = useMemo(
    () => (analysis && segments.length > 0 ? measureDrift(analysis, segments.map((s) => s.start)) : null),
    [analysis, segments],
  );
  const syncMarks = useMemo(
    () =>
      (['a', 'b'] as const)
        .filter((key) => syncPoints[key] !== null)
        .map((key) => ({ label: key.toUpperCase(), time: syncPoints[key] as number })),
    [syncPoints],
  );

  // 再生中のクリック音
  useEffect(() => {
    const audio = audioRef.current;
    if (!playing || clickMode === 'off' || !audio || !analysis) return;
    const clicks =
      clickMode === 'beat'
        ? (() => {
            const accents = new Set(analysis.downbeats);
            return analysis.beats.map((time) => ({ time, accent: accents.has(time) }));
          })()
        : segments.map((segment) => ({ time: segment.start, accent: true }));
    return startMetronome(audio, clicks);
  }, [playing, clickMode, analysis, segments]);

  const usedMediaIds = useMemo(
    () => new Set(segments.map((s) => s.mediaId)),
    [segments],
  );
  const ready = analysis !== null && photos.length > 0 && segments.length > 0;

  return (
    <div className="app">
      <header className="app__head">
        <div>
          <h1>Slideshow Maker</h1>
          <p>写真を音楽のビートに合わせて切り替える、ブラウザ完結のスライドショー作成ツール</p>
        </div>
        <div className="app__tools">
          <div className="history" role="group" aria-label="編集の履歴">
            <button
              type="button"
              onClick={undo}
              disabled={!edits.canUndo || exportProgress !== null}
              title="元に戻す（Ctrl / ⌘ + Z）"
            >
              <span aria-hidden="true">↶</span> 元に戻す
            </button>
            <button
              type="button"
              onClick={redo}
              disabled={!edits.canRedo || exportProgress !== null}
              title="やり直す（Ctrl / ⌘ + Shift + Z）"
            >
              <span aria-hidden="true">↷</span> やり直す
            </button>
          </div>
          <a className="app__manual" href="./manual.html" target="_blank" rel="noopener noreferrer">
            使い方マニュアル
            <span aria-hidden="true">↗</span>
          </a>
        </div>
      </header>

      {error && (
        <div className="notice" role="status">
          {error}
          <button type="button" onClick={() => setError(null)} aria-label="閉じる">
            ×
          </button>
        </div>
      )}

      {restored && (
        <div className="notice notice--info" role="status">
          前回のプロジェクト「{restored}」を復元しました。
          <button type="button" onClick={() => setRestored(null)} aria-label="閉じる">
            ×
          </button>
        </div>
      )}

      <div className="app__body">
        <div className="app__side">
          <ProjectPanel
            name={projectName}
            projects={projects}
            currentId={projectId}
            status={saveStatus}
            savedAt={savedAt}
            canSave={photos.length > 0 || audioFile !== null}
            usage={usage}
            onNameChange={setProjectName}
            onSave={() => void persist()}
            onNew={startNewProject}
            onOpen={(id) => {
              void (async () => {
                const project = await loadProject(id);
                if (project) {
                  await applyProject(project);
                  await setLastOpenedId(id);
                  setRestored(null);
                }
              })();
            }}
            onDelete={(id) => {
              void (async () => {
                await deleteProject(id);
                if (id === projectId) startNewProject();
                refreshProjects();
              })();
            }}
          />

          <MediaPool
            photos={photos}
            audioName={audioFile?.name ?? null}
            analyzing={analyzing}
            usedMediaIds={usedMediaIds}
            hasSelection={selectedId !== null}
            currentMediaId={selected?.mediaId ?? null}
            onAssign={(mediaId) => {
              if (selectedId) assignPhoto(selectedId, mediaId);
            }}
            onDropCut={(cutIndex, mediaId) => {
              const target = segments[cutIndex];
              if (target) assignPhoto(target.id, mediaId);
            }}
            onPhotos={addPhotos}
            onAudio={(file) => void loadAudio(file)}
            onRemovePhoto={(id) => {
              setPhotos((current) => current.filter((p) => p.id !== id));
            }}
          />

          <SettingsPanel
            settings={settings}
            cutCount={segments.length}
            overrides={overrideCounts}
            onChange={(patch) => setSettings((current) => ({ ...current, ...patch }))}
            onClearAllOverrides={() => setOverrides({})}
          />
        </div>

        {/* 「このカットだけ」があるときは、PC ではプレビューの右横に置く */}
        <main className={`app__main${ready && selected ? ' app__main--cut' : ''}`}>
          <section className="panel panel--stage">
            <div className="stage__frame" ref={stageFrameRef}>
            <canvas
              ref={canvasRef}
              width={previewSize.width}
              height={previewSize.height}
              className={`stage${canPan ? ' stage--pannable' : ''}`}
              onPointerDown={beginPan}
              onPointerMove={movePan}
              onPointerUp={endPan}
              onPointerCancel={endPan}
              onClick={(e) => {
                // ドラッグできない状態のときは、クリックで再生／一時停止
                if (!canPan) togglePlay();
                else e.preventDefault();
              }}
            />
            </div>
            {!ready && (
              <p className="stage__empty">写真と音源を読み込むとプレビューが始まります</p>
            )}

            {ready && visiblePhoto && (
              <p className="stage__hint">
                {canPan ? (
                  <>
                    プレビューをドラッグすると、この写真のどこを見せるか決められます
                    {sharedCuts > 1 && `（この写真を使う ${sharedCuts} カットすべてに反映）`}
                    {focus[visiblePhoto.id] && (
                      <>
                        {' '}
                        <button
                          type="button"
                          className="linkish"
                          onClick={() =>
                            setFocus((current) => {
                              const next = { ...current };
                              delete next[visiblePhoto.id];
                              return next;
                            })
                          }
                        >
                          位置をリセット
                        </button>
                      </>
                    )}
                  </>
                ) : (
                  '「全体を収める」では写真全体が映るため、位置の調整はありません'
                )}
              </p>
            )}

            <div className="transport">
              <button type="button" onClick={togglePlay} disabled={!ready}>
                {playing ? '一時停止' : '再生'}
              </button>
              <button type="button" onClick={() => seek(0)} disabled={!ready}>
                先頭へ
              </button>
              <span className="muted">
                <span ref={timeReadoutRef}>{formatTime(currentTime)}</span> /{' '}
                {formatTime(analysis?.duration ?? 0)}
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
            </div>
            {exportProgress !== null && exportMode === 'realtime' && (
              <p className="muted">
                このブラウザでは画面を録画して書き出すため、曲の長さぶんの時間がかかります。
                このタブを開いたままにしてください。
              </p>
            )}
            {exportProgress !== null && exportMode === 'offline' && (
              <p className="muted">
                1 コマずつ描いて書き出しています（曲の長さより早く終わることが多いです）。
              </p>
            )}
          </section>

          {ready && selected && (
            <CutPanel
              selected={selected}
              index={selectedIndex}
              count={segments.length}
              onStep={(delta) => {
                const next = segments[selectedIndex + delta];
                if (next) selectCut(next);
              }}
              notice={
                assigned && assigned.segmentId === selected.id
                  ? assigned.same
                    ? { text: `すでに ${assigned.name} です`, undoable: false }
                    : { text: `${assigned.name} に差し替えました`, undoable: true }
                  : null
              }
              media={mediaMap.get(selected.mediaId) ?? null}
              beatSeconds={analysis ? 60 / analysis.bpm : 0.5}
              edited={overrides[selected.id] !== undefined}
              onResize={(delta) =>
                patchOverride(selected.id, { beats: Math.max(1, selected.beats + delta) })
              }
              onTransition={(transition: TransitionKind) =>
                patchOverride(selected.id, { transition })
              }
              onFit={(fit: FitMode) => patchOverride(selected.id, { fit })}
              onVideoStart={(videoStart) => patchOverride(selected.id, { videoStart })}
              onVideoRate={(videoRate) => patchOverride(selected.id, { videoRate })}
              onReset={() =>
                setOverrides((current) => {
                  const next = { ...current };
                  delete next[selected.id];
                  return next;
                })
              }
            />
          )}

          {analysis && (
            <Timeline
              drift={drift}
              marks={syncMarks}
              analysis={analysis}
              segments={segments}
              photos={mediaMap}
              currentTime={currentTime}
              playing={playing}
              selectedId={selectedId}
              onSeek={seek}
              onSelect={selectCutById}
              onDropPhoto={(segmentId, mediaId) => assignPhoto(segmentId, mediaId)}
              flashId={assigned && !assigned.same ? `${assigned.segmentId}:${assigned.at}` : null}
              onReorder={reorderCut}
              anchorIndex={selectedIndex}
              onBpmOverride={(bpm) => {
                const anchor = gridAnchor();
                if (anchor) setAnalysis(rebuildGrid(analysis, bpm, anchor));
              }}
              onGridShift={shiftBeatGrid}
              onSaveBeats={() => {
                const blob = new Blob([analysisToJson(analysis)], { type: 'application/json' });
                const url = URL.createObjectURL(blob);
                const link = document.createElement('a');
                link.href = url;
                link.download = 'beats.json';
                link.click();
                setTimeout(() => URL.revokeObjectURL(url), 10000);
              }}
            >
              <SyncTools
                analysis={analysis}
                drift={drift}
                points={syncPoints}
                onSetPoint={(which) => {
                  const time = audioRef.current?.currentTime ?? currentTime;
                  const { time: snapped } = snapToOnset(analysis, time);
                  setSyncPoints((current) => ({ ...current, [which]: snapped }));
                }}
                onClearPoints={() => setSyncPoints({ a: null, b: null })}
                onApplyTwoPoints={(beatsBetween) => {
                  const { a, b } = syncPoints;
                  if (a === null || b === null) return;
                  setAnalysis(alignToTwoPoints(analysis, a, b, beatsBetween));
                }}
                onSeek={seek}
                onShift={shiftBeatGrid}
                clickMode={clickMode}
                onClickMode={setClickMode}
              />
            </Timeline>
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
