/**
 * ETAP 13 — crop geometry (FR-M4), shared by the composer and the server:
 * ratio presets, the centred frame, the cropped ratio and user tags moved
 * into the frame. No I/O here so the browser can import it.
 */

export interface CropRect {
  x: number;
  y: number;
  w: number;
  h: number;
}

export const CROP_PRESETS = [
  { label: "1:1", ratio: 1 },
  { label: "4:5", ratio: 0.8 },
  { label: "1.91:1", ratio: 1.91 },
  { label: "9:16", ratio: 9 / 16 },
] as const;

const round4 = (n: number) => Math.round(n * 10_000) / 10_000;
const clamp01 = (n: number) => Math.min(1, Math.max(0, n));

/** The largest centred frame of `ratio` (width / height) inside a w×h image. */
export function centerCrop(width: number, height: number, ratio: number): CropRect {
  const imageRatio = width / height;
  if (imageRatio > ratio) {
    const w = ratio / imageRatio;
    return { x: round4((1 - w) / 2), y: 0, w: round4(w), h: 1 };
  }
  const h = imageRatio / ratio;
  return { x: 0, y: round4((1 - h) / 2), w: 1, h: round4(h) };
}

/** Width / height of the cropped picture. */
export function croppedRatio(width: number, height: number, rect: CropRect): number {
  return (rect.w * width) / (rect.h * height);
}

export function cropInsideImage(rect: CropRect): boolean {
  const eps = 0.0002;
  return rect.w > 0 && rect.h > 0 && rect.x + rect.w <= 1 + eps && rect.y + rect.h <= 1 + eps;
}

/** A crop that changes nothing (absent, or the whole image). */
export function isFullFrame(rect: CropRect | null | undefined): boolean {
  return !rect || (rect.x <= 0.0001 && rect.y <= 0.0001 && rect.w >= 0.9999 && rect.h >= 0.9999);
}

type Tag = { username: string; x?: number; y?: number };

/** Tags placed on the full image, re-expressed in the cropped frame (outside → clamped to the edge). */
export function tagsInCrop<T extends Tag>(tags: T[], rect: CropRect | null | undefined): T[] {
  if (isFullFrame(rect)) return tags;
  const r = rect as CropRect;
  return tags.map((t) =>
    t.x === undefined || t.y === undefined ? t : { ...t, x: round4(clamp01((t.x - r.x) / r.w)), y: round4(clamp01((t.y - r.y) / r.h)) }
  );
}
