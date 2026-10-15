/**
 * JavobAI ETAP 4.3 — customer media in Direct (TZ §26).
 *
 * The webhook passes `{type, url}` of every Meta attachment through
 * `InboundJob.attachments` (optional; production ignores it). This module
 * sorts them into audio / images / other, downloads one attachment from its
 * short-lived CDN url with an SSRF guard, a streaming size cap and a timeout,
 * and sniffs the real content type from the bytes (the CDN's header is a
 * hint, not the truth). Customer media is never written to disk or to the
 * database: the buffer lives for one transcription / vision call and is
 * dropped. Urls carry signed tokens, so only the hostname ever reaches a log.
 *
 * Env caps (bytes; defaults 8 MB audio, 5 MB image, 15 s per download):
 *   JAVOBAI_MAX_AUDIO_BYTES, JAVOBAI_MAX_IMAGE_BYTES, JAVOBAI_MEDIA_TIMEOUT_MS
 */

import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { isInternalHostname, isPrivateAddress } from "@/lib/integrations/net";

// ─── Classification ───────────────────────────────────────────────────────────

/** `{type, url}` as the webhook / InboundJob carry it. */
export interface InboundAttachment {
  type: string;
  url: string;
}

export interface ClassifiedAttachments {
  audio: InboundAttachment[];
  images: InboundAttachment[];
  /** video, file, share, story_mention, ig_reel, ig_post, sticker, ... */
  other: InboundAttachment[];
}

/**
 * Meta attachment types seen on Instagram Messaging webhooks. Voice notes
 * arrive as "audio"; photos as "image". Everything else is passed to the
 * engine as "other" so it can answer with the media template.
 */
const AUDIO_TYPES = new Set(["audio", "voice"]);
const IMAGE_TYPES = new Set(["image", "photo"]);

export function classifyAttachments(list: readonly InboundAttachment[] | undefined | null): ClassifiedAttachments {
  const out: ClassifiedAttachments = { audio: [], images: [], other: [] };
  for (const item of list ?? []) {
    if (!item || typeof item.url !== "string" || !item.url) continue;
    const type = String(item.type ?? "").trim().toLowerCase();
    const normalized = { type, url: item.url };
    if (AUDIO_TYPES.has(type)) out.audio.push(normalized);
    else if (IMAGE_TYPES.has(type)) out.images.push(normalized);
    else out.other.push(normalized);
  }
  return out;
}

// ─── Limits ───────────────────────────────────────────────────────────────────

export const DEFAULT_MAX_AUDIO_BYTES = 8 * 1024 * 1024;
export const DEFAULT_MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const DEFAULT_DOWNLOAD_TIMEOUT_MS = 15_000;
const MAX_REDIRECTS = 3;

function envInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function maxAudioBytes(): number {
  return envInt("JAVOBAI_MAX_AUDIO_BYTES", DEFAULT_MAX_AUDIO_BYTES);
}

export function maxImageBytes(): number {
  return envInt("JAVOBAI_MAX_IMAGE_BYTES", DEFAULT_MAX_IMAGE_BYTES);
}

export function downloadTimeoutMs(): number {
  return envInt("JAVOBAI_MEDIA_TIMEOUT_MS", DEFAULT_DOWNLOAD_TIMEOUT_MS);
}

// ─── Content sniffing ─────────────────────────────────────────────────────────

/** Audio containers Instagram voice notes and forwarded audio arrive in. */
export const AUDIO_MIME_TYPES = ["audio/ogg", "audio/mp4", "audio/mpeg", "audio/wav", "audio/aac"] as const;
/** Image formats the vision call accepts. */
export const IMAGE_MIME_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export type AudioMime = (typeof AUDIO_MIME_TYPES)[number];
export type ImageMime = (typeof IMAGE_MIME_TYPES)[number];

const ascii = (buf: Buffer, start: number, text: string) =>
  buf.length >= start + text.length && buf.toString("latin1", start, start + text.length) === text;

/**
 * Real media type from magic bytes, or null when unrecognised. Only the
 * formats the downstream calls accept are detected on purpose.
 */
export function sniffMime(buf: Buffer): AudioMime | ImageMime | null {
  if (buf.length < 12) return null;
  // Images
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return "image/jpeg";
  if (buf[0] === 0x89 && ascii(buf, 1, "PNG")) return "image/png";
  if (ascii(buf, 0, "RIFF") && ascii(buf, 8, "WEBP")) return "image/webp";
  // Audio
  if (ascii(buf, 0, "OggS")) return "audio/ogg";
  if (ascii(buf, 4, "ftyp")) return "audio/mp4"; // m4a / mp4 audio (ISO BMFF)
  if (ascii(buf, 0, "RIFF") && ascii(buf, 8, "WAVE")) return "audio/wav";
  if (ascii(buf, 0, "ID3")) return "audio/mpeg";
  if (buf[0] === 0xff && (buf[1] & 0xf6) === 0xf0) return "audio/aac"; // ADTS sync 0xFFF1 / 0xFFF9
  if (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0) return "audio/mpeg"; // MPEG frame sync
  return null;
}

