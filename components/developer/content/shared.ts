/**
 * Types, labels and pure helpers of the Content Scheduler (ETAP 13) screens.
 * Client-safe: no server imports except pure modules (validate.ts matrix,
 * time.ts, text.ts). The fetch helper is shared with Comment 2.0.
 */

import { FIELD_MATRIX, type FieldRules } from "@/lib/content/validate";
import type { PostStatusValue, PostTypeValue } from "@/lib/content/schema";
import { formatZoned, utcToZoned } from "@/lib/content/time";

export { jsonInit, requestJson, type JsonResult } from "@/components/developer/comments/shared";
import { countCaption } from "@/lib/content/text";
export { countCaption };
export { utcToZoned, zonedToUtc, formatZoned } from "@/lib/content/time";

export const CONTENT_API = "/api/developer/content";

export type { PostStatusValue, PostTypeValue };

export type CardTone = "success" | "warning" | "error" | "muted" | "scheduled" | "busy";

export const TYPE_LABEL: Record<PostTypeValue, string> = {
  FEED_IMAGE: "Post",
  FEED_VIDEO: "Video post",
  CAROUSEL: "Karusel",
  REEL: "Reels",
  TRIAL_REEL: "Trial Reels",
  STORY: "Story",
};

export const TYPE_ICON: Record<PostTypeValue, string> = {
  FEED_IMAGE: "▣",
  FEED_VIDEO: "▶",
  CAROUSEL: "▣▣",
  REEL: "▶",
  TRIAL_REEL: "▶?",
  STORY: "◯",
};

export const STATUS_LABEL: Record<PostStatusValue, string> = {
  DRAFT: "Draft",
  PENDING_REVIEW: "Tasdiq kutilmoqda",
  SCHEDULED: "Rejalashtirilgan",
  PAUSED: "Pauzada",
  PREPARING: "Tayyorlanmoqda",
  READY_TO_PUBLISH: "Tayyor, vaqt kutilmoqda",
  PUBLISHING: "Chiqarilmoqda",
  PUBLISHED: "Chiqdi",
  NEEDS_MANUAL: "Qo'lda e'lon kerak",
  PUBLISHED_MANUAL: "Qo'lda chiqarildi",
  FAILED: "Xato",
  REJECTED: "Rad etildi",
  EXPIRED_REVIEW: "Tasdiq muddati o'tdi",
  CANCELED: "Bekor qilindi",
};

export function postCardTone(status: PostStatusValue): CardTone {
  switch (status) {
    case "PUBLISHED":
    case "PUBLISHED_MANUAL":
      return "success";
    case "FAILED":
    case "REJECTED":
    case "EXPIRED_REVIEW":
      return "error";
    case "NEEDS_MANUAL":
    case "PENDING_REVIEW":
    case "PAUSED":
      return "warning";
    case "SCHEDULED":
      return "scheduled";
    case "PREPARING":
    case "READY_TO_PUBLISH":
    case "PUBLISHING":
      return "busy";
    default:
      return "muted";
  }
}

export const TONE_CLASS: Record<CardTone, string> = {
  success: "border-success/40 bg-success/10 text-success",
  warning: "border-warning/40 bg-warning/10 text-warning",
  error: "border-error/40 bg-error/10 text-error",
  muted: "border-border bg-surface text-muted opacity-70",
  scheduled: "border-primary/50 bg-primary/15 text-foreground",
  busy: "border-primary/30 bg-primary/10 text-muted",
};

export const DOT_CLASS: Record<CardTone, string> = {
  success: "bg-success",
  warning: "bg-warning",
  error: "bg-error",
  muted: "bg-muted",
  scheduled: "bg-primary",
  busy: "bg-primary/60",
};

