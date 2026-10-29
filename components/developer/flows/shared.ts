/**
 * Types, labels and small helpers of the Flow Builder (ETAP 6/7) screens.
 * Client-safe: no server imports (lib/flows/schema, conditions and
 * variables are pure).
 */

import type { DisplayTone } from "@/lib/triggers/display";
import type { FlowGraph, FlowNode } from "@/lib/flows/schema";
import type { FlowFieldSpec } from "@/lib/flows/conditions";

export { jsonInit, requestJson, uid, type JsonResult } from "@/components/developer/comments/shared";

export const FLOWS_API = "/api/flows";

export type FlowStatus = "DRAFT" | "REVIEW" | "PUBLISHED" | "ARCHIVED";
export type FlowMode = "SIMPLE" | "ADVANCED";
export type PolicyVerdict = "PASS" | "WARNING" | "BLOCKED";
export type VersionSource = "MANUAL" | "AI" | "TEMPLATE" | "IMPORT";
export type TriggerType = "COMMENT" | "LIVE_COMMENT" | "DIRECT_MESSAGE" | "STORY_MENTION";

export const STATUS_TEXT: Record<FlowStatus, { label: string; tone: DisplayTone }> = {
  DRAFT: { label: "Qoralama", tone: "muted" },
  REVIEW: { label: "Tasdiqlangan", tone: "warning" },
  PUBLISHED: { label: "Ishlayapti", tone: "success" },
  ARCHIVED: { label: "Arxiv", tone: "muted" },
};

export const VERDICT_TEXT: Record<PolicyVerdict, { label: string; tone: DisplayTone }> = {
  PASS: { label: "PASS", tone: "success" },
  WARNING: { label: "WARNING", tone: "warning" },
  BLOCKED: { label: "BLOCKED", tone: "error" },
};

export const SOURCE_TEXT: Record<VersionSource, string> = {
  MANUAL: "Qo'lda",
  AI: "AI",
  TEMPLATE: "Shablon",
  IMPORT: "Import",
};

export const RUN_STATUS_TEXT: Record<string, { label: string; tone: DisplayTone }> = {
  ACTIVE: { label: "Ishlayapti", tone: "success" },
  WAITING_TAP: { label: "Tugma kutilmoqda", tone: "warning" },
  WAITING_INBOUND: { label: "Javob kutilmoqda", tone: "warning" },
  WAITING_DELAY: { label: "Kutish (delay)", tone: "warning" },
  DONE: { label: "Tugadi", tone: "muted" },
  FAILED: { label: "Xato", tone: "error" },
  CANCELLED: { label: "Bekor qilindi", tone: "muted" },
};

export const TRIGGER_OPTIONS: Array<{ value: TriggerType; label: string }> = [
  { value: "COMMENT", label: "Komment" },
  { value: "LIVE_COMMENT", label: "Live komment" },
  { value: "DIRECT_MESSAGE", label: "Direct xabar" },
  { value: "STORY_MENTION", label: "Story'da belgilash" },
];

// ─── /meta ────────────────────────────────────────────────────────────────────

export interface MetaAccount {
  id: string;
  username: string;
  tokenStatus: string;
  javobAiMode: "OFF" | "SHADOW" | "LIVE";
}

export interface MetaStage {
  id: string;
  name: string;
  kind: string;
  isEntry: boolean;
}

export interface FlowsMeta {
  disabled: boolean;
  me: { userId: string; role: string; canWrite: boolean };
  accounts: MetaAccount[];
  tags: Array<{ id: string; name: string; slug: string }>;
  pipelines: Array<{ id: string; name: string; isDefault: boolean; stages: MetaStage[] }>;
  members: Array<{ id: string; name: string; role: string }>;
  intents: Array<{ key: string; label: string }>;
  nodeLabels: Record<string, string>;
  triggerLabels: Record<string, string>;
  limits: {
    nodes: number;
    edges: number;
    variables: number;
    messageLength: number;
    buttonTemplateTextLength: number;
    buttonLabelLength: number;
    quickReplies: number;
    publicReplyLength: number;
    branches: number;
    delayMaxMinutes: number;
    windowMinutes: number;
  };
  fieldSpecs: Record<string, FlowFieldSpec>;
  operators: string[];
  variables: Array<{ key: string; label: string; kind: string; source: string }>;
}

