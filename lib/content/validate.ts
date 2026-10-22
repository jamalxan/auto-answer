/**
 * ETAP 13 — the one place that knows what Instagram accepts for each post
 * type (spec §6). The composer and the server call the same function, so
 * the UI never promises what the API refuses. Pure: media facts are passed
 * in, nothing is read here.
 */

import { CONTENT_LIMITS, MEDIA } from "./config";
import type { PostInput, PostTypeValue } from "./schema";
import { countCaption, normalizeUsernames, USERNAME_RE } from "./text";

export interface ValidationIssue {
  /** "caption", "media", "media[2]", "media[0].userTags", "collaborators", "type", "scheduledAt" … */
  field: string;
  message: string;
}

export type MediaStatusValue = "UPLOADING" | "PROCESSING" | "READY" | "FAILED" | "DELETED";

export interface MediaFacts {
  id: string;
  kind: "IMAGE" | "VIDEO";
  status: MediaStatusValue;
  width?: number | null;
  height?: number | null;
  durationMs?: number | null;
  sizeBytes: number;
}

export interface FieldRules {
  caption: boolean;
  userTags: boolean;
  userTagCoords: "required" | "optional" | "none";
  collaborators: boolean;
  firstComment: boolean;
  altText: boolean;
  cover: boolean;
  shareToFeed: boolean;
  trial: boolean;
  location: boolean;
  aiFlag: boolean;
  /** Allowed asset kinds and how many. */
  media: { kinds: Array<"IMAGE" | "VIDEO">; min: number; max: number | "carousel" };
}

export const FIELD_MATRIX: Record<PostTypeValue, FieldRules> = {
  FEED_IMAGE: {
    caption: true, userTags: true, userTagCoords: "required", collaborators: true, firstComment: true,
    altText: true, cover: false, shareToFeed: false, trial: false, location: true, aiFlag: true,
    media: { kinds: ["IMAGE"], min: 1, max: 1 },
  },
  FEED_VIDEO: {
    caption: true, userTags: true, userTagCoords: "optional", collaborators: true, firstComment: true,
    altText: false, cover: true, shareToFeed: true, trial: false, location: true, aiFlag: true,
    media: { kinds: ["VIDEO"], min: 1, max: 1 },
  },
  CAROUSEL: {
    caption: true, userTags: true, userTagCoords: "required", collaborators: true, firstComment: true,
    altText: true, cover: false, shareToFeed: false, trial: false, location: true, aiFlag: true,
    media: { kinds: ["IMAGE", "VIDEO"], min: 2, max: "carousel" },
  },
  REEL: {
    caption: true, userTags: true, userTagCoords: "optional", collaborators: true, firstComment: true,
    altText: false, cover: true, shareToFeed: true, trial: false, location: true, aiFlag: true,
    media: { kinds: ["VIDEO"], min: 1, max: 1 },
  },
  TRIAL_REEL: {
    caption: true, userTags: true, userTagCoords: "optional", collaborators: true, firstComment: true,
    altText: false, cover: true, shareToFeed: false, trial: true, location: true, aiFlag: true,
    media: { kinds: ["VIDEO"], min: 1, max: 1 },
  },
  STORY: {
    caption: false, userTags: true, userTagCoords: "optional", collaborators: false, firstComment: false,
    altText: false, cover: false, shareToFeed: false, trial: false, location: false, aiFlag: true,
    media: { kinds: ["IMAGE", "VIDEO"], min: 1, max: 1 },
  },
};

export interface ValidateOptions {
  carouselMax: number;
  maxCollaborators: number;
  now?: Date;
}

const ratio = (w?: number | null, h?: number | null) => (w && h ? w / h : null);
const fmtSec = (ms: number) => `${Math.round(ms / 1000)} s`;