/** Calendar bucket key = the wall-clock date in the workspace zone. Unscheduled posts are left out. */
export function groupPostsByDay<T extends { scheduledAt: string | Date | null }>(posts: T[], tz: string): Map<string, T[]> {
  const out = new Map<string, T[]>();
  for (const post of posts) {
    if (!post.scheduledAt) continue;
    const date = post.scheduledAt instanceof Date ? post.scheduledAt : new Date(post.scheduledAt);
    if (Number.isNaN(date.getTime())) continue;
    const key = utcToZoned(date, tz).date;
    const list = out.get(key) ?? [];
    list.push(post);
    out.set(key, list);
  }
  for (const list of out.values()) list.sort((a, b) => new Date(a.scheduledAt!).getTime() - new Date(b.scheduledAt!).getTime());
  return out;
}

export type ComposerMode = "draft" | "schedule" | "now";

export function composerButtonLabel(s: { mode: ComposerMode; at: Date | null; tz: string; canSchedule: boolean }): string {
  if (s.mode === "draft") return "Draft sifatida saqlash";
  if (!s.canSchedule) return "Tasdiqqa yuborish";
  if (s.mode === "now") return "Hozir chiqarish";
  return s.at ? `Rejalashtirish · ${formatZoned(s.at, s.tz)}` : "Rejalashtirish";
}

export type FieldKey = keyof Omit<FieldRules, "media" | "userTagCoords">;

export function fieldVisible(type: PostTypeValue, field: FieldKey): boolean {
  return FIELD_MATRIX[type][field] === true;
}

/**
 * FR-C2: the type follows the media. A video in a feed post becomes a video
 * post (Instagram publishes it as Reels), two or more files make a carousel,
 * an image in a video type becomes a feed image. Types whose media rule
 * already accepts the selection keep it.
 */
export function typeForMedia(current: PostTypeValue, kinds: string[]): PostTypeValue {
  if (kinds.length === 0) return current;
  if (current === "STORY" || current === "CAROUSEL") return current;
  if (kinds.length > 1) return "CAROUSEL";
  const kind = kinds[0];
  const allowed = FIELD_MATRIX[current].media.kinds as string[];
  if (allowed.includes(kind)) return current;
  return kind === "VIDEO" ? "FEED_VIDEO" : "FEED_IMAGE";
}

export interface ComposerLimits {
  captionChars: number;
  hashtags: number;
  mentions: number;
  firstCommentChars: number;
  altTextChars: number;
  carouselMax: number;
  maxCollaborators: number;
}

/**
 * FR-C3: why the main button is disabled, or null. Only the limits the
 * client can check without the server; the server's issues come on top.
 */
export function composerBlocked(draft: PostDraft, limits: ComposerLimits): string | null {
  if (!draft.instagramAccountId) return "Akkaunt tanlanmagan";
  const rule = FIELD_MATRIX[draft.type].media;
  if (draft.media.length === 0) return "Media tanlanmagan";
  const max = rule.max === "carousel" ? limits.carouselMax : rule.max;
  if (draft.media.length < rule.min) return `Kamida ${rule.min} ta media kerak`;
  if (draft.media.length > max) return `Ko'pi bilan ${max} ta media`;
  const notReady = draft.media.find((m) => m.status && m.status !== "READY");
  if (notReady) return "Media hali tayyor emas";
  if (fieldVisible(draft.type, "caption")) {
    const c = countCaption(draft.caption);
    if (c.chars > limits.captionChars) return `Caption ${limits.captionChars} belgidan oshdi`;
    if (c.hashtags > limits.hashtags) return `Hashtag ${limits.hashtags} tadan ko'p`;
    if (c.mentions > limits.mentions) return `@mention ${limits.mentions} tadan ko'p`;
  }
  if (fieldVisible(draft.type, "firstComment") && countCaption(draft.firstComment).chars > limits.firstCommentChars) return `Birinchi komment ${limits.firstCommentChars} belgidan oshdi`;
  if (fieldVisible(draft.type, "collaborators") && draft.collaborators.length > limits.maxCollaborators) return `Hammualliflar ${limits.maxCollaborators} tadan ko'p`;
  return null;
}