// ─── Findings / policy ────────────────────────────────────────────────────────

export interface Finding {
  code: string;
  nodeId?: string;
  edgeIndex?: number;
  message: string;
  fix?: string;
}

export interface AuditView {
  errors: Finding[];
  warnings: Finding[];
  suggestions: Finding[];
  hash?: string;
  at?: string;
}

export interface PolicyItemView {
  severity: "WARNING" | "BLOCKED";
  code: string;
  message: string;
  nodeId?: string;
}

export interface PolicyView {
  verdict: PolicyVerdict;
  items: PolicyItemView[];
  hash?: string;
  at?: string;
}

export interface Evaluation {
  audit: AuditView;
  policy: PolicyView;
  hash: string;
  structural: string[];
  publishable: boolean;
}

// ─── Flows / versions ─────────────────────────────────────────────────────────

export interface FlowListItem {
  id: string;
  name: string;
  mode: FlowMode;
  status: FlowStatus;
  triggerType: string;
  instagramAccountId: string;
  accountUsername: string | null;
  draftVersion: number | null;
  publishedVersion: number | null;
  lastPublishedAt: string | null;
  runs30d: number;
  activeRuns: number;
  updatedAt: string;
  createdAt: string;
}

export interface VersionSummary {
  id: string;
  flowId: string;
  version: number;
  source: VersionSource;
  hash: string;
  changeNote: string | null;
  state: "DRAFT" | "PUBLISHED" | "RETIRED" | "OLD";
  testedAt: string | null;
  approvedAt: string | null;
  approvedByUserId: string | null;
  publishedAt: string | null;
  retiredAt: string | null;
  createdAt: string;
  auditCounts: { errors: number; warnings: number; suggestions: number } | null;
  policyVerdict: PolicyVerdict | null;
}

export interface FlowDetail {
  flow: {
    id: string;
    name: string;
    mode: FlowMode;
    status: FlowStatus;
    triggerType: string;
    instagramAccountId: string;
    accountUsername: string | null;
    draftVersionId: string | null;
    publishedVersionId: string | null;
  };
  draft: (VersionSummary & { graph: FlowGraph; audit: AuditView | null; policy: PolicyView | null; prompt: string | null }) | null;
  published: (VersionSummary & { graph: FlowGraph }) | null;
  current: { versionId: string; graph: FlowGraph; editable: boolean } | null;
  versionCount: number;
  stats: { runs30d: number; activeRuns: number; byStatus: Record<string, number> };
}

export interface TemplateItem {
  key: string;
  id: string | null;
  name: string;
  description: string | null;
  category: string;
  triggerType: string | null;
  tags: string[];
  builtIn: boolean;
  nodeCount: number;
  graph: FlowGraph;
}

export interface GeneratedFlow {
  graph: FlowGraph;
  name: string;
  summary: string | null;
  warnings: string[];
  audit: AuditView;
  policy: PolicyView;
  model: string;
  repaired: boolean;
}

export interface DiffView {
  a: VersionSummary;
  b: VersionSummary;
  diff: {
    added: Array<{ id: string; type: FlowNode["type"] }>;
    removed: Array<{ id: string; type: FlowNode["type"] }>;
    changed: Array<{ id: string; type: FlowNode["type"]; fields: Array<{ field: string; before: unknown; after: unknown }> }>;
    edgesAdded: Array<{ from: string; to: string; handle: string }>;
    edgesRemoved: Array<{ from: string; to: string; handle: string }>;
    variablesAdded: string[];
    variablesRemoved: string[];
    identical: boolean;
  };
}

export const CATEGORY_TEXT: Record<string, string> = {
  sales: "Sotuv",
  story: "Story",
  ads: "Reklama",
  faq: "Savol-javob",
  giveaway: "Giveaway",
};

export function shortHash(hash: string | undefined | null): string {
  return hash ? hash.slice(0, 7) : "—";
}

export function valueText(value: unknown): string {
  if (value === null || value === undefined) return "—";
  if (typeof value === "string") return value.length > 160 ? `${value.slice(0, 160)}…` : value;
  const json = JSON.stringify(value);
  return json.length > 160 ? `${json.slice(0, 160)}…` : json;
}