function mediaIssues(type: PostTypeValue, index: number, facts: MediaFacts | undefined, count: number): ValidationIssue[] {
  const field = `media[${index}]`;
  if (!facts) return [{ field, message: "Media topilmadi" }];
  if (facts.status !== "READY") {
    return [{ field, message: facts.status === "FAILED" ? "Media qayta ishlanmadi — boshqa fayl tanlang" : "Media hali tayyor emas" }];
  }
  const rules = FIELD_MATRIX[type];
  if (!rules.media.kinds.includes(facts.kind)) {
    return [{ field, message: facts.kind === "VIDEO" ? "Bu turda video bo'lmaydi" : "Bu turda rasm bo'lmaydi" }];
  }
  const out: ValidationIssue[] = [];
  if (facts.kind === "IMAGE") {
    const r = ratio(facts.width, facts.height);
    const needsFeedRatio = type === "FEED_IMAGE" || type === "CAROUSEL";
    if (needsFeedRatio && r !== null && (r < MEDIA.feedAspectMin - 0.005 || r > MEDIA.feedAspectMax + 0.005)) {
      out.push({
        field,
        message: `Rasm ${r.toFixed(2)}:1 nisbatda — Instagram 4:5 … 1.91:1 oralig'ini qabul qiladi. Kesing.`,
      });
    }
    if (facts.sizeBytes > MEDIA.imagePreparedMaxBytes) out.push({ field, message: "Rasm 8 MB dan katta" });
  } else {
    const d = facts.durationMs ?? 0;
    if (type === "STORY") {
      if (d < MEDIA.storyMinMs || d > MEDIA.storyMaxMs) out.push({ field, message: `Video ${fmtSec(d)} — story 3 s dan 60 s gacha bo'lishi kerak` });
      if (facts.sizeBytes > MEDIA.storyVideoMaxBytes) out.push({ field, message: "Story videosi 100 MB dan katta" });
    } else if (type === "CAROUSEL") {
      if (d < MEDIA.reelMinMs || d > MEDIA.carouselVideoMaxMs) out.push({ field, message: `Video ${fmtSec(d)} — karusel videosi 3 s dan 60 s gacha` });
      if (facts.sizeBytes > MEDIA.reelMaxBytes) out.push({ field, message: "Video 300 MB dan katta" });
    } else {
      if (d < MEDIA.reelMinMs || d > MEDIA.reelMaxMs) out.push({ field, message: `Video ${fmtSec(d)} — Reels 3 s dan 15 daqiqagacha` });
      if (facts.sizeBytes > MEDIA.reelMaxBytes) out.push({ field, message: "Video 300 MB dan katta" });
    }
  }
  void count;
  return out;
}

/**
 * Every rule of spec §6 for a post about to be saved or published. Returns
 * an empty list when the post can go to Instagram as is.
 */
