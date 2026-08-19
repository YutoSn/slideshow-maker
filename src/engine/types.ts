export interface Photo {
  id: string;
  name: string;
  url: string;
  image: HTMLImageElement;
  width: number;
  height: number;
}

export type TransitionKind = 'crossfade' | 'slide' | 'zoom' | 'whip';

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
  photoId: string;
  /** 開始時刻（秒）— ビート格子にスナップ済み */
  start: number;
  /** 終了時刻（秒）— ビート格子にスナップ済み */
  end: number;
  /** この区間が占める拍数 */
  beats: number;
  transition: TransitionKind;
  /** 画面への収め方 */
  fit: FitMode;
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
export interface SegmentOverride {
  /** 割り当てた写真（プールから当てはめたもの） */
  photoId?: string;
  transition?: TransitionKind;
  /** 尺（拍数） */
  beats?: number;
  /** このカットだけの収め方 */
  fit?: FitMode;
}
