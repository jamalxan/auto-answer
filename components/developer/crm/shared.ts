/**
 * Types, labels and small helpers of the CRM (ETAP 5) screens.
 * Client-safe: no server imports. The fetch helper is shared with Comment 2.0.
 */

import type { DisplayTone } from "@/lib/triggers/display";

export { jsonInit, requestJson, uid, type JsonResult } from "@/components/developer/comments/shared";

export const CRM_API = "/api/developer/crm";

export type Temperature = "COLD" | "WARM" | "HOT" | "CUSTOMER" | "LOST";
export type ContactStatus = "NEW" | "ACTIVE" | "CUSTOMER" | "LOST" | "ARCHIVED";
export type StageKind = "OPEN" | "WON" | "LOST";
export type BroadcastStatus = "DRAFT" | "SCHEDULED" | "RUNNING" | "PAUSED" | "COMPLETED" | "CANCELLED" | "FAILED";
export type RecipientStatus = "PENDING" | "SENDING" | "SENT" | "SKIPPED" | "FAILED";
export type PermissionRole = "OWNER" | "ADMIN" | "MANAGER" | "OPERATOR" | "VIEWER";
export type Permission =
  | "manage_instagram"
  | "manage_campaigns"
  | "view_contacts"
  | "assign_leads"
  | "manage_billing"
  | "manage_ai"
  | "export_data"
  | "view_analytics";

// ─── /meta ────────────────────────────────────────────────────────────────────

export interface MetaAccount {
  id: string;
  username: string;
  tokenStatus: string;
}

export interface MetaMember {
  id: string;
  userId: string;
  name: string | null;
  email: string | null;
  role: string;
  normalizedRole: PermissionRole;
  roleLabel: string;
  telegramLinked: boolean;
}

export interface StageRow {
  id: string;
  pipelineId: string;
  name: string;
  sort: number;
  kind: StageKind;
  color: string | null;
  isEntry: boolean;
  dealCount?: number;
}

export interface PipelineRow {
  id: string;
  name: string;
  isDefault: boolean;
  stages: StageRow[];
}

export interface TagRow {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  contactCount: number;
  createdAt: string;
}

export interface FieldSpec {
  label: string;
  ops: string[];
  value: "string" | "number" | "none" | "any";
}

export interface Meta {
  disabled: boolean;
  me: { userId: string; memberId: string | null; role: string; normalizedRole: PermissionRole; permissions: Permission[]; canManage: boolean };
  accounts: MetaAccount[];
  members: MetaMember[];
  pipelines: PipelineRow[];
  tags: TagRow[];
  segments: { id: string; name: string; description: string | null; lastCount: number | null }[];
  fieldSpecs: Record<string, FieldSpec>;
  customFieldSpec: FieldSpec;
  labels: {
    status: Record<string, string>;
    temperature: Record<string, string>;
    source: Record<string, string>;
    stageKind: Record<string, string>;
    strategy: Record<string, string>;
    trigger: Record<string, string>;
    ineligibility: Record<string, string>;
    role: Record<string, string>;
    permission: Record<string, string>;
  };
  permissionMatrix: Record<PermissionRole, Record<Permission, boolean>>;
  broadcastDefaults: { throttlePerHour: number; frequencyCapHours: number; replyWindowHours: number; conversionWindowDays: number };
}

// ─── Contacts ─────────────────────────────────────────────────────────────────

export interface ContactTagLink {
  id: string;
  origin: string;
  tag: { id: string; name: string; slug: string; color: string | null };
}

export interface ContactDealLink {
  id: string;
  stageId: string;
  title: string;
  wonAt: string | null;
  lostAt: string | null;
  stage: { id: string; name: string; kind: StageKind; color: string | null };
}

