/**
 * Types, labels and small helpers of the Engagement (ETAP 9) screens.
 * Client-safe: no server imports. The fetch helper is shared with Comment 2.0.
 */

import type { DisplayTone } from "@/lib/triggers/display";

export { jsonInit, requestJson, type JsonResult } from "@/components/developer/comments/shared";

export const ENGAGEMENT_API = "/api/developer/engagement";

export type PermissionRole = "OWNER" | "ADMIN" | "MANAGER" | "OPERATOR" | "VIEWER";

export interface Verifiability {
  label: string;
  verifiable: "yes" | "partly" | "best-effort" | "no";
  badge: string;
  note: string;
}

export interface GiveawayRules {
  version: 1;
  comment: { required: boolean; keyword?: string; mode: "CONTAINS" | "EXACT" | "ANY"; minLength: number };
  tagFriends: { required: boolean; min: number; distinct: boolean };
  mention: { required: boolean };
  follow: { required: boolean; onUnverifiable: "ALLOW" | "HOLD" | "EXCLUDE" };
  oneEntryPerPerson: boolean;
  excludeUsernames: string[];
  excludeStaff: boolean;
}

export interface Meta {
  disabled: boolean;
  me: {
    role: string;
    normalizedRole: PermissionRole;
    roleLabel: string;
    canManage: boolean;
    canExport: boolean;
  };
  accounts: Array<{ id: string; username: string; tokenStatus: string }>;
  campaigns: Array<{ id: string; name: string; instagramAccountId: string; active: boolean }>;
  verifiability: Record<string, Verifiability>;
  defaults: {
    rules: GiveawayRules;
    pointsRules: Record<string, { points: number; enabled: boolean }>;
    badgeRules: Array<{ key: string; name: string; threshold: number }>;
  };
  limits: { maxWindowDays: number; backfillCap: number; maxWinners: number; maxBackups: number };
  labels: { permission: Record<string, string>; pointReason: Record<string, string>; fraudFlag: Record<string, string> };
}

export type GiveawayStatus = "DRAFT" | "ACTIVE" | "CLOSED" | "DRAWN" | "ARCHIVED";
export type EntryStatus = "ELIGIBLE" | "INELIGIBLE" | "PENDING_CHECK" | "WINNER" | "DISQUALIFIED";

export interface GiveawayRow {
  id: string;
  instagramAccountId: string;
  accountUsername?: string | null;
  name: string;
  mediaId: string;
  mediaMeta: { permalink?: string; caption?: string; previewUrl?: string } | null;
  rules: GiveawayRules;
  windowStart: string;
  windowEnd: string;
  status: GiveawayStatus;
  winnersCount: number;
  backupCount: number;
  seedCommitment: string | null;
  committedAt: string | null;
  confirmCampaignId: string | null;
  backfillStatus: string | null;
  backfillScanned: number;
  backfillError: string | null;
  entriesCount: number;
  eligibleCount: number;
  pendingCount?: number;
  createdAt: string;
}

export interface EntryRow {
  id: string;
  igUserId: string;
  username: string | null;
  firstCommentText: string;
  firstCommentAt: string;
  commentCount: number;
  taggedUsernames: string[];
  followResult: "FOLLOWER" | "NOT_FOLLOWER" | "UNVERIFIABLE" | "NOT_CHECKED";
  checks: Record<string, { passed?: boolean; detail?: string }> | null;
  status: EntryStatus;
  ineligibleReason: string | null;
  disqualifyReason: string | null;
}

export interface DrawPerson {
  id: string;
  igUserId?: string;
  username?: string | null;
  firstCommentText?: string;
  status?: EntryStatus;
}

export interface DrawRow {
  id: string;
  sequence: number;
  algorithm: string;
  seedCommitment: string;
  seedRevealed: string;
  entrantsHash: string;
  entrantsCount: number;
  winnersCount: number;
  verification: string;
  status: "DRAWN" | "CONFIRMED" | "VOIDED";
  drawnAt: string;
  confirmedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  winners: DrawPerson[];
  backups: DrawPerson[];
}

export interface CommitmentInfo {
  entrantsCount: number;
  entrantsHash: string;
  changesAfterCommit: number;
}

