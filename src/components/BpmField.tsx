import { useEffect, useRef, useState } from 'react';

interface Props {
  bpm: number;
  onChange: (bpm: number) => void;
}

const MIN_BPM = 40;
const MAX_BPM = 220;

function clamp(value: number): number {
  return Math.min(MAX_BPM, Math.max(MIN_BPM, value));
}

/**
 * BPM の手直し。
 *
 * 入力中の値をそのまま確定させると、「120」と打とうとした時点の「1」が
 * 範囲外として弾かれ、整数部分を打ち替えられない。
 * 入力中は文字列のまま保持し、確定（Enter / フォーカスを外す）で反映する。
 */
export default function BpmField({ bpm, onChange }: Props) {
  const [draft, setDraft] = useState(() => bpm.toFixed(1));
  const editing = useRef(false);

  // 編集していない間は、外側の値（自動検出やボタン操作）に追従する
  useEffect(() => {
    if (!editing.current) setDraft(bpm.toFixed(1));
  }, [bpm]);

  const commit = () => {
    const parsed = Number.parseFloat(draft);
    if (Number.isFinite(parsed)) {
      const next = clamp(parsed);
      onChange(next);
      setDraft(next.toFixed(1));
    } else {
      setDraft(bpm.toFixed(1));
    }
  };

  const step = (delta: number) => {
    editing.current = false;
    const next = clamp(Number((bpm + delta).toFixed(1)));
    onChange(next);
    setDraft(next.toFixed(1));
  };

  return (
    <div className="field">
      <span>
        BPM を手で直す<b>{bpm.toFixed(1)}</b>
      </span>
      <div className="bpm">
        <button type="button" onClick={() => step(-1)} aria-label="BPM を 1 下げる">
          −1
        </button>
        <button type="button" onClick={() => step(-0.1)} aria-label="BPM を 0.1 下げる">
          −.1
        </button>
        <input
          type="text"
          inputMode="decimal"
          value={draft}
          aria-label="BPM"
          onFocus={(e) => {
            editing.current = true;
            e.currentTarget.select();
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            editing.current = false;
            commit();
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.currentTarget.blur();
            } else if (e.key === 'Escape') {
              setDraft(bpm.toFixed(1));
              e.currentTarget.blur();
            }
          }}
        />
        <button type="button" onClick={() => step(0.1)} aria-label="BPM を 0.1 上げる">
          +.1
        </button>
        <button type="button" onClick={() => step(1)} aria-label="BPM を 1 上げる">
          +1
        </button>
      </div>
      <div className="row row--tight">
        <button type="button" onClick={() => step(bpm)} disabled={bpm * 2 > MAX_BPM}>
          2 倍（{clamp(bpm * 2).toFixed(0)}）
        </button>
        <button type="button" onClick={() => step(-bpm / 2)} disabled={bpm / 2 < MIN_BPM}>
          半分（{clamp(bpm / 2).toFixed(0)}）
        </button>
      </div>
    </div>
  );
}
