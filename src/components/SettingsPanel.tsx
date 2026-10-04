import { FIT_LABELS, TRANSITION_LABELS } from './labels';
import type {
  AspectRatio,
  BackgroundKind,
  FitMode,
  LookFilter,
  MediaOrder,
  ProjectSettings,
} from '../engine/types';

/** 個別に上書きされているカットの数（全体の設定が効かないカット） */
export interface OverrideCounts {
  beats: number;
  transition: number;
  fit: number;
  /** 何かしら手編集のあるカット */
  any: number;
}

interface Props {
  settings: ProjectSettings;
  /** 全体の設定が効くカットの総数 */
  cutCount: number;
  overrides: OverrideCounts;
  onChange: (patch: Partial<ProjectSettings>) => void;
  onClearAllOverrides: () => void;
}

/** 全体の設定のうち、個別の手編集が優先されているカットがあることを示す */
function Overridden({ count }: { count: number }) {
  if (count === 0) return null;
  return <em className="overridden">{count} カットは個別設定が優先</em>;
}

const ASPECT_LABELS: Record<AspectRatio, string> = {
  landscape: '横長 16:9（PC・テレビ・YouTube）',
  portrait: '縦長 9:16（スマホ・ショート・ストーリーズ）',
};

const ORDER_LABELS: Record<MediaOrder, string> = {
  added: '入れた順',
  taken: '撮影日時順（古い順）',
  shuffle: 'シャッフル',
};

const BACKGROUND_LABELS: Record<BackgroundKind, string> = {
  blur: '写真をぼかして敷く',
  black: '黒',
  white: '白',
  color: '好きな色',
};

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
  cutCount,
  overrides,
  onChange,
  onClearAllOverrides,
}: Props) {
  return (
    <section className="panel panel--global">
      <div className="global__head">
        <h2>2. 全体の見せ方</h2>
        <span className="global__scope">
          {cutCount > 0 ? `全 ${cutCount} カット共通` : 'すべてのカット共通'}
        </span>
      </div>
      <p className="global__note">
        ここは全カットに効きます。1 カットだけ変えるときは、タイムラインでカットを選んで
        プレビューの横（スマホでは下）の「このカットだけ」で調整します。
      </p>

      <label className="field">
        <span>画面の向き</span>
        <select
          value={settings.aspect}
          onChange={(e) => onChange({ aspect: e.target.value as AspectRatio })}
        >
          {(Object.keys(ASPECT_LABELS) as AspectRatio[]).map((aspect) => (
            <option key={aspect} value={aspect}>
              {ASPECT_LABELS[aspect]}
            </option>
          ))}
        </select>
      </label>

      <label className="field">
        <span>
          1 枚あたりの拍数<b>{settings.beatsPerPhoto} 拍</b>
        </span>
        <Overridden count={overrides.beats} />
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
        <Overridden count={overrides.fit} />
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
        <Overridden count={overrides.transition} />
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

      <label className="field">
        <span>素材の並び順</span>
        <select
          value={settings.order}
          onChange={(e) => onChange({ order: e.target.value as MediaOrder })}
        >
          {(Object.keys(ORDER_LABELS) as MediaOrder[]).map((order) => (
            <option key={order} value={order}>
              {ORDER_LABELS[order]}
            </option>
          ))}
        </select>
      </label>

      {overrides.any > 0 && (
        <div className="row">
          <button type="button" onClick={onClearAllOverrides}>
            手編集をすべて取り消す（{overrides.any} カット）
          </button>
        </div>
      )}
    </section>
  );
}
