import type { BeatAnalysis } from './beatDetect';
import { seededRandom } from './segments';
import type { FitMode, Photo, ProjectSettings, Segment } from './types';

export interface RenderContext {
  segments: Segment[];
  photos: Map<string, Photo>;
  analysis: BeatAnalysis;
  settings: ProjectSettings;
}

interface KenBurns {
  fromScale: number;
  toScale: number;
  fromX: number;
  toX: number;
  fromY: number;
  toY: number;
}

const kenBurnsCache = new Map<number, KenBurns>();

/** セグメントの種から Ken Burns の始点・終点を決める（毎フレーム同じ値になる）。 */
function kenBurnsFor(seed: number, strength: number): KenBurns {
  const cached = kenBurnsCache.get(seed);
  if (cached) return scaleKenBurns(cached, strength);

  const random = seededRandom(seed);
  const zoomIn = random() > 0.5;
  const drift = 0.5;
  const base: KenBurns = {
    fromScale: zoomIn ? 1 : 1 + drift,
    toScale: zoomIn ? 1 + drift : 1,
    fromX: (random() - 0.5) * 2,
    toX: (random() - 0.5) * 2,
    fromY: (random() - 0.5) * 2,
    toY: (random() - 0.5) * 2,
  };
  kenBurnsCache.set(seed, base);
  return scaleKenBurns(base, strength);
}

function scaleKenBurns(base: KenBurns, strength: number): KenBurns {
  return {
    fromScale: 1 + (base.fromScale - 1) * strength,
    toScale: 1 + (base.toScale - 1) * strength,
    fromX: base.fromX * strength,
    toX: base.toX * strength,
    fromY: base.fromY * strength,
    toY: base.toY * strength,
  };
}

function easeInOut(t: number): number {
  return t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
}

/** 直近のビートからの経過に応じた、拍に合わせた微妙な拡大量。 */
function beatPulse(time: number, analysis: BeatAnalysis, amount: number): number {
  if (amount <= 0 || analysis.beats.length === 0) return 1;
  const period = 60 / analysis.bpm;
  const since = (time - analysis.offset) % period;
  if (since < 0) return 1;
  const decay = Math.exp(-since * 9);
  return 1 + amount * decay;
}

/**
 * 画面いっぱいに写真を敷き、拡大・平行移動を適用して 1 枚描く。
 * alpha が 1 未満なら重ね合わせに使われる。
 */
function drawPhoto(
  ctx: CanvasRenderingContext2D,
  photo: Photo,
  width: number,
  height: number,
  scale: number,
  offsetX: number,
  offsetY: number,
  alpha: number,
  fit: FitMode,
): void {
  if (alpha <= 0.001) return;

  // cover は画面を覆い、contain は全体を収める。どちらも縦横比は保つ
  const base =
    fit === 'contain'
      ? Math.min(width / photo.width, height / photo.height)
      : Math.max(width / photo.width, height / photo.height);
  const drawn = base * scale;
  const drawWidth = photo.width * drawn;
  const drawHeight = photo.height * drawn;
  const slackX = Math.max(0, drawWidth - width) / 2;
  const slackY = Math.max(0, drawHeight - height) / 2;
  const x = (width - drawWidth) / 2 + offsetX * slackX;
  const y = (height - drawHeight) / 2 + offsetY * slackY;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.drawImage(photo.image, x, y, drawWidth, drawHeight);
  ctx.restore();
}

/**
 * contain で余白ができたときの背景を描く。
 * 'blur' は同じ写真を画面いっぱいに引き伸ばしてぼかしたもので、
 * 余白が写真の続きのように見える。
 */
function drawBackground(
  ctx: CanvasRenderingContext2D,
  photo: Photo | undefined,
  width: number,
  height: number,
  settings: ProjectSettings,
  alpha: number,
): void {
  if (alpha <= 0.001) return;

  if (settings.background === 'blur') {
    if (!photo) return;
    const cover = Math.max(width / photo.width, height / photo.height) * 1.12;
    const drawWidth = photo.width * cover;
    const drawHeight = photo.height * cover;
    ctx.save();
    ctx.globalAlpha = alpha;
    // ぼかすと縁が薄くなるので、少し大きめに描いてから外側を隠す
    ctx.filter = `blur(${Math.round(Math.min(width, height) / 26)}px)`;
    ctx.drawImage(
      photo.image,
      (width - drawWidth) / 2,
      (height - drawHeight) / 2,
      drawWidth,
      drawHeight,
    );
    ctx.filter = 'none';
    // 少し暗く落として、手前の写真との境目を出す
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.fillRect(0, 0, width, height);
    ctx.restore();
    return;
  }

  const color =
    settings.background === 'white'
      ? '#ffffff'
      : settings.background === 'color'
        ? settings.backgroundColor
        : '#000000';
  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.fillRect(0, 0, width, height);
  ctx.restore();
}

