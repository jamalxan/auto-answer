/**
 * ETAP 13 — the media library service (FR-M1, FR-M5): presigned direct
 * uploads, completion hand-off to the processing queue, listing with signed
 * thumbnails, and deletion that refuses while a live post still uses the
 * asset. Every function is scoped to a workspace; an id from another
 * workspace is a 404, never a 403.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { MEDIA, storageQuotaBytes } from "./config";
import { ContentError, MEDIA_NOT_FOUND, notFound } from "./errors";
import { enqueueMediaProcess } from "./queue";
import { getStorage, mediaKey } from "./storage";

export const MIME_EXT: Record<string, { ext: string; kind: "IMAGE" | "VIDEO" }> = {
  "image/jpeg": { ext: "jpg", kind: "IMAGE" },
  "image/png": { ext: "png", kind: "IMAGE" },
  "image/webp": { ext: "webp", kind: "IMAGE" },
  // HEIC / HEIF are NOT accepted: the prebuilt sharp/libvips has no HEVC decoder (see presignUpload).
  "video/mp4": { ext: "mp4", kind: "VIDEO" },
  "video/quicktime": { ext: "mov", kind: "VIDEO" },
};

export const ACCEPTED_MIME_TYPES = Object.keys(MIME_EXT);

export const presignInputSchema = z.object({
  fileName: z.string().trim().min(1).max(255),
  mimeType: z.enum(ACCEPTED_MIME_TYPES as [string, ...string[]], { error: "Bu fayl turi qabul qilinmaydi (JPEG, PNG, WEBP, MP4, MOV; HEIC hozircha emas — JPEG'ga o'giring)" }),
  sizeBytes: z.number().int().positive("fayl bo'sh"),
});
export type PresignInput = z.infer<typeof presignInputSchema>;

export const mediaQuerySchema = z.object({
  kind: z.enum(["IMAGE", "VIDEO"]).optional(),
  tag: z.string().trim().max(32).optional(),
  status: z.enum(["UPLOADING", "PROCESSING", "READY", "FAILED"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(60),
});
export type MediaQuery = z.infer<typeof mediaQuerySchema>;

/** Statuses in which a post no longer needs its media objects. */
export const POST_STATUSES_DONE_WITH_MEDIA = ["PUBLISHED", "PUBLISHED_MANUAL", "CANCELED", "FAILED", "REJECTED", "EXPIRED_REVIEW"] as const;

export const PRESIGN_TTL_SEC = 900;
const THUMB_URL_TTL_SEC = 3600;

export interface PresignResult {
  mediaId: string;
  uploadUrl: string;
  headers: Record<string, string>;
  expiresInSec: number;
  key: string;
}

/** Step 1 of an upload: reserve the quota, create the UPLOADING row, hand back a PUT URL. */
export const HEIC_MESSAGE = "HEIC hozircha qabul qilinmaydi — iPhone'da Sozlamalar → Kamera → Formatlar → «Eng mos» ni tanlang yoki rasmni JPEG'ga o'giring";

export async function presignUpload(workspaceId: string, userId: string | null, input: PresignInput): Promise<PresignResult> {
  if (/^image\/hei[cf]$/i.test(input.mimeType)) throw new ContentError(400, HEIC_MESSAGE);
  const mime = MIME_EXT[input.mimeType];
  if (!mime) throw new ContentError(400, "Bu fayl turi qabul qilinmaydi");
  const max = mime.kind === "IMAGE" ? MEDIA.imageMaxUploadBytes : MEDIA.videoMaxUploadBytes;
  if (input.sizeBytes > max) {
    throw new ContentError(413, mime.kind === "IMAGE" ? "Rasm 30 MB dan katta" : "Video 1 GB dan katta");
  }

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { mediaStorageBytes: true } });
  if (!workspace) throw notFound("Workspace topilmadi");
  const used = Number(workspace.mediaStorageBytes);
  if (used + input.sizeBytes > storageQuotaBytes()) {
    throw new ContentError(413, "Ombor kvotasi to'ldi — keraksiz fayllarni o'chiring");
  }

  const key = mediaKey(workspaceId, mime.ext);
  const asset = await prisma.mediaAsset.create({
    data: {
      workspaceId,
      uploadedById: userId ?? undefined,
      kind: mime.kind,
      originalKey: key,
      mimeType: input.mimeType,
      sizeBytes: BigInt(input.sizeBytes),
      status: "UPLOADING",
      tags: [],
    },
  });
  // The original is counted from the start so two parallel uploads cannot
  // both pass the quota check; a failed upload is released by deleteMedia.
  await prisma.workspace.update({ where: { id: workspaceId }, data: { mediaStorageBytes: { increment: BigInt(input.sizeBytes) } } });

  const put = await getStorage().presignPut(key, { contentType: input.mimeType, contentLength: input.sizeBytes, expiresSec: PRESIGN_TTL_SEC });
  return { mediaId: asset.id, uploadUrl: put.url, headers: put.headers, expiresInSec: PRESIGN_TTL_SEC, key };
}

