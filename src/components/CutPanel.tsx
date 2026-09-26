import ClipTrim from './ClipTrim';
import { FIT_LABELS, TRANSITION_KINDS, TRANSITION_LABELS } from './labels';
import type { FitMode, MediaItem, Segment, TransitionKind } from '../engine/types';

interface Props {
  selected: Segment;
  /** 選択中のカットの番号（0 始まり） */
  index: number;
  /** カットの総数 */
  count: number;
  /** 前後のカットへ選択を動かす（-1 / +1） */
  onStep: (delta: number) => void;
  /** 素材を差し替えた直後の知らせ（undoable: 元に戻せる変更があったか） */
  notice: { text: string; undoable: boolean } | null;
  /** 選択中のカットが使っている素材（動画なら開始位置を出す） */
  media: MediaItem | null;
  beatSeconds: number;
  /** このカットに手編集があるか */
  edited: boolean;
  onResize: (delta: number) => void;
  onTransition: (kind: TransitionKind) => void;
  onFit: (fit: FitMode) => void;
  onVideoStart: (videoStart: number) => void;
  onVideoRate: (rate: number) => void;
  /** このカットの手編集を取り消し、自動割り当てに戻す */
  onReset: () => void;
}

/**
 * 選択中のカットだけに効く調整。
 *
 * 全体の設定と同じ見た目・同じ場所にあると取り違えやすいので、
 * プレビューの横（スマホでは下）に置き、色も変えて別物に見せる。
 */
export default function CutPanel({
  selected,
  index,
  count,
  onStep,
  notice,
  media,
  beatSeconds,
  edited,
  onResize,
  onTransition,
  onFit,
  onVideoStart,
  onVideoRate,
  onReset,
}: Props) {
  return (
    <section className="panel panel--cut" aria-label={`カット ${index + 1} の個別設定`}>
      <div className="cut__head">
        {media && <img className="cut__thumb" src={media.thumbnail} alt="" />}
        <div className="cut__title">
          <span className="cut__scope">このカットだけ</span>
          <h2>
            <span className="stage__badge">カット {index + 1}</span>
            <span className="cut__name">{media?.name ?? '(素材なし)'}</span>
          </h2>
        </div>
        <div className="cut__nav">
          <button
            type="button"
            onClick={() => onStep(-1)}
            disabled={index <= 0}
            aria-label="前のカットを選ぶ"
          >
            ◀ 前
          </button>
          <button
            type="button"
            onClick={() => onStep(1)}
            disabled={index >= count - 1}
            aria-label="次のカットを選ぶ"
          >
            次 ▶
          </button>
        </div>
        <button type="button" className="cut__reset" onClick={onReset} disabled={!edited}>
          このカットを自動に戻す
        </button>
      </div>

      {/* 素材プールで写真を押したとき、差し替わったことをその場で示す */}
      <p className="cut__notice" role="status" aria-live="polite">
        {notice && (
          <span key={notice.text}>
            ✓ {notice.text}
            {notice.undoable && '（元に戻す: Ctrl / ⌘ + Z）'}
          </span>
        )}
      </p>

      <div className="cut__controls">
        <div className="cut__field">
          <span>
            長さ<b>{selected.beats} 拍（{(selected.end - selected.start).toFixed(2)} 秒）</b>
          </span>
          <div className="cut__buttons">
            <button type="button" onClick={() => onResize(-1)} disabled={selected.beats <= 1}>
              − 1 拍
            </button>
            <button type="button" onClick={() => onResize(1)}>
              + 1 拍
            </button>
          </div>
        </div>

        <label className="cut__field">
          <span>入りのトランジション</span>
          <select
            value={selected.transition}
            onChange={(e) => onTransition(e.target.value as TransitionKind)}
          >
            {TRANSITION_KINDS.map((kind) => (
              <option key={kind} value={kind}>
                {TRANSITION_LABELS[kind]}
              </option>
            ))}
          </select>
        </label>

        <label className="cut__field">
          <span>収め方</span>
          <select value={selected.fit} onChange={(e) => onFit(e.target.value as FitMode)}>
            {(Object.keys(FIT_LABELS) as FitMode[]).map((mode) => (
              <option key={mode} value={mode}>
                {FIT_LABELS[mode]}
              </option>
            ))}
          </select>
        </label>
      </div>

      {media?.kind === 'video' && (
        <ClipTrim
          segment={selected}
          item={media}
          beatSeconds={beatSeconds}
          onChange={onVideoStart}
          onRateChange={onVideoRate}
        />
      )}
    </section>
  );
}