export function segmentAt(segments: Segment[], time: number): number {
  for (let i = 0; i < segments.length; i++) {
    if (time >= segments[i].start && time < segments[i].end) return i;
  }
  return time >= (segments.at(-1)?.end ?? 0) ? segments.length - 1 : 0;
}

/** 指定時刻のフレームを canvas に描画する。 */
export function renderFrame(
  ctx: CanvasRenderingContext2D,
  time: number,
  render: RenderContext,
): void {
  const { segments, photos, analysis, settings } = render;
  const width = ctx.canvas.width;
  const height = ctx.canvas.height;

  ctx.fillStyle = '#07070b';
  ctx.fillRect(0, 0, width, height);
  if (segments.length === 0) return;

  const index = segmentAt(segments, time);
  const segment = segments[index];
  const photo = photos.get(segment.photoId);
  if (!photo) return;

  const pulse = beatPulse(time, analysis, settings.beatPulse);
  const transitionSeconds = (settings.transitionBeats * 60) / analysis.bpm;

  const draw = (target: Segment, at: number, alpha: number, shift = 0, extraScale = 1) => {
    const source = photos.get(target.photoId);
    if (!source) return;
    const span = Math.max(0.001, target.end - target.start);
    const progress = Math.min(1, Math.max(0, (at - target.start) / span));
    const eased = easeInOut(progress);
    const kb = kenBurnsFor(target.seed, settings.kenBurns);
    const grow = (kb.fromScale + (kb.toScale - kb.fromScale) * eased) * pulse * extraScale;
    // contain は写真全体を見せるのが目的なので、拡大すると切れてしまう。
    // 代わりに同じ量だけ縮めて、動きを保ちつつ画面内に収め続ける
    const scale = target.fit === 'contain' ? 1 / grow : grow;
    const offsetX = kb.fromX + (kb.toX - kb.fromX) * eased + shift;
    const offsetY = kb.fromY + (kb.toY - kb.fromY) * eased;
    drawPhoto(ctx, source, width, height, scale, offsetX, offsetY, alpha, target.fit);
  };

  /** 手前の写真を描く前に、そのカットの背景を敷く */
  const background = (target: Segment, alpha: number) => {
    if (target.fit !== 'contain') return;
    drawBackground(ctx, photos.get(target.photoId), width, height, settings, alpha);
  };

  const sinceStart = time - segment.start;
  const previous = segments[index - 1];
  const isTransitioning = previous && sinceStart < transitionSeconds && transitionSeconds > 0;

  if (!isTransitioning) {
    background(segment, 1);
    draw(segment, time, 1);
    return;
  }

  const t = Math.min(1, sinceStart / transitionSeconds);
  const eased = easeInOut(t);

  background(previous, 1);
  background(segment, eased);

  switch (segment.transition) {
    case 'slide':
      draw(previous, time, 1, -eased * 2.2);
      draw(segment, time, 1, (1 - eased) * 2.2);
      break;
    case 'zoom':
      draw(previous, time, 1 - eased, 0, 1 + eased * 0.35);
      draw(segment, time, eased, 0, 1.35 - eased * 0.35);
      break;
    case 'whip': {
      // 切り替わりの瞬間に白を差し込んで、拍を強調する
      draw(previous, time, 1 - eased);
      draw(segment, time, eased);
      const flash = Math.sin(Math.PI * t) * 0.55;
      ctx.save();
      ctx.globalAlpha = flash;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(0, 0, width, height);
      ctx.restore();
      break;
    }
    case 'crossfade':
    default:
      draw(previous, time, 1 - eased);
      draw(segment, time, eased);
      break;
  }
}
