import { useEffect, useState } from 'react';
import { formatTime } from '../engine/audio';
import { MAX_MANUAL_BPM, MIN_MANUAL_BPM } from '../engine/beatGrid';
import type { BeatAnalysis } from '../engine/beatDetect';
import { twoPointBeats, twoPointBpm, type DriftSummary } from '../engine/onsets';

export type ClickMode = 'off' | 'beat' | 'cut';

export interface SyncPoints {
  a: number | null;
  b: number | null;
}

interface Props {
  analysis: BeatAnalysis;
  drift: DriftSummary | null;
  points: SyncPoints;
  /** いまの再生位置に、近くの音へ吸着させた点を置く */
  onSetPoint: (which: 'a' | 'b') => void;
  onClearPoints: () => void;
  onApplyTwoPoints: (beatsBetween: number) => void;
  onSeek: (time: number) => void;
  /** 格子全体を秒単位でずらす */
  onShift: (deltaSeconds: number) => void;
  clickMode: ClickMode;
  onClickMode: (mode: ClickMode) => void;
}

function ms(seconds: number): string {
  const value = Math.round(seconds * 1000);
  return `${value > 0 ? '+' : ''}${value}ms`;
}

function preciseTime(seconds: number): string {
  const whole = formatTime(seconds);
  const fraction = (seconds % 1).toFixed(2).slice(1);
  return `${whole}${fraction}`;
}

/**
 * 曲と切り替わりを合わせるための道具。
 * - 境目ごとのずれの集計（タイムライン上の色と対応）
 * - 2 点で合わせる：はっきりした音を 2 つ選ぶと、BPM と位置が一度に決まる
 * - クリック音：拍や切り替わりを耳で確かめる
 */
export default function SyncTools({
  analysis,
  drift,
  points,
  onSetPoint,
  onClearPoints,
  onApplyTwoPoints,
  onSeek,
  onShift,
  clickMode,
  onClickMode,
}: Props) {
  const [open, setOpen] = useState(false);
  const [beats, setBeats] = useState<number | null>(null);

  const { a, b } = points;
  const ready = a !== null && b !== null && Math.abs(b - a) >= 1;
  // 点を置き直したら、間の拍数を数え直す（音の立ち上がりに一番よく乗る拍数）。
  // BPM を変えても数え直さない（点を置いた時点の見立てを保つ）
  useEffect(() => {
    setBeats(ready ? twoPointBeats(analysis, a, b) : null);
  }, [a, b, ready]);

  const resultBpm = ready && beats ? twoPointBpm(a, b, beats) : null;
  const inRange = resultBpm !== null && resultBpm >= MIN_MANUAL_BPM && resultBpm <= MAX_MANUAL_BPM;

  // 全体が同じ向きにずれているなら、中央値ぶんずらせば揃う
  const offset = drift?.median ?? null;
  const worthShifting = offset !== null && Math.abs(offset) >= 0.01;

  return (
    <div className="sync">
      <div className="sync__row">
        {drift && drift.boundaries.length > 0 && (
          <div
            className="sync__score"
            title="カットの切り替わりと、近くの音の立ち上がりとのずれ。タイムライン上の境目の色と同じです（緑: 30ms 以内 / 黄: 70ms 以内 / 赤: それ以上 / 灰: 近くに目立つ音が無い）"
          >
            <span className="sync__label">切り替わりの一致</span>
            <b>
              {drift.good} / {drift.measured}
            </b>
            <span className="drift-legend">
              <i className="drift--good" /> {drift.good}
              <i className="drift--fair" />{' '}
              {drift.boundaries.filter((d) => d.level === 'fair').length}
              <i className="drift--bad" />{' '}
              {drift.boundaries.filter((d) => d.level === 'bad').length}
            </span>
            {worthShifting && (
              <span className="muted">
                全体で {ms(offset as number)}
                {(offset as number) > 0 ? '（画が遅い）' : '（画が早い）'}
              </span>
            )}
            {worthShifting && (
              <button
                type="button"
                onClick={() => onShift(-(offset as number))}
                title="全体のずれの中央値ぶん、拍の位置をずらします"
              >
                {ms(-(offset as number))} ずらして揃える
              </button>
            )}
          </div>
        )}

        <div className="sync__spacer" />

        <button
          type="button"
          className={open ? 'sync__toggle sync__toggle--on' : 'sync__toggle'}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          2 点で合わせる
        </button>

        <label className="sync__click">
          <span>クリック音</span>
          <select value={clickMode} onChange={(e) => onClickMode(e.target.value as ClickMode)}>
            <option value="off">なし</option>
            <option value="beat">拍ごと</option>
            <option value="cut">切り替わりごと</option>
          </select>
        </label>
      </div>

      {open && (
        <div className="twopoint">
          <p className="muted">
            曲の中の、はっきりした音（ドラムなど）を 2 か所選ぶと、そこにぴったり拍が来るように
            BPM と位置を一度に決めます。曲の前半と後半など、離れた 2 か所を選ぶほど正確です。
            再生して止めるか、ルーラーをクリックして位置を決めてからボタンを押してください。
            近くの音の立ち上がりに自動で吸着します。
          </p>
          <div className="twopoint__row">
            {(['a', 'b'] as const).map((which) => {
              const value = points[which];
              return (
                <div className="twopoint__point" key={which}>
                  <button type="button" onClick={() => onSetPoint(which)}>
                    {which.toUpperCase()} をここにする
                  </button>
                  {value !== null ? (
                    <button
                      type="button"
                      className="linkish"
                      onClick={() => onSeek(value)}
                      title="この位置へ移動"
                    >
                      {which.toUpperCase()}: {preciseTime(value)}
                    </button>
                  ) : (
                    <span className="muted">{which.toUpperCase()}: 未設定</span>
                  )}
                </div>
              );
            })}
          </div>

          {ready && beats !== null && (
            <div className="twopoint__row">
              <span className="muted">A〜B の間の拍数</span>
              <button type="button" onClick={() => setBeats(Math.max(1, beats - 1))}>
                −
              </button>
              <b className="twopoint__beats">{beats} 拍</b>
              <button type="button" onClick={() => setBeats(beats + 1)}>
                ＋
              </button>
              <span className={inRange ? '' : 'twopoint__warn'}>
                → BPM {resultBpm?.toFixed(2)}
                {!inRange && `（${MIN_MANUAL_BPM}〜${MAX_MANUAL_BPM} の範囲外）`}
              </span>
              <button
                type="button"
                className="primary"
                disabled={!inRange}
                onClick={() => onApplyTwoPoints(beats)}
              >
                この 2 点で合わせる
              </button>
            </div>
          )}
          {a !== null && b !== null && !ready && (
            <p className="twopoint__warn">A と B は 1 秒以上離してください。</p>
          )}
          {(a !== null || b !== null) && (
            <button type="button" className="linkish" onClick={onClearPoints}>
              点を消す
            </button>
          )}
        </div>
      )}
    </div>
  );
}