/**
 * FR-S1: the slot the schedule picker opens on. A clicked future day → 19:00
 * there; otherwise now + 30 min rounded up to five minutes, in the zone.
 */
export function defaultSlot(initialDate: string | null, tz: string, now: Date = new Date()): { date: string; time: string } {
  const today = utcToZoned(now, tz).date;
  if (initialDate && initialDate > today) return { date: initialDate, time: "19:00" };
  const step = 5 * 60_000;
  const t = Math.ceil((now.getTime() + 30 * 60_000) / step) * step;
  return utcToZoned(new Date(t), tz);
}

export function mediaRule(type: PostTypeValue): FieldRules["media"] {
  return FIELD_MATRIX[type].media;
}

export function tagCoords(type: PostTypeValue): FieldRules["userTagCoords"] {
  return FIELD_MATRIX[type].userTagCoords;
}

// ─── API shapes (mirror lib/content/service.ts, dates as ISO strings) ───────

export interface ContentMeta {
  disabled: boolean;
  me: { role: string; normalizedRole: string; roleLabel: string; canCreate: boolean; canSchedule: boolean; canApprove: boolean };
  accounts: Array<{ id: string; username: string; tokenStatus: string; canPublish: boolean; accountType: string | null; publishQuotaUsed: number | null }>;
  campaigns: Array<{ kind: "automation" | "trigger"; id: string; name: string; instagramAccountId: string; active: boolean; keywords: string[]; linkedPostId: string | null; bound: boolean }>;
  savedTexts: SavedText[];
  timezone: string;
  storage: { usedBytes: number; quotaBytes: number; configured: boolean; driver: string };
  telegramConnected: boolean;
  limits: { captionChars: number; hashtags: number; mentions: number; firstCommentChars: number; altTextChars: number; carouselMax: number; maxCollaborators: number };
}

export interface SavedText {
  id: string;
  title: string;
  body: string;
  tags: string[];
  updatedAt: string;
}

export interface UserTag {
  username: string;
  x?: number;
  y?: number;
}

export interface PostMediaView {
  id: string;
  mediaId: string;
  position: number;
  altText: string | null;
  userTags: UserTag[];
  cropRect: { x: number; y: number; w: number; h: number } | null;
  kind: string;
  status: string;
  width: number | null;
  height: number | null;
  durationMs: number | null;
  thumbUrl: string | null;
  previewUrl: string | null;
}

export interface PostCard {
  id: string;
  instagramAccountId: string;
  accountUsername: string | null;
  type: PostTypeValue;
  status: PostStatusValue;
  caption: string | null;
  scheduledAt: string | null;
  publishedAt: string | null;
  permalink: string | null;
  thumbUrl: string | null;
  mediaCount: number;
  linked: boolean;
  autoPublish: boolean;
  lastErrorCode: string | null;
  version: number;
}

export interface PostDetail {
  id: string;
  instagramAccountId: string;
  accountUsername: string | null;
  type: PostTypeValue;
  status: PostStatusValue;
  caption: string | null;
  firstComment: string | null;
  collaborators: string[];
  shareToFeed: boolean;
  coverMediaId: string | null;
  thumbOffsetMs: number | null;
  trialStrategy: string | null;
  audioName: string | null;
  locationId: string | null;
  isAiGenerated: boolean;
  autoPublish: boolean;
  manualReason: string | null;
  scheduledAt: string | null;
  timezone: string;
  igMediaId: string | null;
  permalink: string | null;
  publishedAt: string | null;
  firstCommentStatus: string | null;
  attempts: number;
  lastErrorCode: string | null;
  lastErrorMessage: string | null;
  labels: string[];
  version: number;
  createdAt: string;
  updatedAt: string;
  media: PostMediaView[];
  attemptsLog: Array<{ id: string; step: string; ok: boolean; metaCode: number | null; message: string | null; durationMs: number | null; createdAt: string }>;
  linkedCampaign: { kind: "automation" | "trigger"; id: string; name: string; keywords: string[]; active: boolean; waiting: boolean } | null;
  issues: Array<{ field: string; message: string }>;
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
  createdAt: string;
  usedByPostIds: string[];
}

