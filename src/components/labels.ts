import type { FitMode, TransitionKind } from '../engine/types';

/** 全体の設定と個別の設定で同じ言い回しを使うため、表示名はここにまとめる。 */

export const FIT_LABELS: Record<FitMode, string> = {
  cover: '画面いっぱい（はみ出しは切れる）',
  contain: '全体を収める（余白ができる）',
};

export const TRANSITION_LABELS: Record<TransitionKind | 'mixed', string> = {
  mixed: 'おまかせ（混在）',
  crossfade: 'クロスフェード',
  slide: 'スライド（横）',
  slideUp: 'スライド（縦）',
  zoom: 'ズーム',
  whip: 'フラッシュ（白）',
  dipBlack: '暗転',
  wipe: 'ワイプ',
  circle: 'サークル',
  spin: 'スピン',
  blur: 'ブラー',
};

export const TRANSITION_KINDS: TransitionKind[] = [
  'crossfade',
  'slide',
  'slideUp',
  'zoom',
  'whip',
  'dipBlack',
  'wipe',
  'circle',
  'spin',
  'blur',
];