export interface ContactRow {
  id: string;
  instagramAccountId: string;
  igUserId: string;
  username: string | null;
  name: string | null;
  phoneE164: string | null;
  email: string | null;
  language: string | null;
  source: string;
  status: ContactStatus;
  score: number;
  temperature: Temperature;
  hasAiState: boolean;
  firstInteractionAt: string | null;
  lastInteractionAt: string | null;
  lastInboundAt: string | null;
  lastOutboundAt: string | null;
  interactionCount: number;
  assignedMemberId: string | null;
  assignedAt: string | null;
  conversationId: string | null;
  optedOutAt: string | null;
  optOutReason: string | null;
  customFields: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
  tags: ContactTagLink[];
  deals: ContactDealLink[];
}

export interface ContactPage {
  items: ContactRow[];
  nextCursor: string | null;
  total: number;
}

export interface ContactTag {
  id: string;
  name: string;
  slug: string;
  color: string | null;
  origin: string;
  sourceRef: string | null;
  createdAt: string;
}

export interface TimelineItem {
  id: string;
  type: string;
  occurredAt: string;
  actorKind: string;
  title: string;
  body?: string | null;
  mid?: string | null;
  sourceTable: string;
  sourceId: string;
  payload?: Record<string, unknown> | null;
}

export interface TimelinePage {
  items: TimelineItem[];
  nextBefore: string | null;
  hasMore: boolean;
}

export interface ContactDetail {
  contact: ContactRow;
  tags: ContactTag[];
  timeline: TimelinePage;
  assignedMember: { id: string; name: string | null; email: string | null } | null;
  accountUsername: string | null;
}

// ─── Segments ─────────────────────────────────────────────────────────────────

export interface SegmentCondition {
  field: string;
  op: string;
  value?: string | number | boolean | Array<string | number>;
}

export interface SegmentFilter {
  v: 1;
  all: SegmentCondition[];
  any?: SegmentCondition[];
}

export interface SegmentRow {
  id: string;
  name: string;
  description: string | null;
  filter: SegmentFilter;
  lastCount: number | null;
  lastCountedAt: string | null;
  createdAt: string;
  updatedAt: string;
  sentence: string;
}

export interface SegmentPreview {
  count: number;
  limit: number;
  sentence: string;
  items: {
    id: string;
    username: string | null;
    name: string | null;
    phoneE164: string | null;
    status: string;
    temperature: string;
    score: number;
    hasAiState: boolean;
    lastInteractionAt: string | null;
    tags: string[];
  }[];
}

// ─── Pipeline ─────────────────────────────────────────────────────────────────

export interface KanbanDeal {
  id: string;
  contactId: string;
  stageId: string;
  leadId: string | null;
  title: string;
  stageEnteredAt: string;
  wonAt: string | null;
  lostAt: string | null;
  lostReason: string | null;
  assignedMemberId: string | null;
  contact: {
    id: string;
    username: string | null;
    name: string | null;
    phoneE164: string | null;
    score: number;
    temperature: Temperature;
    hasAiState: boolean;
    assignedMemberId: string | null;
    lastInteractionAt: string | null;
  };
}

export interface KanbanBoard {
  pipeline: { id: string; name: string; isDefault: boolean };
  /** `deals` is capped per column (newest first); `count` is the stage's real total. */
  columns: { stage: StageRow; deals: KanbanDeal[]; count: number }[];
  total: number;
}

// ─── Team / rules ─────────────────────────────────────────────────────────────

export interface TeamMember extends MetaMember {
  permissions: Permission[];
  activeAssignments: number;
  createdAt: string;
  canChange: boolean;
}

export interface TeamResponse {
  members: TeamMember[];
  permissions: Permission[];
  permissionLabels: Record<Permission, string>;
  roleLabels: Record<PermissionRole, string>;
  matrix: Record<PermissionRole, Record<Permission, boolean>>;
}

export interface AssignmentRule {
  id: string;
  name: string;
  active: boolean;
  priority: number;
  trigger: string;
  stageId: string | null;
  strategy: string;
  memberIds: string[];
  productKeywords: string[];
  rrCursor: number;
  onlyUnassigned: boolean;
  createdAt: string;
}

