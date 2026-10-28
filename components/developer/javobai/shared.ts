/**
 * Types, labels and small helpers of the JavobAI (ETAP 4) screens.
 * Client-safe: no server imports. The fetch helper is shared with Comment 2.0.
 */

import type { DisplayTone } from "@/lib/triggers/display";

export { jsonInit, requestJson, uid } from "@/components/developer/comments/shared";

export const JAVOBAI_API = "/api/javobai";

export type JavobAiMode = "OFF" | "SHADOW" | "LIVE";
export type HandoffState = "AI_ACTIVE" | "HANDOFF_PENDING" | "OPERATOR_ACTIVE" | "CLOSED";
export type Temperature = "COLD" | "WARM" | "HOT" | "CUSTOMER" | "LOST";
export type KnowledgeKind = "DISCOUNT" | "CONTACT" | "TERMS" | "BRANCH" | "POLICY" | "OTHER" | "PRICE" | "HOURS" | "DELIVERY";
export type RuleKind = "KEYWORD" | "INTENT" | "SCORE" | "UNKNOWN_COUNT" | "OFF_HOURS";
export type QualificationField = "product" | "budget" | "location";

export interface AccountConfig {
  confidenceThreshold: number;
  unknownStreakForHandoff: number;
  qualificationQuestions: QualificationField[];
  maxTurns: number;
  askPhoneAtTemperature: "WARM" | "HOT";
  postHandoffReplies: number;
  resumeAfterCloseHours: number;
  isTest: boolean;
  ladderEnabled: boolean;
  escalateAfterMinutes: number;
  hideOffensiveComments: boolean;
  notifyCommentComplaints: boolean;
}

export interface ProfileStatus {
  exists: boolean;
  /** approved AND enabled — what LIVE needs. */
  live: boolean;
  /** The assistant page's "Tasdiqlangan" (approvedAt set). */
  approved?: boolean;
  /** The assistant page's on/off switch. */
  enabled?: boolean;
  scope: "account" | "workspace" | null;
  id: string | null;
  companyName: string | null;
  products?: number;
  faqs?: number;
}

export interface AccountView {
  id: string;
  username: string;
  tokenStatus: string;
  mode: JavobAiMode;
  config: AccountConfig;
  enabledBy: string | null;
  updatedAt: string | null;
  profile: ProfileStatus;
}

export interface ScoreSignal {
  key: string;
  label: string;
  defaultPoints: number;
}

export interface AccountsResponse {
  accounts: AccountView[];
  disabled: boolean;
  defaults: AccountConfig;
  qualificationFields: QualificationField[];
  signals: ScoreSignal[];
}

export interface KnowledgeEntry {
  id: string;
  kind: KnowledgeKind;
  title: string;
  body: string;
  verifiedAt: string | null;
  active: boolean;
  sort: number;
}

export interface KnowledgePreview {
  lines: { id: string; kind: string; text: string }[];
  chars: number;
  truncated: boolean;
}

export interface ScoringConfig {
  rules: { signal: string; points: number }[];
  thresholds: { warm: number; hot: number; veryHot: number };
  handoffAtScore: number | null;
  lostAfterDays: number | null;
}

export type RuleValue =
  | { keywords: string[] }
  | { intents: string[] }
  | { min: number }
  | { count: number }
  | { from: string; to: string };

export interface HandoffRule {
  id: string;
  kind: RuleKind;
  value: RuleValue;
  active: boolean;
  createdAt: string;
}

export interface ConversationRow {
  id: string;
  igUserId: string;
  igUsername: string | null;
  igName: string | null;
  instagramAccountId: string;
  accountUsername: string;
  botPaused: boolean;
  handoffState: HandoffState;
  score: number;
  temperature: Temperature;
  turns: number;
  unknownStreak: number;
  lastMessage: { author: string; text: string; createdAt: string } | null;
  lastCustomerMessageAt: string | null;
  updatedAt: string;
}

export interface ConversationMessage {
  id: string;
  author: "CUSTOMER" | "ASSISTANT" | "OPERATOR" | "SYSTEM";
  text: string;
  createdAt: string;
  llmMeta: Record<string, unknown> | null;
}

export interface LeadInsight {
  score: number;
  temperature: Temperature;
  email: string | null;
  budget: string | null;
  location: string | null;
  signals: { signal: string; points: number }[];
  isTest: boolean;
}