export interface MediaItemDraft {
  mediaId: string;
  altText?: string;
  userTags?: UserTag[];
  /** Client-only, for previews. */
  thumbUrl?: string | null;
  previewUrl?: string | null;
  kind?: string;
  status?: string;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
}

export interface PostDraft {
  instagramAccountId: string;
  type: PostTypeValue;
  caption: string;
  firstComment: string;
  collaborators: string[];
  shareToFeed: boolean;
  coverMediaId: string | null;
  thumbOffsetMs: number | null;
  trialStrategy: "MANUAL" | "SS_PERFORMANCE" | null;
  isAiGenerated: boolean;
  autoPublish: boolean;
  manualReason: "STORY_STICKER" | "MUSIC" | "USER_CHOICE" | null;
  media: MediaItemDraft[];
  labels: string[];
  linkCampaign: { automationId?: string; triggerCampaignId?: string } | null;
}

export function emptyDraft(instagramAccountId: string, type: PostTypeValue = "FEED_IMAGE"): PostDraft {
  return {
    instagramAccountId,
    type,
    caption: "",
    firstComment: "",
    collaborators: [],
    shareToFeed: true,
    coverMediaId: null,
    thumbOffsetMs: null,
    trialStrategy: null,
    isAiGenerated: false,
    autoPublish: true,
    manualReason: null,
    media: [],
    labels: [],
    linkCampaign: null,
  };
}

export function draftOfDetail(d: PostDetail): PostDraft {
  return {
    instagramAccountId: d.instagramAccountId,
    type: d.type,
    caption: d.caption ?? "",
    firstComment: d.firstComment ?? "",
    collaborators: d.collaborators,
    shareToFeed: d.shareToFeed,
    coverMediaId: d.coverMediaId,
    thumbOffsetMs: d.thumbOffsetMs,
    trialStrategy: (d.trialStrategy as PostDraft["trialStrategy"]) ?? null,
    isAiGenerated: d.isAiGenerated,
    autoPublish: d.autoPublish,
    manualReason: (d.manualReason as PostDraft["manualReason"]) ?? null,
    media: d.media.map((m) => ({ mediaId: m.mediaId, altText: m.altText ?? undefined, userTags: m.userTags, thumbUrl: m.thumbUrl, previewUrl: m.previewUrl, kind: m.kind, status: m.status, width: m.width, height: m.height, durationMs: m.durationMs })),
    labels: d.labels,
    linkCampaign: d.linkedCampaign ? (d.linkedCampaign.kind === "automation" ? { automationId: d.linkedCampaign.id } : { triggerCampaignId: d.linkedCampaign.id }) : null,
  };
}

/** The body the API wants (client-only fields stripped). */
export function draftToBody(d: PostDraft) {
  return {
    instagramAccountId: d.instagramAccountId,
    type: d.type,
    caption: fieldVisible(d.type, "caption") ? d.caption : undefined,
    firstComment: fieldVisible(d.type, "firstComment") ? d.firstComment : undefined,
    collaborators: fieldVisible(d.type, "collaborators") ? d.collaborators : [],
    shareToFeed: d.shareToFeed,
    coverMediaId: fieldVisible(d.type, "cover") ? d.coverMediaId : null,
    thumbOffsetMs: fieldVisible(d.type, "cover") ? d.thumbOffsetMs : null,
    trialStrategy: fieldVisible(d.type, "trial") ? d.trialStrategy : null,
    isAiGenerated: d.isAiGenerated,
    autoPublish: d.autoPublish,
    manualReason: d.manualReason,
    media: d.media.map((m) => ({ mediaId: m.mediaId, altText: m.altText || undefined, userTags: m.userTags?.length ? m.userTags : undefined })),
    labels: d.labels,
    linkCampaign: d.linkCampaign,
  };
}

