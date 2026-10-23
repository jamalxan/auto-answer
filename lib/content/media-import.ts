/**
 * ETAP 13 Faza 2 — a media file fetched server-side from a URL into the
 * library (CSV import, FR-I1). The same rules as a browser upload: accepted
 * types by magic bytes (never the server's Content-Type), size limits, the
 * workspace storage quota, then the normal media-process job (sharp /
 * ffmpeg, thumbnail) — so an imported file is indistinguishable from an
 * uploaded one.
 *
 * SSRF: the download goes through lib/javobai/attachments `fetchAttachment`
 * — https only, no credentials in the URL, no internal hostname, every DNS
 * answer must be public, each redirect hop re-checked, a streaming size cap
 * and a timeout.
 */

import { prisma } from "@/lib/db/client";
import { AttachmentError, fetchAttachment, type FetchAttachmentOptions } from "@/lib/javobai/attachments";
import { MEDIA, storageQuotaBytes } from "./config";
import { ContentError } from "./errors";
import { HEIC_MESSAGE, MIME_EXT } from "./media";
import { detectMagic } from "./media-process";
import { enqueueMediaProcess } from "./queue";
import { getStorage, mediaKey } from "./storage";

/** Imported videos are held in memory while they are stored, so the cap is lower than a browser upload's 1 GB. */
export const IMPORT_VIDEO_MAX_BYTES = 300 * 1024 ** 2;
export const IMPORT_TIMEOUT_MS = 60_000;

export interface MediaImportDeps {
  fetchImpl?: typeof fetch;
  resolveHost?: FetchAttachmentOptions["resolveHost"];
  timeoutMs?: number;
}

export interface ImportedMedia {
  mediaId: string;
  kind: "IMAGE" | "VIDEO";
  sizeBytes: number;
}

const FETCH_MESSAGES: Record<AttachmentError["code"], string> = {
  bad_url: "havola noto'g'ri (faqat https://)",
  private_address: "ichki (xususiy) manzildan yuklab bo'lmaydi",
  too_large: "fayl juda katta",
  unsupported_type: "fayl turi qabul qilinmaydi (JPEG, PNG, WEBP, MP4, MOV)",
  timeout: "yuklab olish vaqti tugadi",
  too_many_redirects: "havola juda ko'p yo'naltiradi",
  fetch_failed: "fayl yuklab olinmadi (havola ochilmadi)",
};

/** Download one URL into the library as a PROCESSING asset and queue its processing. */
export async function importMediaFromUrl(workspaceId: string, userId: string | null, url: string, deps: MediaImportDeps = {}): Promise<ImportedMedia> {
  let fetched;
  try {
    fetched = await fetchAttachment(url, {
      maxBytes: Math.max(MEDIA.imageMaxUploadBytes, IMPORT_VIDEO_MAX_BYTES),
      timeoutMs: deps.timeoutMs ?? IMPORT_TIMEOUT_MS,
      fetchImpl: deps.fetchImpl,
      resolveHost: deps.resolveHost,
    });
  } catch (error) {
    if (error instanceof AttachmentError) throw new ContentError(400, FETCH_MESSAGES[error.code] ?? FETCH_MESSAGES.fetch_failed);
    throw new ContentError(400, FETCH_MESSAGES.fetch_failed);
  }

  const magic = detectMagic(fetched.buffer);
  if (magic === "image/heic") throw new ContentError(400, HEIC_MESSAGE);
  const mime = magic ? MIME_EXT[magic] : undefined;
  if (!magic || !mime) throw new ContentError(400, FETCH_MESSAGES.unsupported_type);
  const size = fetched.buffer.length;
  if (mime.kind === "IMAGE" && size > MEDIA.imageMaxUploadBytes) throw new ContentError(413, "Rasm 30 MB dan katta");
  if (mime.kind === "VIDEO" && size > IMPORT_VIDEO_MAX_BYTES) throw new ContentError(413, "Video 300 MB dan katta (import uchun)");

  const workspace = await prisma.workspace.findUnique({ where: { id: workspaceId }, select: { mediaStorageBytes: true } });
  if (!workspace) throw new ContentError(404, "Workspace topilmadi");
  if (Number(workspace.mediaStorageBytes) + size > storageQuotaBytes()) throw new ContentError(413, "Ombor kvotasi to'ldi — keraksiz fayllarni o'chiring");

  const key = mediaKey(workspaceId, mime.ext);
  await getStorage().putObject(key, fetched.buffer, magic);
  const asset = await prisma.mediaAsset.create({
    data: {
      workspaceId,
      uploadedById: userId ?? undefined,
      kind: mime.kind,
      originalKey: key,
      mimeType: magic,
      sizeBytes: BigInt(size),
      status: "PROCESSING",
      tags: ["csv-import"],
    },
  });
  await prisma.workspace.update({ where: { id: workspaceId }, data: { mediaStorageBytes: { increment: BigInt(size) } } });
  await enqueueMediaProcess(asset.id);
  return { mediaId: asset.id, kind: mime.kind, sizeBytes: size };
}
