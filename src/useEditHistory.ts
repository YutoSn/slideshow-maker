import { useCallback, useEffect, useRef, useState } from 'react';

/** 残しておく履歴の数。スナップショットは参照を持つだけなので軽い */
const LIMIT = 100;
/** 同じ操作（同じ押下）のあいだ、この間隔より短い変更は 1 回ぶんにまとめる（ms） */
const MERGE_WINDOW_MS = 1000;

type Snapshot = Record<string, unknown>;

function same(a: Snapshot, b: Snapshot): boolean {
  for (const key of Object.keys(a)) {
    if (a[key] !== b[key]) return false;
  }
  return true;
}

/**
 * 編集内容の「元に戻す / やり直す」。
 *
 * 編集の状態は React の state のまま持ち、変わるたびに直前の値を積む。
 * どの操作で変わったかを個別に書かなくても、すべての編集が対象になる。
 *
 * スライダーのドラッグやプレビューのパンは 1 フレームごとに値が変わるので、
 * 「同じ押下（pointerdown / keydown）のあいだの変更」は 1 回ぶんにまとめる。
 * 別のボタンを続けて押したときは、別々に戻せる。
 */
export function useEditHistory<T extends Snapshot>(current: T, apply: (snapshot: T) => void) {
  const past = useRef<T[]>([]);
  const future = useRef<T[]>([]);
  const last = useRef(current);
  // 直前の変更がどの押下で起きたか。-1 はまとめない（元に戻した直後など）
  const lastChange = useRef({ press: -1, at: 0 });
  const press = useRef(0);
  const applyRef = useRef(apply);
  applyRef.current = apply;
  // ボタンの有効・無効を切り替えるためだけの再描画用
  const [, setVersion] = useState(0);
  const bump = () => setVersion((v) => v + 1);

  useEffect(() => {
    const onPress = (e: Event) => {
      if (e instanceof KeyboardEvent && e.repeat) return;
      press.current += 1;
    };
    window.addEventListener('pointerdown', onPress, true);
    window.addEventListener('keydown', onPress, true);
    return () => {
      window.removeEventListener('pointerdown', onPress, true);
      window.removeEventListener('keydown', onPress, true);
    };
  }, []);

  // 描画のたびに、編集の状態が変わったかを見る（参照の比較だけなので軽い）
  useEffect(() => {
    if (same(current, last.current)) return;
    const now = performance.now();
    const merge =
      lastChange.current.press === press.current && now - lastChange.current.at < MERGE_WINDOW_MS;
    if (!merge) {
      past.current.push(last.current);
      if (past.current.length > LIMIT) past.current.shift();
      future.current = [];
      bump();
    }
    lastChange.current = { press: press.current, at: now };
    last.current = current;
  });

  const undo = useCallback(() => {
    const target = past.current.pop();
    if (!target) return;
    future.current.push(last.current);
    last.current = target;
    lastChange.current = { press: -1, at: 0 };
    applyRef.current(target);
    bump();
  }, []);

  const redo = useCallback(() => {
    const target = future.current.pop();
    if (!target) return;
    past.current.push(last.current);
    last.current = target;
    lastChange.current = { press: -1, at: 0 };
    applyRef.current(target);
    bump();
  }, []);

  /**
   * 履歴を捨てて、ここを起点にする（プロジェクトを開いた・音源を替えたなど）。
   * 渡した値はこのあと state に入る値。入る前に起点にしておくと、
   * それ自体が 1 回の編集として積まれない。
   */
  const reset = useCallback((baseline: Partial<T>) => {
    past.current = [];
    future.current = [];
    last.current = { ...last.current, ...baseline };
    lastChange.current = { press: -1, at: 0 };
    bump();
  }, []);

  return {
    undo,
    redo,
    reset,
    canUndo: past.current.length > 0,
    canRedo: future.current.length > 0,
  };
}
