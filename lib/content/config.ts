/**
 * ETAP 13 — Content Scheduler: kill switch, env-driven limits and the fixed
 * Instagram Content Publishing constraints every other content module reads.
 *
 * Lives in the main dashboard at /content (promoted from /developer 2026-10-26).
 * CONTENT_SCHEDULER_DISABLED=1 is the kill switch: no queues, no sweeper, the
 * API answers 404 like any unknown route.
 */

export function isContentSchedulerEnabled(): boolean {
  const flag = (process.env.CONTENT_SCHEDULER_DISABLED ?? "").trim().toLowerCase();
  return !(flag === "1" || flag === "true" || flag === "yes");
}

function intEnv(name: string, fallback: number, min: number, max: number): number {
  const raw = (process.env[name] ?? "").trim();
  if (!raw) return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

/** Text and scheduling limits of the Instagram API (spec §6). */
export const CONTENT_LIMITS = {
  captionChars: 2200,
  hashtags: 30,
  mentions: 20,
  firstCommentChars: 2200,
  altTextChars: 1000,
  minScheduleLeadMs: 5 * 60_000,
  maxScheduleAheadMs: 365 * 86_400_000,
  /** Story series: each story one minute after the previous one. */
  storySeriesGapMs: 60_000,
  /** FR-C9: a STORY draft with up to this many media becomes a series when scheduled. */
  storySeriesMax: 10,
  /** Two posts of one account within a minute: the second moves this far. */
  sameMinuteGapMs: 120_000,
} as const;

/** Meta documents 10 or 20 depending on the page: configurable, default 10. */
export function carouselMaxItems(): number {
  return intEnv("CAROUSEL_MAX_ITEMS", 10, 2, 20);
}

/** The API reference says 3 collaborators, Metricool says 5: configurable, default 3. */
export function maxCollaborators(): number {
  return intEnv("IG_MAX_COLLABORATORS", 3, 1, 5);
}

/** A post this much past its time is not published automatically (spec §7). */
export function latePublishMaxMs(): number {
  return intEnv("LATE_PUBLISH_MAX_MIN", 15, 1, 24 * 60) * 60_000;
}

/** Per-workspace media storage quota; the tariff decision comes later. */
export function storageQuotaBytes(): number {
  const raw = (process.env.CONTENT_STORAGE_QUOTA_BYTES ?? "").trim();
  const n = raw ? Number(raw) : Number.NaN;
  return Number.isFinite(n) && n > 0 ? n : 5 * 1024 ** 3;
}

/** How long before scheduledAt the Meta container is created (spec FR-P3). */
export const PREPARE_LEAD_MS = { image: 30 * 60_000, video: 60 * 60_000 } as const;
export const CONTAINER_POLL_MS = 30_000;
export const CONTAINER_MAX_WAIT_MS = { image: 5 * 60_000, video: 20 * 60_000 } as const;
/** A Meta container expires after 24 h; never prepare earlier than this before the slot. */
export const CONTAINER_MAX_AGE_MS = 23 * 3_600_000;
export const FIRST_COMMENT_DELAY_MS = 10_000;
/** Signed media URLs handed to Meta live this long. */
export const SIGNED_URL_TTL_SEC = 24 * 3600;

/** Media acceptance limits (spec §3 and §5.1). */
export const MEDIA = {
  imageMaxUploadBytes: 30 * 1024 ** 2,
  videoMaxUploadBytes: 1024 ** 3,
  imagePreparedMaxBytes: 8 * 1024 ** 2,
  reelMaxBytes: 300 * 1024 ** 2,
  storyVideoMaxBytes: 100 * 1024 ** 2,
  imageMaxWidth: 1440,
  feedAspectMin: 0.8,
  feedAspectMax: 1.91,
  reelMinMs: 3_000,
  reelMaxMs: 15 * 60_000,
  storyMinMs: 3_000,
  storyMaxMs: 60_000,
  carouselVideoMaxMs: 60_000,
} as const;
