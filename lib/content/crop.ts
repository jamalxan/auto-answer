/**
 * ETAP 13 — crop (FR-M4). A post keeps the uploaded asset untouched and
 * stores the chosen frame as a 0–1 rectangle on ScheduledPostMedia.cropRect;
 * the publisher cuts the prepared JPEG to that frame just before Meta
 * fetches it (one asset can sit in several posts with different crops).
 * User tags are placed on the full image in the composer and moved into
 * the cropped frame here.
 */

import sharp from "sharp";
import { getStorage, type StorageDriver } from "./storage";
import { isFullFrame, type CropRect } from "./crop-geometry";

export * from "./crop-geometry";

/** The JPEG Meta receives: the prepared image cut to the frame. */
export async function croppedImage(prepared: Buffer, rect: CropRect): Promise<Buffer> {
  const img = sharp(prepared, { failOn: "none" });
  const m = await img.metadata();
  const W = m.width ?? 0;
  const H = m.height ?? 0;
  const left = Math.min(W - 1, Math.max(0, Math.round(rect.x * W)));
  const top = Math.min(H - 1, Math.max(0, Math.round(rect.y * H)));
  const width = Math.max(1, Math.min(W - left, Math.round(rect.w * W)));
  const height = Math.max(1, Math.min(H - top, Math.round(rect.h * H)));
  return img.extract({ left, top, width, height }).jpeg({ quality: 90, mozjpeg: true, chromaSubsampling: "4:4:4" }).toBuffer();
}

/** Where the cropped copy of one post item lives (next to the original: `<id>.crop-<item>.jpg`). */
export function cropKey(originalKey: string, postMediaId: string): string {
  const slash = originalKey.lastIndexOf("/");
  const dot = originalKey.lastIndexOf(".");
  return `${dot > slash ? originalKey.slice(0, dot) : originalKey}.crop-${postMediaId.toLowerCase().replace(/[^a-z0-9]/g, "")}.jpg`;
}

export interface CroppableItem {
  id: string;
  cropRect: unknown;
  media: { kind: string; originalKey: string; preparedKey: string | null };
}

export function cropOf(item: Pick<CroppableItem, "cropRect">): CropRect | null {
  const r = item.cropRect as CropRect | null | undefined;
  return r && typeof r.x === "number" && typeof r.w === "number" && !isFullFrame(r) ? r : null;
}

/**
 * The storage key Meta (or Telegram) should fetch for one post item: the
 * prepared file, or — for a cropped image — a fresh cut of it written next
 * to the original. Regenerated on every call, so a changed crop never
 * serves a stale picture.
 */
export async function itemMediaKey(item: CroppableItem, storage: Pick<StorageDriver, "getObject" | "putObject"> = getStorage()): Promise<string> {
  const base = item.media.preparedKey ?? item.media.originalKey;
  const rect = item.media.kind === "IMAGE" ? cropOf(item) : null;
  if (!rect) return base;
  const key = cropKey(item.media.originalKey, item.id);
  await storage.putObject(key, await croppedImage(await storage.getObject(base), rect), "image/jpeg");
  return key;
}

/** Drop the cut copies once Meta has the post (best effort). */
export async function dropItemCrops(items: CroppableItem[], storage: Pick<StorageDriver, "deleteObject"> = getStorage()): Promise<void> {
  for (const item of items) {
    if (item.media.kind === "IMAGE" && cropOf(item)) await storage.deleteObject(cropKey(item.media.originalKey, item.id)).catch(() => undefined);
  }
}
