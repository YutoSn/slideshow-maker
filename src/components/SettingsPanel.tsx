import ClipTrim from './ClipTrim';
import type {
  BackgroundKind,
  FitMode,
  LookFilter,
  MediaItem,
  ProjectSettings,
  Segment,
  TransitionKind,
} from '../engine/types';

interface Props {
  settings: ProjectSettings;
  selected: Segment | null;
  onChange: (patch: Partial<ProjectSettings>) => void;
  onResizeSelected: (delta: number) => void;
  onTransitionForSelected: (kind: TransitionKind) => void;
  /** 選択中のカットの手編集を取り消し、自動割り当てに戻す */
  onFitForSelected: (fit: FitMode) => void;
  /** 選択中のカットが使っている素材（動画なら開始位置を出す） */
  selectedMedia: MediaItem | null;
  beatSeconds: number;
  onVideoStartForSelected: (videoStart: number) => void;
  onClearOverride: () => void;
  hasOverrides: boolean;
  onClearAllOverrides: () => void;
}

const FIT_LABELS: Record<FitMode, string> = {
  cover: '画面いっぱい（はみ出しは切れる）',
  contain: '全体を収める（余白ができる）',
};

const BACKGROUND_LABELS: Record<BackgroundKind, string> = {
  blur: '写真をぼかして敷く',
  black: '黒',
  white: '白',
  color: '好きな色',
};

