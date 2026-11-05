/**
 * File attached to a comment-to-DM campaign or a channel auto-reply rule. The
 * file is stored with the content storage driver; at send time a signed URL is
 * handed to Meta, which fetches it and delivers it as a DM attachment — or the
 * URL itself goes out as a link where an attachment cannot be sent.
 */

import { prisma } from "@/lib/db/client";
import { getStorage, isValidMediaKey, mediaKey } from "@/lib/content/storage";

/** Meta caps DM attachments at 25 MB. */
export const DM_FILE_MAX_BYTES = 25 * 1024 * 1024;
/** Multipart overhead on top of the file itself; a bigger body is refused before it is read. */
export const DM_FILE_MAX_BODY_BYTES = DM_FILE_MAX_BYTES + 1024 * 1024;
/** A file sent as a link (private reply, refused attachment) stays downloadable this long — S3's presign maximum. */
export const DM_FILE_LINK_TTL_SEC = 7 * 24 * 3600;

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

const MIME_BY_EXT: Record<string, string> = Object.fromEntries(
  Object.entries(ALLOWED).map(([mime, { ext }]) => [ext, mime])
);

/** What storeDmFile writes: `ws/<ws>/<yyyy>/<mm>/<id>.<ext>` — no `.prepared` / `.thumb` / `.crop-*` variants. */
const DM_FILE_KEY_RE = /^ws\/([a-z0-9]+)\/\d{4}\/\d{2}\/[a-z0-9-]+\.([a-z0-9]+)$/;

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
  return { key, name: cleanDmFileName(file.name), mime: file.type, size: file.size };
}

/**
 * The file type a key stands for, from its extension (set by storeDmFile, so
 * the server never has to trust a type the browser sends). Null when the key is
 * not a DM file key in this workspace.
 */
export function dmFileMimeForKey(workspaceId: string, key: string): string | null {
  if (!isValidMediaKey(key)) return null;
  const match = DM_FILE_KEY_RE.exec(key);
  if (!match || match[1] !== workspaceId) return null;
  return MIME_BY_EXT[match[2]] ?? null;
}

/** A key a campaign or rule may reference: a DM file key inside the caller's workspace. */
export function isWorkspaceDmFileKey(workspaceId: string, key: string): boolean {
  return dmFileMimeForKey(workspaceId, key) !== null;
}

/** File name as shown to the recipient: one line, at most 120 characters. */
export function cleanDmFileName(name: string | null | undefined): string {
  const clean = (name ?? "").replace(/[\r\n\t]+/g, " ").trim().slice(0, 120);
  return clean || "Fayl";
}

export function dmFileAttachmentType(mime: string | null | undefined): DmFileType {
  return (mime && ALLOWED[mime]?.type) || "file";
}

/** Signed URL for Meta to fetch. 1 hour covers Meta's fetch; links use DM_FILE_LINK_TTL_SEC. */
export function signedDmFileUrl(key: string, expiresSec = 3600): Promise<string> {
  return getStorage().presignGet(key, expiresSec);
}

/** `📎 name: <7-day link>` — the file handed over as text. */
export async function dmFileLinkLine(key: string, name: string | null | undefined): Promise<string> {
  return `📎 ${cleanDmFileName(name)}: ${await signedDmFileUrl(key, DM_FILE_LINK_TTL_SEC)}`;
}

/**
 * `text` followed by `line` on its own paragraph, within `max` characters. The
 * line (a link) is kept whole; the text is shortened instead, so a platform
 * limit never cuts the URL in half.
 */
export function appendLine(text: string, line: string, max: number): string {
  const sep = text ? "\n\n" : "";
  const room = max - line.length - sep.length;
  if (room <= 0) return line.slice(0, max);
  const head = text.length > room ? `${text.slice(0, Math.max(0, room - 1)).trimEnd()}…` : text;
  return `${head}${sep}${line}`;
}

/**
 * Delete a stored file unless something still points at it. A duplicated
 * campaign shares its original's key, and a content upload uses the same key
 * space, so "this record stopped using it" is not enough to remove the object.
 */
export async function deleteDmFile(key: string | null | undefined): Promise<void> {
  if (!key) return;
  try {
    const [campaigns, rules, media] = await Promise.all([
      prisma.automation.count({ where: { dmFileKey: key } }),
      prisma.channelAutoReply.count({ where: { fileKey: key } }),
      prisma.mediaAsset.count({ where: { OR: [{ originalKey: key }, { preparedKey: key }, { thumbKey: key }] } }),
    ]);
    if (campaigns + rules + media > 0) return;
    await getStorage().deleteObject(key);
  } catch (error) {
    console.warn("[DM file] delete skipped:", error instanceof Error ? error.message : error);
  }
}