export interface NotificationLine {
  channel: string;
  status: string;
  reason: string | null;
  createdAt: string;
}

export interface GiveawayDetail {
  giveaway: GiveawayRow;
  counts: Record<EntryStatus, number>;
  /** Live entrant list size / hash of a closed giveaway and owner decisions made after the commit. */
  commitment?: CommitmentInfo | null;
  draws: DrawRow[];
  notifications: Record<string, NotificationLine[]>;
  verifiability: Record<string, Verifiability>;
  backfill: { status: string | null; scanned: number; error: string | null };
}

export const GIVEAWAY_STATUS: Record<GiveawayStatus, { label: string; tone: DisplayTone }> = {
  DRAFT: { label: "Qoralama", tone: "muted" },
  ACTIVE: { label: "Faol", tone: "success" },
  CLOSED: { label: "Yopilgan", tone: "warning" },
  DRAWN: { label: "Qur'a tashlangan", tone: "success" },
  ARCHIVED: { label: "Arxiv", tone: "muted" },
};

export const ENTRY_STATUS: Record<EntryStatus, { label: string; tone: DisplayTone }> = {
  ELIGIBLE: { label: "Qabul qilindi", tone: "success" },
  INELIGIBLE: { label: "Mos emas", tone: "muted" },
  PENDING_CHECK: { label: "Tekshirilmoqda", tone: "warning" },
  WINNER: { label: "G'olib", tone: "success" },
  DISQUALIFIED: { label: "Chetlatilgan", tone: "error" },
};

export const FOLLOW_RESULT: Record<EntryRow["followResult"], { label: string; tone: DisplayTone }> = {
  FOLLOWER: { label: "Obunachi", tone: "success" },
  NOT_FOLLOWER: { label: "Obuna emas", tone: "error" },
  UNVERIFIABLE: { label: "Tasdiqlab bo'lmadi", tone: "warning" },
  NOT_CHECKED: { label: "Tekshirilmagan", tone: "muted" },
};

export const VERIFIABILITY_TONE: Record<Verifiability["verifiable"], DisplayTone> = {
  yes: "success",
  partly: "warning",
  "best-effort": "warning",
  no: "error",
};

export const CHANNEL_LABELS: Record<string, string> = {
  DM: "Direct xabar",
  PUBLIC_REPLY: "Ochiq javob",
  TELEGRAM: "Telegram (egasiga)",
};

export const NOTIFICATION_STATUS: Record<string, { label: string; tone: DisplayTone }> = {
  PENDING: { label: "Yuborilmoqda yoki noaniq", tone: "warning" },
  SENT: { label: "Yuborildi", tone: "success" },
  SKIPPED: { label: "O'tkazildi", tone: "muted" },
  FAILED: { label: "Xato", tone: "error" },
};

export const CHECK_LABELS: Record<string, string> = {
  comment: "Izoh",
  tagFriends: "Do'stlar",
  mention: "Story",
  follow: "Obuna",
};

export const ON_UNVERIFIABLE_TEXT: Record<GiveawayRules["follow"]["onUnverifiable"], { title: string; description: string }> = {
  HOLD: {
    title: "Menga ko'rsating (tavsiya)",
    description: "Instagram javob bermasa, ishtirokchi «Tekshirilmoqda» holatida turadi. Siz ko'rib chiqasiz yoki hammasini bir tugma bilan qabul qilasiz.",
  },
  ALLOW: { title: "Qabul qilish", description: "Tasdiqlab bo'lmasa ham qatnashchi hisoblanadi. Tez, lekin obuna bo'lmaganlar ham o'tib ketishi mumkin." },
  EXCLUDE: { title: "Chetlatish", description: "Tasdiqlab bo'lmasa qatnashchi hisoblanmaydi. Qat'iy, lekin haqiqiy obunachilar ham tushib qolishi mumkin." },
};

/** Value for <input type="datetime-local"> from an ISO string (local time). */
export function toLocalInput(value: string | Date): string {
  const d = new Date(value);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export const shortHash = (hash: string) => (hash.length > 20 ? `${hash.slice(0, 10)}…${hash.slice(-8)}` : hash);

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
