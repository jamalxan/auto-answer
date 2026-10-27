/**
 * Typical-error checks (audit "Tipik xatolar ro'yxati avtomatik tekshiriladi").
 * Pure: the analysis tags, the post facts and the account's best-times map
 * in, issue codes out. Every code has an owner-facing explanation.
 */

export interface ContentTags {
  hookType?: "savol" | "natija" | "muammo" | "shok" | "boshqa" | null;
  format?: "talking_head" | "b_roll" | "ekran_yozuvi" | "rasm" | "karusel" | "boshqa" | null;
  topic?: string | null;
  hasSubtitles?: boolean | null;
  hasCta?: boolean | null;
  /** The comment keyword the CTA asks for ("NARX"), if any. */
  ctaKeyword?: string | null;
  /** Second the hook starts (0 = right away). */
  hookStartSec?: number | null;
  firstFrameHasText?: boolean | null;
  /** Important text under Instagram's UI (bottom ~20 %, right edge). */
  textInUnsafeZone?: boolean | null;
  /** width / height of the video or image. */
  aspect?: number | null;
  durationSec?: number | null;
}

export type IssueCode = "hook_late" | "no_first_frame_text" | "no_subtitles" | "not_vertical" | "text_unsafe_zone" | "no_cta" | "keyword_unlinked" | "bad_time";

export const ISSUE_TEXT: Record<IssueCode, string> = {
  hook_late: "Hook 3 soniyadan keyin boshlanadi",
  no_first_frame_text: "Birinchi kadrda matn yo'q",
  no_subtitles: "Subtitr yo'q — ko'pchilik ovozsiz ko'radi",
  not_vertical: "Video 9:16 emas",
  text_unsafe_zone: "Muhim matn Instagram interfeysi ostida qolgan",
  no_cta: "CTA yo'q (nima qilish kerakligi aytilmagan)",
  keyword_unlinked: "Comment kalit so'zi kampaniyaga ulanmagan",
  bad_time: "Auditoriya faol bo'lmagan soatda chiqqan",
};

const NINE_SIXTEEN = 9 / 16;
export const BAD_TIME_SCORE = 0.35;

export interface CheckInput {
  isVideo: boolean;
  tags: ContentTags;
  /** Whether an active campaign answers this keyword on this post. */
  keywordLinked: boolean | null;
  /** The best-times score (0…1) of the publish slot, null when unknown. */
  slotScore: number | null;
}

export function runChecks(input: CheckInput): IssueCode[] {
  const { tags } = input;
  const issues: IssueCode[] = [];
  if (input.isVideo) {
    if (typeof tags.hookStartSec === "number" && tags.hookStartSec > 3) issues.push("hook_late");
    if (tags.firstFrameHasText === false) issues.push("no_first_frame_text");
    if (tags.hasSubtitles === false) issues.push("no_subtitles");
    if (typeof tags.aspect === "number" && Math.abs(tags.aspect - NINE_SIXTEEN) > 0.03) issues.push("not_vertical");
  }
  if (tags.textInUnsafeZone === true) issues.push("text_unsafe_zone");
  if (tags.hasCta === false) issues.push("no_cta");
  if (tags.ctaKeyword && input.keywordLinked === false) issues.push("keyword_unlinked");
  if (input.slotScore !== null && input.slotScore < BAD_TIME_SCORE) issues.push("bad_time");
  return issues;
}

const norm = (s: string) => s.trim().toLowerCase();

/** Does an active campaign (either engine) answer `keyword` on this media? */
export function keywordCovered(
  keyword: string,
  mediaId: string,
  automations: Array<{ isActive: boolean; postId: string | null; matchAnyPost: boolean; matchAnyWord: boolean; keywords: string[] }>,
  triggers: Array<{ active: boolean; mediaScope: string; mediaIds: string[]; keywords: string[] }>
): boolean {
  const k = norm(keyword);
  const automation = automations.some(
    (a) => a.isActive && (a.matchAnyPost || a.postId === mediaId) && (a.matchAnyWord || a.keywords.some((w) => norm(w) === k))
  );
  const trigger = triggers.some((t) => t.active && (t.mediaScope === "ANY" || t.mediaIds.includes(mediaId)) && t.keywords.some((w) => norm(w) === k));
  return automation || trigger;
}
