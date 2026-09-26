/**
 * audio 要素の再生位置を、滑らかに読むための時計。
 *
 * audio.currentTime はブラウザによって数十 ms 刻みでしか進まない。
 * そのまま使うと動きやクリック音が階段状にずれるので、経過時間で補間し、
 * 大きくずれたとき（シーク・一時停止）だけ再生位置に合わせ直す。
 */
export function createMediaClock(audio: HTMLMediaElement, tolerance = 0.08): () => number {
  let base = { media: audio.currentTime, wall: performance.now() };
  return () => {
    const media = audio.currentTime;
    const now = performance.now();
    const estimated = base.media + ((now - base.wall) / 1000) * (audio.playbackRate || 1);
    if (audio.paused || Math.abs(estimated - media) > tolerance) {
      base = { media, wall: now };
      return media;
    }
    return estimated;
  };
}