async function ownedAsset(workspaceId: string, mediaId: string) {
  const asset = await prisma.mediaAsset.findUnique({ where: { id: mediaId } });
  if (!asset || asset.workspaceId !== workspaceId || asset.status === "DELETED") throw notFound(MEDIA_NOT_FOUND);
  return asset;
}

/** Step 2: the browser finished its PUT — verify the object and queue processing. */
export async function completeUpload(workspaceId: string, mediaId: string) {
  const asset = await ownedAsset(workspaceId, mediaId);
  if (asset.status !== "UPLOADING") return asset;
  const head = await getStorage().headObject(asset.originalKey);
  if (!head) throw new ContentError(400, "Fayl yuklanmagan — qayta urinib ko'ring");
  if (head.size !== Number(asset.sizeBytes)) {
    throw new ContentError(400, "Yuklangan fayl hajmi e'lon qilinganidan farq qiladi");
  }
  const updated = await prisma.mediaAsset.update({ where: { id: mediaId }, data: { status: "PROCESSING", error: null } });
  await enqueueMediaProcess(mediaId);
  return updated;
}

export interface MediaRow {
  id: string;
  kind: string;
  status: string;
  mimeType: string;
  sizeBytes: number;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  tags: string[];
  error: string | null;
  thumbUrl: string | null;
  createdAt: Date;
  usedByPostIds: string[];
}

export async function signedMediaUrl(key: string, expiresSec = THUMB_URL_TTL_SEC): Promise<string> {
  return getStorage().presignGet(key, expiresSec);
}

export async function listMedia(workspaceId: string, q: Partial<MediaQuery>): Promise<{ items: MediaRow[]; total: number }> {
  const page = q.page ?? 1;
  const pageSize = q.pageSize ?? 60;
  const where = {
    workspaceId,
    status: q.status ?? { not: "DELETED" as const },
    ...(q.kind ? { kind: q.kind } : {}),
    ...(q.tag ? { tags: { has: q.tag } } : {}),
  };
  const [rows, total] = await Promise.all([
    prisma.mediaAsset.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * pageSize,
      take: pageSize,
      include: { usages: { select: { postId: true } } },
    }),
    prisma.mediaAsset.count({ where }),
  ]);
  const items = await Promise.all(
    rows.map(async (row) => ({
      id: row.id,
      kind: row.kind,
      status: row.status,
      mimeType: row.mimeType,
      sizeBytes: Number(row.sizeBytes),
      width: row.width ?? null,
      height: row.height ?? null,
      durationMs: row.durationMs ?? null,
      tags: row.tags ?? [],
      error: row.error ?? null,
      thumbUrl: row.thumbKey ? await signedMediaUrl(row.thumbKey) : null,
      createdAt: row.createdAt,
      usedByPostIds: [...new Set((row.usages ?? []).map((u) => u.postId))],
    }))
  );
  return { items, total };
}

/** FR-M5: delete only when no live post uses the asset; releases the quota. */
export async function deleteMedia(workspaceId: string, mediaId: string): Promise<void> {
  const asset = await ownedAsset(workspaceId, mediaId);
  const live = await prisma.scheduledPostMedia.count({
    where: {
      mediaId,
      post: { deletedAt: null, status: { notIn: [...POST_STATUSES_DONE_WITH_MEDIA] } },
    },
  });
  if (live > 0) throw new ContentError(409, "Bu media rejalashtirilgan postda ishlatilmoqda — avval postni o'zgartiring");

  const storage = getStorage();
  let released = Number(asset.sizeBytes);
  for (const key of [asset.originalKey, asset.preparedKey, asset.thumbKey]) {
    if (!key) continue;
    if (key !== asset.originalKey) {
      const head = await storage.headObject(key).catch(() => null);
      released += head?.size ?? 0;
    }
    await storage.deleteObject(key).catch(() => undefined);
  }
  await prisma.mediaAsset.update({ where: { id: mediaId }, data: { status: "DELETED" } });
  await prisma.workspace.update({ where: { id: workspaceId }, data: { mediaStorageBytes: { decrement: BigInt(released) } } });
}

/** An upload whose PUT never finished: presign TTL plus generous slack. */
export const ABANDONED_UPLOAD_MS = 2 * 3_600_000;

/**
 * M6: a browser that closed mid-upload leaves an UPLOADING row holding its
 * reserved quota forever. The sweeper deletes those rows (and any partial
 * object), which releases the reservation.
 */
export async function releaseAbandonedUploads(now: Date = new Date()): Promise<number> {
  const stale = await prisma.mediaAsset.findMany({
    where: { status: "UPLOADING", createdAt: { lt: new Date(now.getTime() - ABANDONED_UPLOAD_MS) } },
    take: 200,
    select: { id: true, workspaceId: true },
  });
  let released = 0;
  for (const asset of stale) {
    try {
      await deleteMedia(asset.workspaceId, asset.id);
      released++;
    } catch (error) {
      console.error("[Content] abandoned upload not released:", error instanceof Error ? error.message : error);
    }
  }
  return released;
}

