import type { MediaItem, Segment } from '../engine/types';

interface Props {
  segment: Segment;
  item: MediaItem;
  /** 1 拍の長さ（秒）。リズムに合わせて動かすのに使う */
  beatSeconds: number;
  onChange: (videoStart: number) => void;
  onRateChange: (rate: number) => void;
}

function seconds(value: number): string {
  return `${value.toFixed(1)}秒`;
}

/**
 * 動画クリップの、どこを使うかを決める。
 *
 * カットの長さは拍で決まっているので、ここで選ぶのは開始位置だけ。
 * 拍単位で動かせるようにして、リズムに合う場所を探しやすくしている。
 */
const RATES = [0.25, 0.5, 1, 1.5, 2, 4];

export default function ClipTrim({ segment, item, beatSeconds, onChange, onRateChange }: Props) {
  const rate = segment.videoRate;
  const cutLength = segment.end - segment.start;
  // 速度を上げるほど、同じ尺でクリップを長く消費する
  const consumed = cutLength * rate;
  const clipLength = item.duration;
  const start = Math.max(0, Math.min(segment.videoStart, Math.max(0, clipLength - 0.1)));
  // クリップがカットより短いと、頭に戻って繰り返す
  const loops = clipLength > 0.05 && clipLength - start < cutLength * rate;

  const move = (delta: number) => {
    const max = Math.max(0, clipLength - 0.1);
    onChange(Math.min(max, Math.max(0, Number((start + delta).toFixed(2)))));
  };

  const usedPercent = clipLength > 0 ? Math.min(100, (consumed / clipLength) * 100) : 100;
  const startPercent = clipLength > 0 ? Math.min(100, (start / clipLength) * 100) : 0;

  return (
    <div className="trim">
      <span className="trim__title">
        動画のどこを使うか
        <b>
          {seconds(start)} から {seconds(Math.min(clipLength, start + consumed))}
        </b>
      </span>

      {/* クリップ全体のうち、このカットで使う範囲 */}
      <div className="trim__bar" title={`クリップ全体 ${seconds(clipLength)}`}>
        <div
          className="trim__used"
          style={{ left: `${startPercent}%`, width: `${usedPercent}%` }}
        />
      </div>

      <input
        type="range"
        min={0}
        max={Math.max(0.1, clipLength - 0.1)}
        step={0.05}
        value={start}
        aria-label="動画の開始位置"
        onChange={(e) => onChange(Number(e.target.value))}
      />

      <span className="trim__title trim__title--tight">
        再生速度<b>{rate === 1 ? '等速' : `${rate}倍`}</b>
      </span>
      <div className="rates">
        {RATES.map((value) => (
          <button
            type="button"
            key={value}
            className={value === rate ? 'rates__on' : ''}
            onClick={() => onRateChange(value)}
            title={
              value < 1 ? 'ゆっくり再生（スローモーション）' : value > 1 ? '早回し' : '元の速さ'
            }
          >
            {value === 1 ? '等速' : `${value}x`}
          </button>
        ))}
      </div>

      <div className="row row--tight">
        <button type="button" onClick={() => move(-beatSeconds)} title="1 拍ぶん戻す">
          − 1 拍
        </button>
        <button type="button" onClick={() => move(beatSeconds)} title="1 拍ぶん進める">
          + 1 拍
        </button>
        <button type="button" onClick={() => onChange(0)} disabled={start === 0}>
          先頭
        </button>
      </div>

      <p className="muted">
        このカットの長さは {seconds(cutLength)}（{segment.beats} 拍）、
        クリップ全体は {seconds(clipLength)} です。
        {rate !== 1 && ` ${rate} 倍なので ${seconds(consumed)} ぶん使います。`}
        {loops && ' 足りないぶんは頭から繰り返します。'}
      </p>
    </div>
  );
}