export interface ConversationDetail {
  id: string;
  igUserId: string;
  igUsername: string | null;
  igName: string | null;
  accountUsername: string;
  botPaused: boolean;
  operatorActiveUntil: string | null;
  assistantState: string;
  messages: ConversationMessage[];
  state: {
    handoffState: HandoffState;
    score: number;
    temperature: Temperature;
    summary: string;
    extracted: Record<string, unknown>;
    context: Record<string, unknown>;
    unknownStreak: number;
    turns: number;
    leadCycle: number;
    updatedAt: string;
    scoreEvents: { id: string; leadCycle: number; signal: string; points: number; createdAt: string }[];
  } | null;
  handoffs: {
    id: string;
    reason: string;
    status: "OPEN" | "ACCEPTED" | "CLOSED";
    openedAt: string;
    acceptedAt: string | null;
    acceptedBy: string | null;
    closedAt: string | null;
    closedBy: string | null;
    resumeAi: boolean;
  }[];
  lead: {
    id: string;
    name: string | null;
    phoneE164: string | null;
    productInterest: string | null;
    summary: string | null;
    isTest: boolean;
    status: string;
    createdAt: string;
    aiInsight: LeadInsight | null;
  } | null;
}

export interface ShadowTurn {
  id: string;
  conversationId: string | null;
  customerText: string;
  productionReply: string | null;
  aiReply: string | null;
  intent: string | null;
  confidence: number | null;
  score: number | null;
  handoff: string | null;
  costUsd: number;
  error: string | null;
  createdAt: string;
}

export interface ShadowResponse {
  turns: ShadowTurn[];
  nextCursor: string | null;
  stats: { count: number; avgConfidence: number | null; handoffs: number; handoffRate: number; errors: number; costUsd: number };
}

export interface LeadRow {
  id: string;
  conversationId: string | null;
  igUsername: string | null;
  igUserId: string;
  name: string | null;
  phoneE164: string | null;
  productInterest: string | null;
  status: string;
  isTest: boolean;
  flag: string | null;
  createdAt: string;
  accountUsername: string;
  aiInsight: LeadInsight | null;
}

export interface UsageResponse {
  since: string;
  until: string;
  kinds: {
    kind: string;
    label: string;
    javobai: boolean;
    calls: number;
    failedCalls: number;
    inputTokens: number;
    outputTokens: number;
    costUsd: number;
  }[];
  calls: number;
  totalUsd: number;
  javobaiUsd: number;
  productionUsd: number;
  budget: {
    monthlyUsdSoft: number;
    monthlyUsdHard: number | null;
    alerted50At: string | null;
    alerted80At: string | null;
    alerted100At: string | null;
    periodStart: string;
    status: "ok" | "soft_exceeded" | "hard_exceeded";
    pct: number;
  } | null;
}

export interface SandboxResult {
  reply: string;
  intent: string;
  confidence: number;
  usedFacts: string[];
  extracted: Record<string, string | null>;
  language: string;
  score: number;
  temperature: Temperature;
  signals: { signal: string; points: number }[];
  handoff: { needed: boolean; reason?: string };
  unknownQuestion?: string | null;
  blockedBy?: string | null;
  costUsd: number;
}

// ─── Labels ───────────────────────────────────────────────────────────────────

export const MODE_TEXT: Record<JavobAiMode, { title: string; description: string; tone: DisplayTone }> = {
  OFF: {
    title: "OFF — ishlamaydi",
    description: "JavobAI hech narsa qilmaydi — avvalgidek. Javobni production assistent beradi (yoqilgan bo'lsa).",
    tone: "muted",
  },
  SHADOW: {
    title: "SHADOW — soyada kuzatadi",
    description:
      "Production javob beradi. JavobAI o'z javobini hisoblab, hech narsa yubormaydi — faqat \"Shadow\" bo'limida yonma-yon ko'rsatadi.",
    tone: "warning",
  },
  LIVE: {
    title: "LIVE — o'zi javob beradi",
    description:
      "JavobAI mijozga javob beradi, lead ochadi, operatorga topshiradi. Operator yozsa, avvalgidek to'xtaydi.",
    tone: "success",
  },
};

/** OFF mode text that tells what REALLY answers: the production assistant only when it is on (B-41). */
export function offModeDescription(profile: ProfileStatus): string {
  if (profile.exists && profile.live) {
    return "JavobAI hech narsa qilmaydi. Hozirgi (production) assistent yoqilgan — u javob beradi.";
  }
  if (profile.exists && profile.approved && profile.enabled === false) {
    return "JavobAI hech narsa qilmaydi. Production assistent ham o'chirilgan — hozir mijozga AI javob bermaydi.";
  }
  return "JavobAI hech narsa qilmaydi. Production assistent yoqilmagan (profil tasdiqlanmagan yoki yo'q) — hozir mijozga AI javob bermaydi.";
}

