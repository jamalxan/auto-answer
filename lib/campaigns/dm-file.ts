/**
 * File attached to a comment-to-DM campaign. The file is stored with the
 * content storage driver; at send time a short-lived signed URL is handed to
 * Meta, which fetches it and delivers it as a DM attachment.
 */

import { getStorage, isValidMediaKey, mediaKey } from "@/lib/content/storage";

/** Meta caps DM attachments at 25 MB. */
export const DM_FILE_MAX_BYTES = 25 * 1024 * 1024;

type DmFileType = "image" | "video" | "audio" | "file";

const ALLOWED: Record<string, { ext: string; type: DmFileType }> = {
  "application/pdf": { ext: "pdf", type: "file" },
  "image/jpeg": { ext: "jpg", type: "image" },
  "image/png": { ext: "png", type: "image" },
  "image/webp": { ext: "webp", type: "image" },
  "video/mp4": { ext: "mp4", type: "video" },
  "audio/mpeg": { ext: "mp3", type: "audio" },
  "audio/mp4": { ext: "m4a", type: "audio" },
};

export const DM_FILE_ACCEPT = Object.keys(ALLOWED).join(",");

export function isAllowedDmFileMime(mime: string): boolean {
  return Object.prototype.hasOwnProperty.call(ALLOWED, mime);
}

export class DmFileError extends Error {}

export interface StoredDmFile {
  key: string;
  name: string;
  mime: string;
  size: number;
}

export async function storeDmFile(workspaceId: string, file: File): Promise<StoredDmFile> {
  const allowed = ALLOWED[file.type];
  if (!allowed) throw new DmFileError("Faqat PDF, JPG, PNG, WEBP, MP4, MP3 yoki M4A fayl yuklash mumkin");
  if (file.size <= 0) throw new DmFileError("Fayl bo'sh");
  if (file.size > DM_FILE_MAX_BYTES) throw new DmFileError("Fayl 25 MB dan katta");
  const key = mediaKey(workspaceId, allowed.ext);
  await getStorage().putObject(key, Buffer.from(await file.arrayBuffer()), file.type);
  return { key, name: file.name.slice(0, 120), mime: file.type, size: file.size };
}

/** A key a campaign may reference: valid shape and inside the caller's workspace. */
export function isWorkspaceDmFileKey(workspaceId: string, key: string): boolean {
  return isValidMediaKey(key) && key.startsWith(`ws/${workspaceId}/`);
}

export function dmFileAttachmentType(mime: string | null | undefined): DmFileType {
  return (mime && ALLOWED[mime]?.type) || "file";
}

/** Signed URL for Meta to fetch. 1 hour covers Meta's fetch; the text fallback uses a longer one. */
export function signedDmFileUrl(key: string, expiresSec = 3600): Promise<string> {
  return getStorage().presignGet(key, expiresSec);
}

export async function deleteDmFile(key: string | null | undefined): Promise<void> {
  if (!key) return;
  await getStorage().deleteObject(key).catch(() => undefined);
}
