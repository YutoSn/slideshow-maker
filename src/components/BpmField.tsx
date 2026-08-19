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
 * BPM の手直し。タイムラインの操作列に置くので、1 行に収まる形にしている。
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

  const set = (value: number) => {
    editing.current = false;
    const next = clamp(Number(value.toFixed(1)));
    onChange(next);
    setDraft(next.toFixed(1));
  };

  return (
    <div className="bpm" title="曲のテンポ。切り替わりがズレるときはここで直します">
      <span className="bpm__label">BPM</span>
      <button type="button" onClick={() => set(bpm - 1)} aria-label="BPM を 1 下げる">
        −1
      </button>
      <button type="button" onClick={() => set(bpm - 0.1)} aria-label="BPM を 0.1 下げる">
        −
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
      <button type="button" onClick={() => set(bpm + 0.1)} aria-label="BPM を 0.1 上げる">
        ＋
      </button>
      <button type="button" onClick={() => set(bpm + 1)} aria-label="BPM を 1 上げる">
        +1
      </button>
      <button
        type="button"
        onClick={() => set(bpm * 2)}
        disabled={bpm * 2 > MAX_BPM}
        title="推定が半分になっているとき"
      >
        ×2
      </button>
      <button
        type="button"
        onClick={() => set(bpm / 2)}
        disabled={bpm / 2 < MIN_BPM}
        title="推定が倍になっているとき"
      >
        ÷2
      </button>
    </div>
  );
}