/** "tasdiqlangan · yoqilgan" — the same words as the assistant page. */
export function profileStateText(profile: ProfileStatus): string {
  if (!profile.exists) return "profil yo'q";
  const approved = profile.approved ?? profile.live;
  if (!approved) return "tasdiqlanmagan";
  return profile.enabled === false ? "tasdiqlangan · o'chirilgan" : "tasdiqlangan · yoqilgan";
}

export const HANDOFF_STATE_TEXT: Record<HandoffState, { label: string; tone: DisplayTone }> = {
  AI_ACTIVE: { label: "AI javob bermoqda", tone: "success" },
  HANDOFF_PENDING: { label: "Operator kutilmoqda", tone: "warning" },
  OPERATOR_ACTIVE: { label: "Operator yozmoqda", tone: "muted" },
  CLOSED: { label: "Yopilgan", tone: "muted" },
};

export const TEMPERATURE_TEXT: Record<Temperature, { label: string; emoji: string; tone: DisplayTone }> = {
  COLD: { label: "Cold", emoji: "❄️", tone: "muted" },
  WARM: { label: "Warm", emoji: "🌤", tone: "warning" },
  HOT: { label: "Hot", emoji: "🔥", tone: "error" },
  CUSTOMER: { label: "Mijoz", emoji: "✅", tone: "success" },
  LOST: { label: "Yo'qotilgan", emoji: "⛔", tone: "muted" },
};

export const KNOWLEDGE_KIND_TEXT: Record<KnowledgeKind, string> = {
  DISCOUNT: "Chegirma / aksiya",
  CONTACT: "Kontakt",
  TERMS: "Xizmat shartlari",
  BRANCH: "Filial",
  POLICY: "Qoida / siyosat",
  OTHER: "Boshqa",
  PRICE: "Narx",
  HOURS: "Ish vaqti",
  DELIVERY: "Yetkazib berish",
};

export const RULE_KIND_TEXT: Record<RuleKind, { title: string; description: string }> = {
  KEYWORD: { title: "Kalit so'z", description: "Mijoz shu so'zlardan birini yozsa — operatorga" },
  INTENT: { title: "Intent (ma'no)", description: "AI xabarni shu ma'noda tushunsa — operatorga" },
  SCORE: { title: "Lead bali", description: "Ball shu qiymatga yetsa — operatorga" },
  UNKNOWN_COUNT: { title: "Javobsiz savollar", description: "AI ketma-ket shuncha savolga javob topa olmasa" },
  OFF_HOURS: { title: "Ish vaqtidan tashqari", description: "Shu soatlar orasida kelgan xabar — operatorga" },
};

export const QUALIFICATION_TEXT: Record<QualificationField, string> = {
  product: "Qaysi mahsulot / xizmat",
  budget: "Byudjet",
  location: "Hudud / shahar",
};

export const AUTHOR_TEXT: Record<ConversationMessage["author"], string> = {
  CUSTOMER: "Mijoz",
  ASSISTANT: "AI",
  OPERATOR: "Operator",
  SYSTEM: "Tizim",
};

export function formatUsd(value: number): string {
  if (!Number.isFinite(value)) return "$0";
  if (value === 0) return "$0";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function formatPercent(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${Math.round(value * 100)}%`;
}

/** Score band name for the calculator and badges (Very hot is a band, not a status). */
export function bandForScore(score: number, t: ScoringConfig["thresholds"]): { label: string; tone: DisplayTone } {
  if (score >= t.veryHot) return { label: "Very hot", tone: "error" };
  if (score >= t.hot) return { label: "Hot", tone: "error" };
  if (score >= t.warm) return { label: "Warm", tone: "warning" };
  return { label: "Cold", tone: "muted" };
}

/** Unknown-shaped engine output → short readable text. */
export function describeValue(value: unknown): string {
  if (value === null || value === undefined || value === "") return "—";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (Array.isArray(value)) {
    if (value.length === 0) return "—";
    return value.map(describeValue).join(", ");
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(
      ([, v]) => v !== null && v !== undefined && v !== "" && v !== false
    );
    if (entries.length === 0) return "—";
    return entries.map(([k, v]) => `${k}: ${describeValue(v)}`).join(" · ");
  }
  return String(value);
}
