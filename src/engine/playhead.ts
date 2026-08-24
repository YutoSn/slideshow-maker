/**
 * 再生位置の配り先。
 *
 * 再生中に React の状態を毎回更新すると、素材一覧・設定・タイムラインが
 * まとめて作り直され、スマホでは 1 フレームの大半を持っていかれる
 * （実測で 60fps → 8.6fps）。再生中だけはここを通して DOM を直接触り、
 * React の状態は停止・シーク時にだけ更新する。
 */

type Listener = (time: number) => void;

const listeners = new Set<Listener>();

export function onPlayhead(listener: Listener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function emitPlayhead(time: number): void {
  for (const listener of listeners) listener(time);
}
