/**
 * Comment Automation 2.0 limits, shared by the service (validation) and the
 * builder UI (counters, disabled buttons). Pure constants: safe in a client
 * bundle.
 *
 * Where a number comes from Meta it says so — those are not ours to raise.
 */

export const COMMENT_LIMITS = {
  nameLength: 120,
  keywords: 50,
  keywordLength: 60,
  mediaIds: 100,
  priorityMin: -100,
  priorityMax: 100,
  // Meta: DM text max 1000 characters.
  messageLength: 1000,
  // Meta: a button template's text max 640 characters. With an opening button
  // the private reply (DM variants, fallback text) goes out as one.
  buttonTemplateTextLength: 640,
  // A public comment reply is read under the post: keep it short.
  publicReplyLength: 300,
  // TZ 9: 3–10 variants. Fewer than 3 is allowed but the UI warns.
  variantsPerKind: 10,
  variantsRecommended: 3,
  weightMin: 1,
  weightMax: 100,
  // Meta: button title max 20 characters.
  buttonLabelLength: 20,
  // Meta: max 13 quick replies, title max 20 characters.
  quickReplies: 13,
  quickReplyLabelLength: 20,
  followUpSteps: 5,
  // Meta's 24-hour window: the last follow-up must leave room before it closes.
  followUpMaxDelayMinutes: 1380,
  // Meta: a private reply is allowed within 7 days of the comment.
  backtrackMaxDays: 7,
  aiMinCount: 3,
  aiMaxCount: 10,
} as const;

/** Max length of the private reply: shorter when it carries the opening button. */
export function privateReplyLimit(hasOpeningButton: boolean): number {
  return hasOpeningButton ? COMMENT_LIMITS.buttonTemplateTextLength : COMMENT_LIMITS.messageLength;
}

/** Uzbek explanation shown when a private reply is too long for the button template. */
export function buttonTemplateTooLong(what: string): string {
  return `${what} ${COMMENT_LIMITS.buttonTemplateTextLength} belgidan oshmasin: tugmali xabar Meta'ning "button template" shabloni bilan yuboriladi va u ${COMMENT_LIMITS.buttonTemplateTextLength} belgidan uzun matnni qabul qilmaydi.`;
}

export const MATCHING_MODES = ["EVERY", "CONTAINS", "EXACT"] as const;
export const REPLY_MODES = ["RANDOM", "SEQUENTIAL", "WEIGHTED"] as const;
export const QUICK_REPLY_ACTIONS = ["MESSAGE", "LEAD_CAPTURE", "HANDOFF"] as const;
export const FOLLOW_UP_CONDITIONS = ["ALWAYS", "NO_REPLY", "NO_CLICK"] as const;
export const EXECUTION_STATUSES = ["PENDING", "SENDING", "SENT", "RETRYING", "FAILED", "SKIPPED"] as const;
export const FOLLOW_UP_STATUSES = ["SCHEDULED", "SENDING", "SENT", "SKIPPED", "CANCELLED", "FAILED"] as const;

export type MatchingMode = (typeof MATCHING_MODES)[number];
export type ReplyMode = (typeof REPLY_MODES)[number];
export type QuickReplyAction = (typeof QUICK_REPLY_ACTIONS)[number];
export type FollowUpCondition = (typeof FOLLOW_UP_CONDITIONS)[number];