/** `audio/ogg; codecs=opus` → `audio/ogg`. */
export function normalizeContentType(header: string | null | undefined): string | null {
  if (!header) return null;
  const type = header.split(";")[0]?.trim().toLowerCase();
  return type || null;
}

// ─── Download ─────────────────────────────────────────────────────────────────

export type AttachmentErrorCode =
  | "bad_url"
  | "private_address"
  | "too_large"
  | "unsupported_type"
  | "timeout"
  | "too_many_redirects"
  | "fetch_failed";

export class AttachmentError extends Error {
  constructor(
    public code: AttachmentErrorCode,
    detail?: string
  ) {
    super(detail ? `${code}: ${detail}` : code);
    this.name = "AttachmentError";
  }
}

export interface FetchAttachmentOptions {
  /** Hard cap; the download is aborted as soon as it is exceeded. */
  maxBytes: number;
  timeoutMs?: number;
  /** Sniffed media types that are accepted; anything else → `unsupported_type`. */
  allowedContentTypes?: readonly string[];
  /** Tests: replace global fetch. */
  fetchImpl?: typeof fetch;
  /** Tests: replace DNS resolution (hostname → addresses). */
  resolveHost?: (hostname: string) => Promise<string[]>;
}

export interface FetchedAttachment {
  buffer: Buffer;
  /** Sniffed media type (never the CDN header alone). */
  mime: string;
  bytes: number;
  /** What the CDN said, for diagnostics. */
  declaredContentType: string | null;
}

async function defaultResolve(hostname: string): Promise<string[]> {
  const records = await lookup(hostname, { all: true }).catch(() => []);
  return records.map((r) => r.address);
}

/**
 * Parse + validate a customer-media url: https only, no credentials, no
 * internal hostname and no private address behind the DNS name.
 */
export async function assertPublicMediaUrl(
  raw: string,
  resolveHost: (hostname: string) => Promise<string[]> = defaultResolve
): Promise<URL> {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new AttachmentError("bad_url");
  }
  if (url.protocol !== "https:") throw new AttachmentError("bad_url", "https only");
  if (url.username || url.password) throw new AttachmentError("bad_url", "credentials in url");
  if (isInternalHostname(url.hostname)) throw new AttachmentError("private_address");

  const host = url.hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await resolveHost(host);
  if (addresses.length === 0) throw new AttachmentError("fetch_failed", "dns");
  if (addresses.some((a) => isPrivateAddress(a))) throw new AttachmentError("private_address");
  return url;
}

/** Hostname only — the path carries a signed token. */
export function describeMediaUrl(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return "invalid-url";
  }
}

/**
 * Download one attachment into memory. Follows up to three redirects, each
 * hop re-validated; enforces `maxBytes` on the Content-Length header and
 * again while streaming; sniffs the type from the bytes.
 */
export async function fetchAttachment(rawUrl: string, options: FetchAttachmentOptions): Promise<FetchedAttachment> {
  const fetchImpl = options.fetchImpl ?? fetch;
  const timeoutMs = options.timeoutMs ?? downloadTimeoutMs();
  const maxBytes = Math.max(1, Math.floor(options.maxBytes));

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let url = await assertPublicMediaUrl(rawUrl, options.resolveHost);
    let response: Response | null = null;

    for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
      let candidate: Response;
      try {
        candidate = await fetchImpl(url.toString(), {
          method: "GET",
          redirect: "manual",
          signal: controller.signal,
          headers: { accept: "*/*" },
        });
      } catch (error) {
        if (controller.signal.aborted) throw new AttachmentError("timeout");
        throw new AttachmentError("fetch_failed", error instanceof Error ? error.message : "network");
      }

      if ([301, 302, 303, 307, 308].includes(candidate.status)) {
        const location = candidate.headers.get("location");
        await candidate.body?.cancel().catch(() => {});
        if (!location) throw new AttachmentError("fetch_failed", `redirect without location`);
        if (hop === MAX_REDIRECTS) throw new AttachmentError("too_many_redirects");
        url = await assertPublicMediaUrl(new URL(location, url).toString(), options.resolveHost);
        continue;
      }
      response = candidate;
      break;
    }
    if (!response) throw new AttachmentError("too_many_redirects");

    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      throw new AttachmentError("fetch_failed", `status ${response.status}`);
    }

    const declaredLength = Number(response.headers.get("content-length"));
    if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
      await response.body?.cancel().catch(() => {});
      throw new AttachmentError("too_large", `content-length ${declaredLength} > ${maxBytes}`);
    }

    const buffer = await readCapped(response, maxBytes, controller.signal);
    const declared = normalizeContentType(response.headers.get("content-type"));
    const mime = sniffMime(buffer);
    if (!mime) throw new AttachmentError("unsupported_type", declared ?? "unknown");
    if (options.allowedContentTypes && !options.allowedContentTypes.includes(mime)) {
      throw new AttachmentError("unsupported_type", mime);
    }
    return { buffer, mime, bytes: buffer.length, declaredContentType: declared };
  } finally {
    clearTimeout(timer);
  }
}

