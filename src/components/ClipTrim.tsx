import type { MediaItem, Segment } from '../engine/types';

interface Props {
  segment: Segment;
  item: MediaItem;
  /** 1 拍の長さ（秒）。リズムに合わせて動かすのに使う */
  beatSeconds: number;
  onChange: (videoStart: number) => void;
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
export default function ClipTrim({ segment, item, beatSeconds, onChange }: Props) {
  const cutLength = segment.end - segment.start;
  const clipLength = item.duration;
  const start = Math.max(0, Math.min(segment.videoStart, Math.max(0, clipLength - 0.1)));
  // クリップがカットより短いと、頭に戻って繰り返す
  const loops = clipLength > 0.05 && clipLength - start < cutLength;

  const move = (delta: number) => {
    const max = Math.max(0, clipLength - 0.1);
    onChange(Math.min(max, Math.max(0, Number((start + delta).toFixed(2)))));
  };

  const usedPercent = clipLength > 0 ? Math.min(100, (cutLength / clipLength) * 100) : 100;
  const startPercent = clipLength > 0 ? Math.min(100, (start / clipLength) * 100) : 0;

  return (
    <div className="trim">
      <span className="trim__title">
        動画のどこを使うか
        <b>{seconds(start)} から {seconds(Math.min(clipLength, start + cutLength))}</b>
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
        {loops && ' 足りないぶんは頭から繰り返します。'}
      </p>
    </div>
  );
}
