export type MediaKind = 'photo' | 'video';

export interface MediaItem {
  id: string;
  name: string;
  url: string;
  kind: MediaKind;
  /** canvas に描ける実体。写真なら img、動画なら video */
  element: HTMLImageElement | HTMLVideoElement;
  width: number;
  height: number;
  /** 動画の長さ（秒）。写真は 0 */
  duration: number;
  /** 一覧に出すサムネイル。動画は先頭付近のコマから作る */
  thumbnail: string;
}

export function isVideo(item: MediaItem): item is MediaItem & { element: HTMLVideoElement } {
  return item.kind === 'video';
}

export type TransitionKind =
  | 'crossfade'
  | 'slide'
  | 'slideUp'
  | 'zoom'
  | 'whip'
  | 'dipBlack'
  | 'wipe'
  | 'circle'
  | 'spin'
  | 'blur';

/** 全体にかける色味。canvas の filter で処理するので負荷は軽い。 */
export type LookFilter = 'none' | 'mono' | 'sepia' | 'vivid' | 'warm' | 'cool';

/**
 * 写真を画面にどう収めるか。
 * cover: 画面を埋める（はみ出した部分は切れる）
 * contain: 写真全体を収める（縦横比が違うと余白ができる）
 */
export type FitMode = 'cover' | 'contain';

/** contain で余白ができたときの、背景の埋め方。 */
export type BackgroundKind = 'black' | 'white' | 'blur' | 'color';

export interface Segment {
  id: string;
  mediaId: string;
  /** 開始時刻（秒）— ビート格子にスナップ済み */
  start: number;
  /** 終了時刻（秒）— ビート格子にスナップ済み */
  end: number;
  /** この区間が占める拍数 */
  beats: number;
  transition: TransitionKind;
  /** 画面への収め方 */
  fit: FitMode;
  /** 動画のとき、クリップのどこから使うか（秒） */
  videoStart: number;
  /** Ken Burns の演出をセグメントごとに固定するための種 */
  seed: number;
}

export interface ProjectSettings {
  /** 1 枚あたりの拍数 */
  beatsPerPhoto: number;
  /** トランジションの長さ（拍） */
  transitionBeats: number;
  /** ビートに合わせた拡大の強さ（0 で無効） */
  beatPulse: number;
  /** Ken Burns の強さ（0 で静止） */
  kenBurns: number;
  /** 拍に合わせた揺れの強さ（0 で無効） */
  shake: number;
  /** 画面の四隅を落とす強さ（0 で無効） */
  vignette: number;
  /** 全体の色味 */
  filter: LookFilter;
  transition: TransitionKind | 'mixed';
  /** 全体の既定の収め方。カットごとに上書きできる */
  fit: FitMode;
  /** contain のときの背景 */
  background: BackgroundKind;
  /** background が 'color' のときに使う色 */
  backgroundColor: string;
  /** 写真を並べ替えずに元の順で使うか */
  shuffle: boolean;
}

export const DEFAULT_SETTINGS: ProjectSettings = {
  beatsPerPhoto: 8,
  transitionBeats: 1,
  beatPulse: 0.035,
  kenBurns: 0.12,
  shake: 0,
  vignette: 0.18,
  filter: 'none',
  transition: 'mixed',
  fit: 'cover',
  background: 'blur',
  backgroundColor: '#101018',
  shuffle: false,
};

/**
 * カットごとの手編集。ビート格子から組み直しても消えないよう、
 * 生成されたセグメントとは別に持つ。
 */
/**
 * 保存されたプロジェクトの設定を、いまの版で安全に使える形にする。
 *
 * 古い版で保存したものには、あとから足した項目が無い。そのまま渡すと
 * undefined が描画まで届いて落ちるので、既定値に重ねて欠けを埋め、
 * 数値は有限かどうかも確かめる。
 */
export function normalizeSettings(stored: Partial<ProjectSettings> | null | undefined): ProjectSettings {
  const merged = { ...DEFAULT_SETTINGS, ...(stored ?? {}) };
  const number = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isFinite(value) ? value : fallback;

  return {
    ...merged,
    beatsPerPhoto: number(merged.beatsPerPhoto, DEFAULT_SETTINGS.beatsPerPhoto),
    transitionBeats: number(merged.transitionBeats, DEFAULT_SETTINGS.transitionBeats),
    beatPulse: number(merged.beatPulse, DEFAULT_SETTINGS.beatPulse),
    kenBurns: number(merged.kenBurns, DEFAULT_SETTINGS.kenBurns),
    shake: number(merged.shake, DEFAULT_SETTINGS.shake),
    vignette: number(merged.vignette, DEFAULT_SETTINGS.vignette),
    filter: merged.filter ?? DEFAULT_SETTINGS.filter,
    fit: merged.fit ?? DEFAULT_SETTINGS.fit,
    background: merged.background ?? DEFAULT_SETTINGS.background,
    backgroundColor: merged.backgroundColor ?? DEFAULT_SETTINGS.backgroundColor,
    transition: merged.transition ?? DEFAULT_SETTINGS.transition,
    shuffle: Boolean(merged.shuffle),
  };
}

export interface SegmentOverride {
  /** 割り当てた写真（プールから当てはめたもの） */
  mediaId?: string;
  transition?: TransitionKind;
  /** 尺（拍数） */
  beats?: number;
  /** このカットだけの収め方 */
  fit?: FitMode;
  /** 動画のとき、クリップのどこから使うか（秒） */
  videoStart?: number;
}