async function readCapped(response: Response, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  const body = response.body;
  if (!body) {
    const whole = Buffer.from(await response.arrayBuffer());
    if (whole.length > maxBytes) throw new AttachmentError("too_large", `${whole.length} > ${maxBytes}`);
    return whole;
  }
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      if (signal.aborted) throw new AttachmentError("timeout");
      let step: ReadableStreamReadResult<Uint8Array>;
      try {
        step = await reader.read();
      } catch (error) {
        if (signal.aborted) throw new AttachmentError("timeout");
        throw new AttachmentError("fetch_failed", error instanceof Error ? error.message : "stream");
      }
      if (step.done) break;
      total += step.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel().catch(() => {});
        throw new AttachmentError("too_large", `> ${maxBytes}`);
      }
      chunks.push(step.value);
    }
  } finally {
    reader.releaseLock?.();
  }
  return Buffer.concat(chunks.map((c) => Buffer.from(c.buffer, c.byteOffset, c.byteLength)), total);
}

/** A voice note / audio attachment with the env caps applied. */
export function fetchAudioAttachment(url: string, options: Partial<FetchAttachmentOptions> = {}) {
  return fetchAttachment(url, { maxBytes: maxAudioBytes(), allowedContentTypes: AUDIO_MIME_TYPES, ...options });
}

/** A photo attachment with the env caps applied. */
export function fetchImageAttachment(url: string, options: Partial<FetchAttachmentOptions> = {}) {
  return fetchAttachment(url, { maxBytes: maxImageBytes(), allowedContentTypes: IMAGE_MIME_TYPES, ...options });
}

// ─── Per-conversation media cap ───────────────────────────────────────────────

export const MEDIA_CAP_MAX = 3;
export const MEDIA_CAP_WINDOW_MS = 10 * 60 * 1000;

export interface MediaCapLimits {
  max: number;
  windowMs: number;
}

/**
 * Pure: given the timestamps (ms) of the media already processed for a
 * conversation, is one more allowed now? Returns the pruned list to store.
 */
export function mediaWindowAllows(
  recent: readonly number[],
  now: number = Date.now(),
  limits: MediaCapLimits = { max: MEDIA_CAP_MAX, windowMs: MEDIA_CAP_WINDOW_MS }
): { allowed: boolean; recent: number[] } {
  const kept = recent.filter((t) => Number.isFinite(t) && now - t < limits.windowMs && t <= now);
  return { allowed: kept.length < limits.max, recent: kept };
}

/** The subset of ioredis the counter needs; injectable for tests. */
export interface MediaCapStore {
  /** ioredis `eval(script, numKeys, ...keysAndArgs)`. */
  eval(script: string, numKeys: number, ...args: Array<string | number>): Promise<unknown>;
  decr(key: string): Promise<number>;
}

export function mediaCapKey(conversationId: string): string {
  return `javobai:media:${conversationId}`;
}

/**
 * INCR and, on the first use, PEXPIRE in ONE step: a PEXPIRE that fails after
 * a successful INCR would leave a counter with no TTL and the conversation
 * capped for good.
 */
export const MEDIA_SLOT_SCRIPT = 'local n = redis.call("INCR", KEYS[1]) if n == 1 then redis.call("PEXPIRE", KEYS[1], ARGV[1]) end return n';

/**
 * Atomic per-conversation slot: INCR + PEXPIRE on first use (one Lua call).
 * Returns false when the cap is hit (the increment is undone so a burst does
 * not extend the block). A Redis error fails open — one extra transcription
 * is cheaper than a customer left without an answer.
 */
export async function acquireMediaSlot(
  store: MediaCapStore,
  conversationId: string,
  limits: MediaCapLimits = { max: MEDIA_CAP_MAX, windowMs: MEDIA_CAP_WINDOW_MS }
): Promise<boolean> {
  const key = mediaCapKey(conversationId);
  try {
    const count = Number(await store.eval(MEDIA_SLOT_SCRIPT, 1, key, limits.windowMs));
    if (count > limits.max) {
      await store.decr(key).catch(() => {});
      return false;
    }
    return true;
  } catch (error) {
    console.error("[JavobAI] media cap store failed (allowing):", error instanceof Error ? error.message : error);
    return true;
  }
}
