/**
 * Types, labels and the fetch helper shared by the Comment 2.0 screens.
 * Client-safe: no server imports.
 */

import type { DisplayTone } from "@/lib/triggers/display";
import type { FollowUpCondition, MatchingMode, QuickReplyAction, ReplyMode } from "@/lib/triggers/comment-limits";

export interface Account {
  id: string;
  username: string;
  tokenStatus: string;
}

export interface IntentOption {
  key: string;
  label: string;
  examples: string[];
}

/**
 * A short preview of an intent's vocabulary that shows every script (B-20):
 * Uzbek Latin first, then Cyrillic (uz / ru), so the list does not look Latin-only.
 */
export function intentExamplePreview(examples: string[], latin = 2, cyrillic = 3): string {
  const lat = examples.filter((e) => /^[a-z]/i.test(e)).slice(0, latin);
  const cyr = examples.filter((e) => /[Ѐ-ӿ]/.test(e)).slice(0, cyrillic);
  const picked = [...lat, ...cyr];
  return (picked.length ? picked : examples.slice(0, 5)).join(", ");
}

export interface SavedVariant {
  id: string;
  kind: "DM" | "PUBLIC";
  text: string;
  weight: number;
  source: "MANUAL" | "AI";
  approvedAt: string | null;
}

export interface SavedQuickReply {
  id: string;
  label: string;
  action: QuickReplyAction;
  responseText: string | null;
}

export interface SavedFollowUpStep {
  id: string;
  delayMinutes: number;
  condition: FollowUpCondition;
  message: string;
}

/** What the builder edits: the campaign row plus its child lists. */
export interface CommentCampaignView {
  id: string;
  name: string;
  instagramAccountId: string;
  /** Post comments, or comments under a live broadcast (ETAP 3). */
  triggerType: "COMMENT" | "LIVE_COMMENT";
  mediaScope: "ANY" | "SPECIFIC";
  mediaIds: string[];
  matchingMode: MatchingMode;
  keywords: string[];
  intents: string[];
  priority: number;
  replyMode: ReplyMode;
  publicReplyEnabled: boolean;
  openingButtonLabel: string | null;
  mainMessage: string | null;
  stopOnReply: boolean;
  stopOnLead: boolean;
  stopOnHandoff: boolean;
  stopOnPurchase: boolean;
  responseMessage: string;
  active: boolean;
  variants: SavedVariant[];
  quickReplies: SavedQuickReply[];
  followUpSteps: SavedFollowUpStep[];
}

export const MATCH_MODE_TEXT: Record<MatchingMode, { title: string; description: string }> = {
  CONTAINS: { title: "Kalit so'z bor", description: "Kommentda so'z uchrasa: “narx” → “narxi qancha?”" },
  EXACT: { title: "Aniq mos", description: "Komment aynan shu so'zning o'zi bo'lsa" },
  EVERY: { title: "Har bir komment", description: "Kalit so'zsiz — postdagi har bir kommentga" },
};

export const REPLY_MODE_TEXT: Record<ReplyMode, { title: string; description: string }> = {
  RANDOM: { title: "Tasodifiy", description: "Har safar variantlardan biri tasodifan" },
  SEQUENTIAL: { title: "Navbat bilan", description: "1, 2, 3, … keyin yana 1-dan" },
  WEIGHTED: { title: "Vaznli", description: "Vazni katta variant ko'proq tushadi" },
};

export const QUICK_REPLY_ACTION_TEXT: Record<QuickReplyAction, string> = {
  MESSAGE: "Xabar yuborish",
  LEAD_CAPTURE: "Telefon raqamini so'rash (lead)",
  HANDOFF: "Operatorga o'tkazish",
  AI: "JavobAI'ga topshirish",
};

export const FOLLOW_UP_CONDITION_TEXT: Record<FollowUpCondition, string> = {
  ALWAYS: "Har doim",
  NO_REPLY: "Odam hali yozmagan bo'lsa",
  NO_CLICK: "Tugmani bosmagan bo'lsa",
};

export const MATCH_KIND_TEXT: Record<string, string> = {
  EXACT: "Aniq kalit so'z",
  CONTAINS: "Kalit so'z bor",
  INTENT: "Intent (ma'no)",
  EVERY: "Har bir komment",
};

export const EXECUTION_STATUS: Record<string, { label: string; tone: DisplayTone }> = {
  PENDING: { label: "Navbatda", tone: "warning" },
  SENDING: { label: "Yuborilmoqda", tone: "warning" },
  SENT: { label: "Yuborildi", tone: "success" },
  RETRYING: { label: "Qayta urinadi", tone: "warning" },
  FAILED: { label: "Xato", tone: "error" },
  SKIPPED: { label: "O'tkazildi", tone: "muted" },
};

export const FOLLOW_UP_STATUS: Record<string, { label: string; tone: DisplayTone }> = {
  SCHEDULED: { label: "Rejada", tone: "warning" },
  SENDING: { label: "Yuborilmoqda", tone: "warning" },
  SENT: { label: "Yuborildi", tone: "success" },
  SKIPPED: { label: "O'tkazildi", tone: "muted" },
  CANCELLED: { label: "Bekor qilindi", tone: "muted" },
  FAILED: { label: "Xato", tone: "error" },
};

export const BACKTRACK_STATUS: Record<string, { label: string; tone: DisplayTone }> = {
  RUNNING: { label: "Ishlamoqda", tone: "warning" },
  DONE: { label: "Tugadi", tone: "success" },
  FAILED: { label: "Xato", tone: "error" },
};

/** 90 → "1 soat 30 daqiqa". */
export function formatDelay(minutes: number): string {
  if (!Number.isFinite(minutes) || minutes <= 0) return "—";
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h && m) return `${h} soat ${m} daqiqa`;
  if (h) return `${h} soat`;
  return `${m} daqiqa`;
}

export { jsonInit, requestJson, type JsonResult } from "@/lib/request-json";

let uidCounter = 0;
/** Stable React key for list rows that have no database id yet. */
export function uid(): string {
  uidCounter += 1;
  return `n${Date.now().toString(36)}${uidCounter}`;
}
