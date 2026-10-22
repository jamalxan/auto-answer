/**
 * ETAP 13 — the error a content service throws to a route (an HTTP status
 * and an Uzbek message, turned into `{ success: false, error }` by
 * lib/content/service `run()`), and the publish-time classification of a
 * Meta failure into a catalog code with its retry policy (spec §11).
 */

import { MetaApiError, PermissionError, RateLimitError, TokenExpiredError } from "@/lib/meta/client";
import { parseMetaCodes } from "@/lib/foundation/error-catalog";

export class ContentError extends Error {
  constructor(
    public status: number,
    message: string,
    public code?: string
  ) {
    super(message);
    this.name = "ContentError";
  }
}

export const NOT_FOUND = "Post topilmadi";
export const MEDIA_NOT_FOUND = "Media topilmadi";

export function notFound(message = NOT_FOUND): ContentError {
  return new ContentError(404, message);
}

// ─── Publish errors ─────────────────────────────────────────────────────────

export type PublishErrorCode =
  | "PUBLISH_TOKEN_EXPIRED"
  | "PUBLISH_NO_PERMISSION"
  | "PUBLISH_QUOTA"
  | "PUBLISH_RATE_LIMIT"
  | "PUBLISH_MEDIA_FETCH"
  | "PUBLISH_MEDIA_INVALID"
  | "PUBLISH_CONTAINER_TIMEOUT"
  | "PUBLISH_CONTAINER_EXPIRED"
  | "PUBLISH_INVALID_USER_TAG"
  | "PUBLISH_INVALID_COLLABORATOR"
  | "PUBLISH_PPA_REQUIRED"
  | "PUBLISH_ACCOUNT_RESTRICTED"
  | "PUBLISH_LATE"
  | "PUBLISH_UNKNOWN"
  | "FIRST_COMMENT_FAILED"
  | "CAMPAIGN_LINK_FAILED";

export type PublishRetry = "none" | "backoff" | "new-container" | "new-url" | "manual";

export interface PublishErrorClass {
  code: PublishErrorCode;
  retry: PublishRetry;
  /** Wait before each retry; the length is the retry budget. */
  delaysMs: number[];
}

const RATE_LIMIT_DELAYS = [60_000, 120_000, 240_000, 480_000];
const UNKNOWN_DELAYS = [30_000, 120_000, 600_000];
const MEDIA_FETCH_DELAYS = [30_000, 60_000, 120_000];

const NETWORK = /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timed? ?out|AbortError|network/i;

/**
 * Meta error → what we tell the user and what the pipeline does next.
 * Subcodes are from the Content Publishing error reference; the message
 * text decides when Meta sends a generic code (100 / 1).
 */
export function classifyPublishError(err: unknown, containerStatusText?: string): PublishErrorClass {
  const message = err instanceof Error ? err.message : String(err ?? "");
  const text = `${message} ${containerStatusText ?? ""}`;
  const parsed = parseMetaCodes(message);
  const code = err instanceof MetaApiError ? (parsed.code ?? err.code) : parsed.code;
  const subcode = err instanceof MetaApiError ? (err.subcode ?? parsed.subcode) : parsed.subcode;

  if (err instanceof TokenExpiredError || code === 190) return { code: "PUBLISH_TOKEN_EXPIRED", retry: "none", delaysMs: [] };
  if (code === 9 || /publishing limit|quota/i.test(text)) return { code: "PUBLISH_QUOTA", retry: "none", delaysMs: [] };
  if (err instanceof RateLimitError || code === 4 || code === 17 || code === 32 || code === 613 || code === 368) {
    return { code: "PUBLISH_RATE_LIMIT", retry: "backoff", delaysMs: RATE_LIMIT_DELAYS };
  }
  if (code === 36000 || /page publishing authorization|\bPPA\b/i.test(text)) return { code: "PUBLISH_PPA_REQUIRED", retry: "none", delaysMs: [] };
  if (code === 9007 || subcode === 2207008 || /media download failed|could not fetch|fetch(ing)? (the )?media|download of media/i.test(text)) {
    return { code: "PUBLISH_MEDIA_FETCH", retry: "new-url", delaysMs: MEDIA_FETCH_DELAYS };
  }
  if (subcode === 2207032 || /user tag|tagged user|invalid tag/i.test(text)) return { code: "PUBLISH_INVALID_USER_TAG", retry: "none", delaysMs: [] };
  if (subcode === 2207042 || /collaborator/i.test(text)) return { code: "PUBLISH_INVALID_COLLABORATOR", retry: "none", delaysMs: [] };
  if (subcode === 2207050 || subcode === 2207051 || /restricted|not allowed to publish|blocked/i.test(text)) {
    return { code: "PUBLISH_ACCOUNT_RESTRICTED", retry: "manual", delaysMs: [] };
  }
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299) || (err instanceof PermissionError && code !== 100)) {
    return { code: "PUBLISH_NO_PERMISSION", retry: "none", delaysMs: [] };
  }
  if (
    (subcode !== undefined && subcode >= 2207001 && subcode <= 2207099) ||
    /aspect ratio|unsupported (video|image|format)|duration|file size|too (large|long|short)|resolution|bitrate|frame rate|codec|invalid (image|video|media)|media type/i.test(text)
  ) {
    return { code: "PUBLISH_MEDIA_INVALID", retry: "none", delaysMs: [] };
  }
  if (code === 100 || (err instanceof PermissionError && code === 100)) return { code: "PUBLISH_MEDIA_INVALID", retry: "none", delaysMs: [] };
  return { code: "PUBLISH_UNKNOWN", retry: "backoff", delaysMs: UNKNOWN_DELAYS };
}

/** Did the request possibly reach Meta and succeed without us hearing back? */
export function isAmbiguousFailure(err: unknown): boolean {
  if (err instanceof MetaApiError) return err.code === 1 || err.code === 2 || (err.code >= 500 && err.code <= 599);
  const message = err instanceof Error ? err.message : String(err ?? "");
  return NETWORK.test(message);
}
