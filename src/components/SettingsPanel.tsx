import type { BeatAnalysis } from '../engine/beatDetect';
import type { ProjectSettings, Segment, TransitionKind } from '../engine/types';

interface Props {
  settings: ProjectSettings;
  analysis: BeatAnalysis | null;
  selected: Segment | null;
  onChange: (patch: Partial<ProjectSettings>) => void;
  onBpmOverride: (bpm: number) => void;
  onResizeSelected: (delta: number) => void;
  onTransitionForSelected: (kind: TransitionKind) => void;
  /** 選択中のカットの手編集を取り消し、自動割り当てに戻す */
  onClearOverride: () => void;
  hasOverrides: boolean;
  onClearAllOverrides: () => void;
}

const TRANSITION_LABELS: Record<TransitionKind | 'mixed', string> = {
  mixed: 'おまかせ（混在）',
  crossfade: 'クロスフェード',
  slide: 'スライド',
  zoom: 'ズーム',
  whip: 'フラッシュ',
};

export default function SettingsPanel({
  settings,
  analysis,
  selected,
  onChange,
  onBpmOverride,
  onResizeSelected,
  onTransitionForSelected,
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

      {analysis && (
        <label className="field">
          <span>
            BPM を手で直す<b>{analysis.bpm.toFixed(1)}</b>
          </span>
          <input
            type="number"
            min={40}
            max={220}
            step={0.1}
            value={Number(analysis.bpm.toFixed(1))}
            onChange={(e) => {
              const value = Number(e.target.value);
              if (value >= 40 && value <= 220) onBpmOverride(value);
            }}
          />
        </label>
      )}

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
              {(['crossfade', 'slide', 'zoom', 'whip'] as TransitionKind[]).map((kind) => (
                <option key={kind} value={kind}>
                  {TRANSITION_LABELS[kind]}
                </option>
              ))}
            </select>
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