/** Spec §7 "Saqlash muddati": a prepared copy outlives its last publish by 30 days. */
export const PREPARED_RETENTION_MS = 30 * 24 * 3_600_000;
const PREPARED_CLEANUP_BATCH = 50;
const PUBLISHED_STATUSES = ["PUBLISHED", "PUBLISHED_MANUAL"] as const;

export interface PreparedCleanup {
  cleaned: number;
  releasedBytes: number;
}

/**
 * Sweeper step: drop the Instagram-ready copy (preparedKey) of media whose
 * every live usage is a post published more than 30 days ago. The original
 * and the thumbnail stay, the copy's bytes leave Workspace.mediaStorageBytes.
 * A video whose prepared copy IS the original (no transcode) loses only the
 * pointer — publishing falls back to originalKey, which is the same file.
 * Idempotent (a cleaned row has no preparedKey, and the write is guarded on
 * the key it read) and batched.
 */
export async function cleanupPreparedCopies(now: Date = new Date(), batch = PREPARED_CLEANUP_BATCH): Promise<PreparedCleanup> {
  const cutoff = new Date(now.getTime() - PREPARED_RETENTION_MS);
  const candidates = await prisma.mediaAsset.findMany({
    where: {
      status: "READY",
      preparedKey: { not: null },
      AND: [
        { usages: { some: { post: { deletedAt: null, status: { in: [...PUBLISHED_STATUSES] }, publishedAt: { lt: cutoff } } } } },
        // nothing else may still need it: a draft, a queued post, a failed one that can be retried, a recent publish
        { usages: { none: { post: { deletedAt: null, NOT: { status: { in: [...PUBLISHED_STATUSES] }, publishedAt: { lt: cutoff } } } } } },
      ],
    },
    orderBy: { updatedAt: "asc" },
    take: batch,
    select: { id: true, workspaceId: true, originalKey: true, preparedKey: true, preparedBytes: true },
  });

  const result: PreparedCleanup = { cleaned: 0, releasedBytes: 0 };
  if (candidates.length === 0) return result;
  const storage = getStorage();
  for (const asset of candidates) {
    const key = asset.preparedKey!;
    const separate = key !== asset.originalKey;
    let released = 0;
    try {
      if (separate) {
        released = asset.preparedBytes ?? (await storage.headObject(key).catch(() => null))?.size ?? 0;
        await storage.deleteObject(key);
      }
    } catch (error) {
      console.error("[Content] prepared copy not deleted:", error instanceof Error ? error.message : error);
      continue;
    }
    // preparedBytes null marks "copy dropped, re-prepare before reuse"; a shared original keeps its facts.
    const updated = await prisma.mediaAsset.updateMany({
      where: { id: asset.id, preparedKey: key },
      data: separate ? { preparedKey: null, preparedBytes: null } : { preparedKey: null },
    });
    if (updated.count === 0) continue;
    if (released > 0) {
      await prisma.workspace.update({ where: { id: asset.workspaceId }, data: { mediaStorageBytes: { decrement: BigInt(released) } } });
    }
    result.cleaned++;
    result.releasedBytes += released;
  }
  return result;
}

/**
 * The other half of the cleanup: an old asset whose prepared copy was
 * dropped is attached to a new post (duplicate, re-use from the library) —
 * prepare it again so Meta never gets the raw original. The thumbnail is
 * rewritten by the processor, so its bytes are released first (no double count).
 */
export async function reprepareCleanedMedia(workspaceId: string, mediaIds: string[]): Promise<number> {
  const ids = [...new Set(mediaIds)];
  if (ids.length === 0) return 0;
  const cleaned = await prisma.mediaAsset.findMany({
    where: { id: { in: ids }, workspaceId, status: "READY", preparedKey: null, preparedBytes: null },
    select: { id: true, thumbKey: true },
  });
  let queued = 0;
  for (const asset of cleaned) {
    const claimed = await prisma.mediaAsset.updateMany({ where: { id: asset.id, status: "READY", preparedKey: null }, data: { status: "PROCESSING", error: null } });
    if (claimed.count === 0) continue;
    const thumb = asset.thumbKey ? await getStorage().headObject(asset.thumbKey).catch(() => null) : null;
    if (thumb?.size) await prisma.workspace.update({ where: { id: workspaceId }, data: { mediaStorageBytes: { decrement: BigInt(thumb.size) } } });
    await enqueueMediaProcess(asset.id);
    queued++;
  }
  return queued;
}

/** Tags are the only "folders" (FR-M5). */
export async function setMediaTags(workspaceId: string, mediaId: string, tags: string[]): Promise<void> {
  await ownedAsset(workspaceId, mediaId);
  const clean = [...new Set(tags.map((t) => t.trim()).filter((t) => t.length > 0 && t.length <= 32))].slice(0, 20);
  await prisma.mediaAsset.update({ where: { id: mediaId }, data: { tags: clean } });
}