export function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function formatDuration(ms: number | null | undefined): string {
  if (!ms) return "";
  const s = Math.round(ms / 1000);
  return s >= 60 ? `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}` : `${s} s`;
}

export const WEEKDAYS = ["Du", "Se", "Ch", "Pa", "Ju", "Sh", "Ya"];
export const MONTHS = ["Yanvar", "Fevral", "Mart", "Aprel", "May", "Iyun", "Iyul", "Avgust", "Sentabr", "Oktabr", "Noyabr", "Dekabr"];

/** "2026-10-24" → the 6×7 grid of ISO dates of that month's calendar (Monday first). */
export function monthGrid(year: number, month0: number): string[] {
  const first = new Date(Date.UTC(year, month0, 1));
  const offset = (first.getUTCDay() + 6) % 7;
  const start = new Date(Date.UTC(year, month0, 1 - offset));
  return Array.from({ length: 42 }, (_, i) => new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10));
}

/** The Monday-to-Sunday week containing an ISO date. */
export function weekOf(isoDate: string): string[] {
  const d = new Date(`${isoDate}T00:00:00Z`);
  const offset = (d.getUTCDay() + 6) % 7;
  const start = new Date(d.getTime() - offset * 86_400_000);
  return Array.from({ length: 7 }, (_, i) => new Date(start.getTime() + i * 86_400_000).toISOString().slice(0, 10));
}

export function todayIso(tz: string): string {
  return utcToZoned(new Date(), tz).date;
}

/**
 * Upload one file: presign → PUT → complete, then poll until READY / FAILED.
 * Resolves with the asset row; rejects with an Uzbek message.
 */
export async function uploadFile(
  file: File,
  onProgress?: (pct: number) => void
): Promise<{ id: string; kind: string; status: string; thumbUrl: string | null; width: number | null; height: number | null; durationMs: number | null }> {
  const { requestJson, jsonInit } = await import("@/components/developer/comments/shared");
  const presign = await requestJson<{ mediaId: string; uploadUrl: string; headers: Record<string, string> }>(
    `${CONTENT_API}/media/presign`,
    jsonInit("POST", { fileName: file.name, mimeType: file.type || "application/octet-stream", sizeBytes: file.size })
  );
  if (!presign.ok) throw new Error(presign.error);
  await new Promise<void>((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open("PUT", presign.data.uploadUrl);
    for (const [k, v] of Object.entries(presign.data.headers)) {
      if (k.toLowerCase() === "content-length") continue;
      xhr.setRequestHeader(k, v);
    }
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable && onProgress) onProgress(Math.round((e.loaded / e.total) * 100));
    };
    xhr.onload = () => (xhr.status >= 200 && xhr.status < 300 ? resolve() : reject(new Error(`Yuklash xatosi (${xhr.status})`)));
    xhr.onerror = () => reject(new Error("Yuklash uzildi — internetni tekshiring"));
    xhr.send(file);
  });
  const complete = await requestJson<{ id: string; status: string }>(`${CONTENT_API}/media/${presign.data.mediaId}/complete`, jsonInit("POST", {}));
  if (!complete.ok) throw new Error(complete.error);
  // Poll the library until processing is done (the worker does the work).
  for (let i = 0; i < 120; i++) {
    await new Promise((r) => setTimeout(r, i < 10 ? 1500 : 4000));
    const list = await requestJson<{ items: MediaRow[] }>(`${CONTENT_API}/media?pageSize=200`);
    if (!list.ok) continue;
    const row = list.data.items.find((m) => m.id === presign.data.mediaId);
    if (!row) continue;
    if (row.status === "READY") return { id: row.id, kind: row.kind, status: row.status, thumbUrl: row.thumbUrl, width: row.width, height: row.height, durationMs: row.durationMs };
    if (row.status === "FAILED") throw new Error(row.error ?? "Fayl qayta ishlanmadi");
  }
  throw new Error("Fayl qayta ishlash juda uzoq davom etdi — kutubxonadan keyinroq tanlang");
}