// ─── Broadcast ────────────────────────────────────────────────────────────────

export interface BroadcastCounters {
  total: number;
  eligible: number;
  sent: number;
  skipped: number;
  failed: number;
  replied: number;
  converted: number;
  pending: number;
}

export interface BroadcastView {
  id: string;
  name: string;
  instagramAccountId: string;
  accountUsername: string | null;
  segmentId: string | null;
  segmentName: string | null;
  audienceFilter: SegmentFilter;
  message: string;
  quickReplies: string[];
  status: BroadcastStatus;
  statusLabel: string;
  scheduledAt: string | null;
  startedAt: string | null;
  completedAt: string | null;
  throttlePerHour: number;
  frequencyCapHours: number;
  replyWindowHours: number;
  conversionWindowDays: number;
  counters: BroadcastCounters;
  lastError: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ReasonCount {
  reason: string;
  label: string;
  count: number;
}

export interface AudiencePreview {
  total: number;
  eligibleNow: number;
  evaluated: number;
  byReason: ReasonCount[];
  sample: {
    contactId: string;
    username: string | null;
    name: string | null;
    eligible: boolean;
    reason: string | null;
    label: string | null;
    windowClosesAt: string | null;
  }[];
}

export interface RecipientView {
  id: string;
  contactId: string;
  username: string | null;
  name: string | null;
  status: RecipientStatus;
  statusLabel: string;
  eligible: boolean;
  reason: string | null;
  reasonLabel: string | null;
  attempts: number;
  sentAt: string | null;
  error: string | null;
  repliedAt: string | null;
  convertedAt: string | null;
  conversionDealId: string | null;
}

export interface RecipientsPage {
  recipients: RecipientView[];
  nextCursor: number | null;
  byStatus: Record<RecipientStatus, number>;
  byReason: ReasonCount[];
}

// ─── Labels ───────────────────────────────────────────────────────────────────

export const TEMPERATURE_TEXT: Record<Temperature, { label: string; emoji: string; tone: DisplayTone }> = {
  COLD: { label: "Sovuq", emoji: "❄️", tone: "muted" },
  WARM: { label: "Iliq", emoji: "🌤", tone: "warning" },
  HOT: { label: "Hot", emoji: "🔥", tone: "error" },
  CUSTOMER: { label: "Mijoz", emoji: "✅", tone: "success" },
  LOST: { label: "Yo'qotilgan", emoji: "⛔", tone: "muted" },
};

export const STATUS_TEXT: Record<ContactStatus, { label: string; tone: DisplayTone }> = {
  NEW: { label: "Yangi", tone: "warning" },
  ACTIVE: { label: "Faol", tone: "success" },
  CUSTOMER: { label: "Mijoz", tone: "success" },
  LOST: { label: "Yo'qotilgan", tone: "muted" },
  ARCHIVED: { label: "Arxiv", tone: "muted" },
};

export const BROADCAST_STATUS_TEXT: Record<BroadcastStatus, { label: string; tone: DisplayTone }> = {
  DRAFT: { label: "Qoralama", tone: "muted" },
  SCHEDULED: { label: "Rejalashtirilgan", tone: "warning" },
  RUNNING: { label: "Yuborilmoqda", tone: "warning" },
  PAUSED: { label: "To'xtatilgan", tone: "warning" },
  COMPLETED: { label: "Yakunlandi", tone: "success" },
  CANCELLED: { label: "Bekor qilindi", tone: "muted" },
  FAILED: { label: "Xato", tone: "error" },
};

export const RECIPIENT_STATUS_TEXT: Record<RecipientStatus, { label: string; tone: DisplayTone }> = {
  PENDING: { label: "Navbatda", tone: "warning" },
  SENDING: { label: "Yuborilmoqda", tone: "warning" },
  SENT: { label: "Yuborildi", tone: "success" },
  SKIPPED: { label: "O'tkazildi", tone: "muted" },
  FAILED: { label: "Xato", tone: "error" },
};

export const OP_TEXT: Record<string, string> = {
  eq: "=",
  neq: "≠",
  in: "ichida",
  gte: "≥",
  lte: "≤",
  contains: "o'z ichiga oladi",
  within_days: "oxirgi N kun ichida",
  is_true: "ha",
  is_false: "yo'q",
};

export const ACTOR_TEXT: Record<string, string> = {
  CUSTOMER: "Mijoz",
  AI: "JavobAI",
  ASSISTANT: "JavobAI",
  OPERATOR: "Operator",
  AUTOMATION: "Avtomat",
  SYSTEM: "Tizim",
};

export const TIMELINE_ICON: Record<string, string> = {
  INBOUND_MESSAGE: "💬",
  MESSAGE_IN: "💬",
  AUTOMATION_REPLY: "⚙️",
  MESSAGE_OUT: "📤",
  AUTOMATION: "⚙️",
  AI_REPLY: "🤖",
  OPERATOR_REPLY: "🧑‍💼",
  FOLLOW_UP_SENT: "⏰",
  COMMENT: "📝",
  COMMENT_REPLY: "↩️",
  LEAD_CREATED: "🎯",
  LEAD_DELIVERED: "📨",
  SCORE_CHANGED: "📈",
  TEMPERATURE_CHANGED: "🌡",
  HANDOFF_OPENED: "🙋",
  HANDOFF_ACCEPTED: "🤝",
  HANDOFF_CLOSED: "✅",
  HANDOFF: "🙋",
  TAG_ADDED: "🏷",
  TAG_REMOVED: "🏷",
  STAGE_CHANGED: "📊",
  DEAL_CREATED: "📊",
  ASSIGNED: "👤",
  UNASSIGNED: "👤",
  FIELD_CHANGED: "✏️",
  NOTE: "🗒",
  BROADCAST_SENT: "📣",
  BROADCAST_SKIPPED: "🚫",
  BROADCAST_REPLIED: "💬",
  BROADCAST_CONVERTED: "🏆",
  OPT_OUT: "🔕",
};

export function contactLabel(c: { username?: string | null; name?: string | null; igUserId?: string | null }): string {
  if (c.username) return `@${c.username}`;
  if (c.name) return c.name;
  return c.igUserId ?? "—";
}

export function memberLabel(m: { name: string | null; email: string | null } | null | undefined): string {
  if (!m) return "—";
  return m.name || m.email || "—";
}

/** "2 soat oldin" style relative time for list rows; falls back to the date. */
export function formatRelative(value: string | null | undefined, now = Date.now()): string {
  if (!value) return "—";
  const t = new Date(value).getTime();
  if (Number.isNaN(t)) return "—";
  const diff = Math.max(0, now - t);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return "hozir";
  if (min < 60) return `${min} daqiqa oldin`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h} soat oldin`;
  const d = Math.floor(h / 24);
  if (d < 30) return `${d} kun oldin`;
  return new Date(value).toLocaleDateString("uz-UZ", { day: "2-digit", month: "2-digit", year: "numeric" });
}

/** The 24h Meta window: open when the person wrote less than 23h55m ago. */
export function windowState(lastInboundAt: string | null | undefined, now = Date.now()): { open: boolean; closesIn: string } {
  if (!lastInboundAt) return { open: false, closesIn: "" };
  const closes = new Date(lastInboundAt).getTime() + 24 * 3600_000 - 5 * 60_000;
  const left = closes - now;
  if (left <= 0) return { open: false, closesIn: "" };
  const h = Math.floor(left / 3600_000);
  const m = Math.floor((left % 3600_000) / 60_000);
  return { open: true, closesIn: h > 0 ? `${h} soat ${m} daqiqa` : `${m} daqiqa` };
}

/** ISO → value for <input type="datetime-local"> (local time). */
export function toLocalInput(iso: string | null | undefined): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function fromLocalInput(value: string): string | null {
  if (!value) return null;
  const d = new Date(value);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}
