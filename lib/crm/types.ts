/**
 * ETAP 5 — CRM: shared types (TZ 27–33, 53).
 *
 * The pure modules in lib/crm work on the row shapes declared here; the DB
 * layer (contacts / pipeline / sync / timeline) maps Prisma rows onto them.
 * The string unions mirror the Prisma enums of prisma/schema.prisma 1:1 (same
 * value names, so rows are assignable without mapping); the timeline unions
 * are a superset that also names feed-only kinds. Every union has an Uzbek
 * label map for the developer UI.
 */

// ─── Roles (TZ 53) ────────────────────────────────────────────────────────────

/**
 * Planned WorkspaceRole: OWNER / ADMIN / MANAGER / OPERATOR / VIEWER.
 * MEMBER stays as the legacy alias of OPERATOR until the enum migration.
 */
export type WorkspaceRole = "OWNER" | "ADMIN" | "MANAGER" | "OPERATOR" | "MEMBER" | "VIEWER";

export const WORKSPACE_ROLES: WorkspaceRole[] = ["OWNER", "ADMIN", "MANAGER", "OPERATOR", "MEMBER", "VIEWER"];

// ─── Contact ──────────────────────────────────────────────────────────────────

/** Mirrors JavobAI's AiTemperature; "—" in the UI when the contact has no JavobAI state. */
export type CrmTemperature = "COLD" | "WARM" | "HOT" | "CUSTOMER" | "LOST";

export const TEMPERATURE_LABELS: Record<CrmTemperature, string> = {
  COLD: "Sovuq",
  WARM: "Iliq",
  HOT: "Hot",
  CUSTOMER: "Mijoz",
  LOST: "Yo'qotilgan",
};

/** Lifecycle of the contact itself (not of a deal). */
export type CrmContactStatus = "NEW" | "ACTIVE" | "CUSTOMER" | "LOST" | "ARCHIVED";

export const CONTACT_STATUS_LABELS: Record<CrmContactStatus, string> = {
  NEW: "Yangi",
  ACTIVE: "Faol",
  CUSTOMER: "Mijoz",
  LOST: "Yo'qotilgan",
  ARCHIVED: "Arxiv",
};

/** Which store first saw the person. */
export type CrmContactSource = "COMMENT" | "STORY" | "DM" | "AD" | "LINK" | "BROADCAST" | "IMPORT" | "UNKNOWN";

export const CONTACT_SOURCE_LABELS: Record<CrmContactSource, string> = {
  COMMENT: "Izoh",
  STORY: "Story",
  DM: "Direct",
  AD: "Reklama",
  LINK: "Havola",
  BROADCAST: "Broadcast",
  IMPORT: "Import",
  UNKNOWN: "Noma'lum",
};

/**
 * Denormalised summary row of `CrmContact`. Unique per
 * (instagramAccountId, igUserId); messages are never copied here.
 */
export interface CrmContactSummary {
  id: string;
  workspaceId: string;
  instagramAccountId: string;
  igUserId: string;
  igUsername: string | null;
  name: string | null;
  phoneE164: string | null;
  email: string | null;
  language: string | null;
  source: CrmContactSource;
  status: CrmContactStatus;
  /** null = no JavobAI state yet (shown as "—"). */
  score: number | null;
  temperature: CrmTemperature | null;
  assignedMemberId: string | null;
  conversationId: string | null;
  triggerContactId: string | null;
  lastInboundAt: Date | null;
  lastOutboundAt: Date | null;
  lastInteractionAt: Date | null;
  optedOutAt: Date | null;
  customFields: Record<string, unknown>;
  /** Reserved for the cross-account merge; always null for now. */
  mergedIntoId: string | null;
  createdAt: Date;
  updatedAt: Date;
}

// ─── Tags ─────────────────────────────────────────────────────────────────────

export type CrmTagOrigin = "MANUAL" | "AI" | "AUTOMATION" | "SYSTEM";

export const TAG_ORIGIN_LABELS: Record<CrmTagOrigin, string> = {
  MANUAL: "Qo'lda",
  AI: "JavobAI",
  AUTOMATION: "Avtomatlashtirish",
  SYSTEM: "Tizim",
};