const TRANSITION_LABELS: Record<TransitionKind | 'mixed', string> = {
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

const TRANSITION_KINDS: TransitionKind[] = [
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

const FILTER_LABELS: Record<LookFilter, string> = {
  none: 'そのまま',
  mono: 'モノクロ',
  sepia: 'セピア',
  vivid: '鮮やか',
  warm: '暖かめ',
  cool: '涼しめ',
};

export default function SettingsPanel({
  settings,
  selected,
  onChange,
  onResizeSelected,
  onTransitionForSelected,
  onFitForSelected,
  selectedMedia,
  beatSeconds,
  onVideoStartForSelected,
  onClearOverride,
  hasOverrides,
  onClearAllOverrides,
}: Props) {
  return (
    <section className="panel">
      <h2>2. 見せ方を決める</h2>

      <label className="field">
        <span>
          1 枚あたりの拍数<b>{settings.beatsPerPhoto} 拍</b>
        </span>
        <input
          type="range"
          min={1}
          max={16}
          step={1}
          value={settings.beatsPerPhoto}
          onChange={(e) => onChange({ beatsPerPhoto: Number(e.target.value) })}
        />
      </label>

      <label className="field">
        <span>
          トランジションの長さ<b>{settings.transitionBeats} 拍</b>
        </span>
        <input
          type="range"
          min={0}
          max={4}
          step={0.5}
          value={settings.transitionBeats}
          onChange={(e) => onChange({ transitionBeats: Number(e.target.value) })}
        />
      </label>

      <label className="field">
        <span>
          Ken Burns（ゆっくり寄る動き）<b>{Math.round(settings.kenBurns * 100)}%</b>
        </span>
        <input
          type="range"
          min={0}
          max={0.4}
          step={0.01}
          value={settings.kenBurns}
          onChange={(e) => onChange({ kenBurns: Number(e.target.value) })}
        />
      </label>

      <label className="field">
        <span>
          拍に合わせた拡大<b>{Math.round(settings.beatPulse * 100)}%</b>
        </span>
        <input
          type="range"
          min={0}
          max={0.12}
          step={0.005}
          value={settings.beatPulse}
          onChange={(e) => onChange({ beatPulse: Number(e.target.value) })}
        />
      </label>

      <label className="field">
        <span>
          拍で揺らす<b>{Math.round(settings.shake * 100)}%</b>
        </span>
        <input
          type="range"
          min={0}
          max={1}
          step={0.05}
          value={settings.shake}
          onChange={(e) => onChange({ shake: Number(e.target.value) })}
        />
      </label>

      <label className="field">
        <span>
          周辺を暗くする<b>{Math.round(settings.vignette * 100)}%</b>
        </span>
        <input
          type="range"
          min={0}
          max={0.6}
          step={0.02}
          value={settings.vignette}
          onChange={(e) => onChange({ vignette: Number(e.target.value) })}
        />
      </label>

      <label className="field">
        <span>色味</span>
        <select
          value={settings.filter}
          onChange={(e) => onChange({ filter: e.target.value as LookFilter })}
        >
          {(Object.keys(FILTER_LABELS) as LookFilter[]).map((kind) => (
            <option key={kind} value={kind}>
              {FILTER_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>写真の収め方（全体）</span>
        <select
          value={settings.fit}
          onChange={(e) => onChange({ fit: e.target.value as FitMode })}
        >
          {(Object.keys(FIT_LABELS) as FitMode[]).map((mode) => (
            <option key={mode} value={mode}>
              {FIT_LABELS[mode]}
            </option>
          ))}
        </select>
      </label>

      {settings.fit === 'contain' && (
        <>
          <label className="field">
            <span>余白の埋め方</span>
            <select
              value={settings.background}
              onChange={(e) => onChange({ background: e.target.value as BackgroundKind })}
            >
              {(Object.keys(BACKGROUND_LABELS) as BackgroundKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {BACKGROUND_LABELS[kind]}
                </option>
              ))}
            </select>
          </label>

          {settings.background === 'color' && (
            <label className="field field--inline">
              <input
                type="color"
                value={settings.backgroundColor}
                onChange={(e) => onChange({ backgroundColor: e.target.value })}
              />
              <span>余白の色</span>
            </label>
          )}
        </>
      )}

      <label className="field">
        <span>トランジション</span>
        <select
          value={settings.transition}
          onChange={(e) => onChange({ transition: e.target.value as ProjectSettings['transition'] })}
        >
          {Object.entries(TRANSITION_LABELS).map(([value, label]) => (
            <option key={value} value={value}>
              {label}
            </option>
          ))}
        </select>
      </label>

      <label className="field field--inline">
        <input
          type="checkbox"
          checked={settings.shuffle}
          onChange={(e) => onChange({ shuffle: e.target.checked })}
        />
        <span>写真の順番をシャッフルする</span>
      </label>


      <div className="selected">
        <h3>選択中のカット</h3>
        {selected ? (
          <>
            <p className="muted">
              {selected.beats} 拍（{(selected.end - selected.start).toFixed(2)} 秒）
            </p>
            <div className="row">
              <button type="button" onClick={() => onResizeSelected(-1)}>
                − 1 拍
              </button>
              <button type="button" onClick={() => onResizeSelected(1)}>
                + 1 拍
              </button>
            </div>
            <select
              value={selected.transition}
              onChange={(e) => onTransitionForSelected(e.target.value as TransitionKind)}
            >
              {TRANSITION_KINDS.map((kind) => (
                <option key={kind} value={kind}>
                  {TRANSITION_LABELS[kind]}
                </option>
              ))}
            </select>
            <label className="field field--stacked">
              <span>このカットの収め方</span>
              <select
                value={selected.fit}
                onChange={(e) => onFitForSelected(e.target.value as FitMode)}
              >
                {(Object.keys(FIT_LABELS) as FitMode[]).map((mode) => (
                  <option key={mode} value={mode}>
                    {FIT_LABELS[mode]}
                  </option>
                ))}
              </select>
            </label>

            {selectedMedia?.kind === 'video' && (
              <ClipTrim
                segment={selected}
                item={selectedMedia}
                beatSeconds={beatSeconds}
                onChange={onVideoStartForSelected}
              />
            )}

            <div className="row">
              <button type="button" onClick={onClearOverride}>
                このカットを自動に戻す
              </button>
            </div>
          </>
        ) : (
          <p className="muted">タイムラインのカットを選ぶと個別に調整できます</p>
        )}

        {hasOverrides && (
          <div className="row">
            <button type="button" onClick={onClearAllOverrides}>
              手編集をすべて取り消す
            </button>
          </div>
        )}
      </div>
    </section>
  );
}