export function validatePost(input: PostInput, media: MediaFacts[], opts: ValidateOptions): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const type = input.type;
  const rules = FIELD_MATRIX[type];
  const byId = new Map(media.map((m) => [m.id, m]));

  // Type vs. asset kind: a video in a FEED_IMAGE post can only be published as a reel.
  if (type === "FEED_IMAGE" && input.media.some((m) => byId.get(m.mediaId)?.kind === "VIDEO")) {
    issues.push({ field: "type", message: "Video feed post Reels sifatida chiqadi — turini Reels qiling" });
  }

  // Caption
  const caption = input.caption ?? "";
  if (!rules.caption) {
    if (caption.trim()) issues.push({ field: "caption", message: "Story'da caption yo'q" });
  } else {
    const c = countCaption(caption);
    if (c.chars > CONTENT_LIMITS.captionChars) issues.push({ field: "caption", message: `Caption ${c.chars} belgi — ${CONTENT_LIMITS.captionChars} dan oshmasin` });
    if (c.hashtags > CONTENT_LIMITS.hashtags) issues.push({ field: "caption", message: `${c.hashtags} ta hashtag — ko'pi bilan ${CONTENT_LIMITS.hashtags} ta` });
    if (c.mentions > CONTENT_LIMITS.mentions) issues.push({ field: "caption", message: `${c.mentions} ta @mention — ko'pi bilan ${CONTENT_LIMITS.mentions} ta` });
  }

  // First comment
  const firstComment = input.firstComment ?? "";
  if (firstComment.trim()) {
    if (!rules.firstComment) issues.push({ field: "firstComment", message: "Bu turda birinchi komment yo'q" });
    else {
      const c = countCaption(firstComment);
      if (c.chars > CONTENT_LIMITS.firstCommentChars) issues.push({ field: "firstComment", message: `Komment ${CONTENT_LIMITS.firstCommentChars} belgidan oshmasin` });
    }
  }

  // Collaborators
  const collaborators = input.collaborators ?? [];
  if (collaborators.length > 0) {
    if (!rules.collaborators) issues.push({ field: "collaborators", message: "Story'da hammualliflar yo'q" });
    else {
      const invalid = collaborators.map((c) => c.trim().replace(/^@+/, "")).filter((c) => !USERNAME_RE.test(c));
      if (invalid.length) issues.push({ field: "collaborators", message: `Noto'g'ri username: ${invalid.join(", ")}` });
      const clean = normalizeUsernames(collaborators);
      if (clean.length > opts.maxCollaborators) issues.push({ field: "collaborators", message: `Ko'pi bilan ${opts.maxCollaborators} ta hammuallif` });
    }
  }

  // Media count
  const max = rules.media.max === "carousel" ? opts.carouselMax : rules.media.max;
  if (input.media.length < rules.media.min || input.media.length > max) {
    issues.push({
      field: "media",
      message:
        type === "CAROUSEL"
          ? `Karuselda ${rules.media.min} dan ${max} tagacha element bo'ladi`
          : `Bu turda ${rules.media.min} ta media bo'ladi`,
    });
  }

  // Per-item rules
  input.media.forEach((item, index) => {
    const facts = byId.get(item.mediaId);
    issues.push(...mediaIssues(type, index, facts, input.media.length));
    if (item.userTags?.length) {
      if (!rules.userTags) issues.push({ field: `media[${index}].userTags`, message: "Bu turda odam belgilab bo'lmaydi" });
      else if (rules.userTagCoords === "required" && facts?.kind === "IMAGE" && item.userTags.some((t) => t.x === undefined || t.y === undefined)) {
        issues.push({ field: `media[${index}].userTags`, message: "Rasmda belgilangan odam uchun joy (x, y) kerak" });
      }
    }
    if (item.altText && (!rules.altText || facts?.kind === "VIDEO")) {
      issues.push({ field: `media[${index}].altText`, message: "Alt matn faqat rasmga qo'yiladi" });
    }
  });
  if (input.media.length === 0 && rules.media.min > 0) issues.push({ field: "media[0]", message: "Media tanlanmagan" });

  // Reels-only fields
  if ((input.coverMediaId || input.thumbOffsetMs != null) && !rules.cover) issues.push({ field: "cover", message: "Muqova faqat videoga qo'yiladi" });
  if (input.trialStrategy && !rules.trial) issues.push({ field: "trialStrategy", message: "Trial strategiyasi faqat Trial Reels uchun" });
  if (input.coverMediaId) {
    const cover = byId.get(input.coverMediaId);
    if (cover && cover.kind !== "IMAGE") issues.push({ field: "cover", message: "Muqova rasm bo'lishi kerak" });
  }
  if (input.locationId && !rules.location) issues.push({ field: "locationId", message: "Story'da joylashuv yo'q" });

  return issues;
}

/** FR-S1 / rule 7: at least 5 minutes ahead, at most a year. */
export function scheduleIssues(at: Date, now: Date = new Date()): ValidationIssue[] {
  const delta = at.getTime() - now.getTime();
  if (Number.isNaN(delta)) return [{ field: "scheduledAt", message: "Vaqt noto'g'ri" }];
  if (delta < CONTENT_LIMITS.minScheduleLeadMs) return [{ field: "scheduledAt", message: "Vaqt hozirdan kamida 5 daqiqa keyin bo'lsin" }];
  if (delta > CONTENT_LIMITS.maxScheduleAheadMs) return [{ field: "scheduledAt", message: "Bir yildan uzoqqa rejalashtirib bo'lmaydi" }];
  return [];
}

/** Which asset kind a post type publishes as (prepare lead time, container type). */
export function isVideoType(type: PostTypeValue, media: MediaFacts[]): boolean {
  if (type === "FEED_VIDEO" || type === "REEL" || type === "TRIAL_REEL") return true;
  return media.some((m) => m.kind === "VIDEO");
}