export interface CrmTagRow {
  id: string;
  workspaceId: string;
  name: string;
  slug: string;
  color: string;
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export type CrmStageKind = "OPEN" | "WON" | "LOST";

export const STAGE_KIND_LABELS: Record<CrmStageKind, string> = {
  OPEN: "Jarayonda",
  WON: "Yutildi",
  LOST: "Yo'qotildi",
};

export interface CrmStageRow {
  id: string;
  pipelineId: string;
  name: string;
  kind: CrmStageKind;
  isEntry: boolean;
  sort: number;
  color: string;
}

// ─── Assignment (TZ 31, 53) ───────────────────────────────────────────────────

export type CrmAssignmentStrategy = "ROUND_ROBIN" | "TEAM" | "SPECIALIST";

export const ASSIGNMENT_STRATEGY_LABELS: Record<CrmAssignmentStrategy, string> = {
  ROUND_ROBIN: "Navbat bilan (round robin)",
  TEAM: "Jamoa ichida navbat bilan",
  SPECIALIST: "Mahsulot mutaxassisi",
};

export type CrmAssignmentTrigger = "ON_HOT" | "ON_LEAD" | "ON_HANDOFF" | "ON_STAGE" | "MANUAL";

export const ASSIGNMENT_TRIGGER_LABELS: Record<CrmAssignmentTrigger, string> = {
  ON_HOT: "Kontakt HOT bo'lganda",
  ON_LEAD: "Yangi lead kelganda",
  ON_HANDOFF: "Operatorga o'tganda",
  ON_STAGE: "Bosqichga o'tganda",
  MANUAL: "Qo'lda",
};

/** `CrmAssignmentRule` row as the assignment logic reads it. */
export interface CrmAssignmentRuleRow {
  id: string;
  workspaceId: string;
  name: string;
  active: boolean;
  trigger: CrmAssignmentTrigger;
  strategy: CrmAssignmentStrategy;
  /** Only for ON_STAGE. */
  stageId: string | null;
  /** Ordered member ids the rule rotates over (team / specialists); empty = every operator. */
  memberIds: string[];
  /** SPECIALIST only: matched with normalizeForMatch against product, lead product and tags. */
  productKeywords: string[];
  /** Higher wins; ties → older rule. */
  priority: number;
  /** Atomic round-robin cursor (index into memberIds / candidates). */
  cursor: number;
  createdAt: Date;
}

// ─── Activity / timeline (TZ 32) ──────────────────────────────────────────────

/** Prisma's `CrmActivityType` 1:1 — what a `CrmActivity` row may hold. */
export const CRM_ACTIVITY_TYPES = [
  "INBOUND_MESSAGE",
  "AUTOMATION_REPLY",
  "AI_REPLY",
  "OPERATOR_REPLY",
  "FOLLOW_UP_SENT",
  "LEAD_CREATED",
  "LEAD_DELIVERED",
  "SCORE_CHANGED",
  "TEMPERATURE_CHANGED",
  "HANDOFF_OPENED",
  "HANDOFF_ACCEPTED",
  "HANDOFF_CLOSED",
  "TAG_ADDED",
  "TAG_REMOVED",
  "STAGE_CHANGED",
  "DEAL_CREATED",
  "ASSIGNED",
  "UNASSIGNED",
  "FIELD_CHANGED",
  "NOTE",
  "BROADCAST_SENT",
  "BROADCAST_SKIPPED",
  "BROADCAST_REPLIED",
  "BROADCAST_CONVERTED",
  "OPT_OUT",
] as const;

export type CrmActivityRowType = (typeof CRM_ACTIVITY_TYPES)[number];

/**
 * Timeline vocabulary: the stored activity types plus the kinds that only
 * exist in the merged feed (read live from the message stores, never written
 * to `CrmActivity`): COMMENT / COMMENT_REPLY (InstagramEvent, TriggerExecution),
 * MESSAGE_IN / MESSAGE_OUT (legacy aliases of INBOUND_MESSAGE / AUTOMATION_REPLY),
 * AUTOMATION and HANDOFF (legacy aliases).
 */
export type CrmActivityType =
  | CrmActivityRowType
  | "COMMENT"
  | "COMMENT_REPLY"
  | "MESSAGE_IN"
  | "MESSAGE_OUT"
  | "AUTOMATION"
  | "HANDOFF";

export const ACTIVITY_TYPE_LABELS: Record<CrmActivityType, string> = {
  INBOUND_MESSAGE: "Kiruvchi xabar",
  AUTOMATION_REPLY: "Avtomatik javob",
  AI_REPLY: "JavobAI javobi",
  OPERATOR_REPLY: "Operator javobi",
  FOLLOW_UP_SENT: "Follow-up yuborildi",
  LEAD_CREATED: "Lead yaratildi",
  LEAD_DELIVERED: "Lead yetkazildi",
  SCORE_CHANGED: "Ball o'zgardi",
  TEMPERATURE_CHANGED: "Harorat o'zgardi",
  HANDOFF_OPENED: "Operatorga o'tish so'raldi",
  HANDOFF_ACCEPTED: "Operator qabul qildi",
  HANDOFF_CLOSED: "Operator suhbatni yopdi",
  TAG_ADDED: "Teg qo'shildi",
  TAG_REMOVED: "Teg olib tashlandi",
  STAGE_CHANGED: "Bosqich o'zgardi",
  DEAL_CREATED: "Bitim yaratildi",
  ASSIGNED: "Operator biriktirildi",
  UNASSIGNED: "Operator bo'shatildi",
  FIELD_CHANGED: "Maydon o'zgardi",
  NOTE: "Izoh (eslatma)",
  BROADCAST_SENT: "Broadcast yuborildi",
  BROADCAST_SKIPPED: "Broadcast o'tkazib yuborildi",
  BROADCAST_REPLIED: "Broadcast'ga javob berdi",
  BROADCAST_CONVERTED: "Broadcast konversiyasi",
  OPT_OUT: "Obunadan chiqdi",
  COMMENT: "Izoh",
  COMMENT_REPLY: "Izohga javob",
  MESSAGE_IN: "Kiruvchi xabar",
  MESSAGE_OUT: "Chiquvchi xabar",
  AUTOMATION: "Avtomatlashtirish",
  HANDOFF: "Operatorga o'tish",
};

/** Prisma's `CrmActorKind` 1:1 — who a `CrmActivity` row is attributed to. */
export type CrmActorKind = "SYSTEM" | "AI" | "AUTOMATION" | "OPERATOR";

/** Timeline actors: the stored kinds plus CUSTOMER (live message stores) and the legacy ASSISTANT alias of AI. */
export type CrmActivityActor = CrmActorKind | "CUSTOMER" | "ASSISTANT";

export const ACTIVITY_ACTOR_LABELS: Record<CrmActivityActor, string> = {
  CUSTOMER: "Mijoz",
  AI: "JavobAI",
  ASSISTANT: "JavobAI",
  OPERATOR: "Operator",
  AUTOMATION: "Avtomatlashtirish",
  SYSTEM: "Tizim",
};

/** Stores the merged timeline reads from (messages stay in place, never copied). */
export type TimelineSourceTable =
  | "ConversationMessage"
  | "TriggerMessage"
  | "TriggerExecution"
  | "TriggerFollowUpRun"
  | "DmLog"
  | "Lead"
  | "LeadDelivery"
  | "InstagramEvent"
  | "AiHandoff"
  | "AiScoreEvent"
  | "CrmActivity";

// ─── Broadcast (TZ 33) ────────────────────────────────────────────────────────

/** Prisma's `CrmBroadcastStatus` 1:1. */
export type CrmBroadcastStatus = "DRAFT" | "SCHEDULED" | "RUNNING" | "PAUSED" | "COMPLETED" | "CANCELLED" | "FAILED";

export const BROADCAST_STATUS_LABELS: Record<CrmBroadcastStatus, string> = {
  DRAFT: "Qoralama",
  SCHEDULED: "Rejalashtirilgan",
  RUNNING: "Yuborilmoqda",
  PAUSED: "To'xtatilgan",
  COMPLETED: "Yakunlandi",
  CANCELLED: "Bekor qilindi",
  FAILED: "Xato",
};

/**
 * Prisma's `CrmRecipientStatus` 1:1. "Not eligible" is SKIPPED with
 * `ineligibleReason`; replies / conversions are `repliedAt` / `convertedAt`.
 */
export type CrmRecipientStatus = "PENDING" | "SENDING" | "SENT" | "SKIPPED" | "FAILED";

export const RECIPIENT_STATUS_LABELS: Record<CrmRecipientStatus, string> = {
  PENDING: "Navbatda",
  SENDING: "Yuborilmoqda",
  SENT: "Yuborildi",
  SKIPPED: "O'tkazib yuborildi",
  FAILED: "Xato",
};

/** Why a recipient is not eligible at send time (stored in the snapshot, shown in the UI). */
export type IneligibilityReason =
  | "WINDOW_CLOSED"
  | "NO_INBOUND"
  | "OPTED_OUT"
  | "FREQUENCY_CAP"
  | "OPERATOR_ACTIVE"
  | "TOKEN_BROKEN"
  | "SUSPENDED"
  | "DUPLICATE";

export const INELIGIBILITY_REASONS: IneligibilityReason[] = [
  "SUSPENDED",
  "TOKEN_BROKEN",
  "NO_INBOUND",
  "WINDOW_CLOSED",
  "OPTED_OUT",
  "FREQUENCY_CAP",
  "OPERATOR_ACTIVE",
  "DUPLICATE",
];

export const INELIGIBILITY_LABELS: Record<IneligibilityReason, string> = {
  WINDOW_CLOSED: "24 soatlik oyna yopilgan",
  NO_INBOUND: "Mijoz hali yozmagan",
  OPTED_OUT: "Obunadan chiqqan",
  FREQUENCY_CAP: "Yaqinda broadcast olgan",
  OPERATOR_ACTIVE: "Operator bilan suhbatda",
  TOKEN_BROKEN: "Instagram ulanishi uzilgan",
  SUSPENDED: "Workspace to'xtatilgan",
  DUPLICATE: "Ro'yxatda takrorlangan",
};

/** Mirrors `AiHandoffState`; HANDOFF_PENDING / OPERATOR_ACTIVE count as "in a handoff". */
export type CrmHandoffState = "AI_ACTIVE" | "HANDOFF_PENDING" | "OPERATOR_ACTIVE" | "CLOSED";

/** Mirrors `TokenStatus` on InstagramAccount. */
export type CrmTokenStatus = "ACTIVE" | "BROKEN";
