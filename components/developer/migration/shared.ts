/**
 * ETAP 11 — types, labels and helpers of the ManyChat migration wizard.
 * Client-safe: no server imports (the analyzer runs behind the analyze-text API).
 */

import type { DisplayTone } from "@/lib/triggers/display";
import type { AuditView, PolicyView } from "@/components/developer/flows/shared";
import type { FlowGraph } from "@/lib/flows/schema";

export { jsonInit, requestJson, type JsonResult } from "@/components/developer/comments/shared";

export const MIGRATION_API = "/api/developer/migration";

export type ItemKind = "TAG" | "CUSTOM_FIELD" | "BOT_FIELD" | "FLOW" | "GROWTH_TOOL";
export type ItemStatus = "PENDING" | "MAPPED" | "CONVERTED" | "IMPORTED" | "SKIPPED" | "UNSUPPORTED" | "FAILED";

export const KIND_TEXT: Record<ItemKind, string> = {
  TAG: "Teglar",
  CUSTOM_FIELD: "Maxsus maydonlar",
  BOT_FIELD: "Bot maydonlari",
  FLOW: "Flow'lar",
  GROWTH_TOOL: "Growth tool'lar",
};

export const STATUS_TEXT: Record<ItemStatus, { label: string; tone: DisplayTone }> = {
  PENDING: { label: "Kutilmoqda", tone: "muted" },
  MAPPED: { label: "Moslangan", tone: "muted" },
  CONVERTED: { label: "Aylantirilgan", tone: "warning" },
  IMPORTED: { label: "Import qilingan", tone: "success" },
  UNSUPPORTED: { label: "Qo'llab-quvvatlanmaydi", tone: "error" },
  SKIPPED: { label: "O'tkazib yuborilgan", tone: "muted" },
  FAILED: { label: "Xato", tone: "error" },
};

/** A finding stored on an item / returned by the analyzer and the converter. */
export interface ItemWarning {
  code?: string;
  severity?: "info" | "warning" | "error" | string;
  message: string;
  suggestion?: string;
  feature?: string;
  count?: number;
}

export interface MigrationItem {
  id: string;
  kind: ItemKind;
  sourceId: string | null;
  name: string;
  folder: string | null;
  status: ItemStatus;
  mapping: Record<string, unknown>;
  hasText: boolean;
  textLength: number;
  textPreview: string | null;
  /** Only on a single-item read (GET .../items/<id>). */
  sourceText?: string | null;
  warnings: ItemWarning[];
  flowId: string | null;
  note: string | null;
}

export interface ProjectSummary {
  id: string;
  name: string;
  status: string;
  apiKeyHint: string | null;
  instagramAccountId: string | null;
  pageSnapshot?: { name?: string; id?: string | number; [key: string]: unknown } | null;
  lastAnalyzedAt: string | null;
  lastError: string | null;
  createdAt: string;
}

export interface KindCounts {
  total: number;
  byStatus: Record<string, number>;
}

/** Flattened view of the engine's getProject result: { project, items, counts, checklist, contactGuidance }. */
export interface ProjectDetail extends ProjectSummary {
  items: Partial<Record<ItemKind, MigrationItem[]>>;
  counts: Partial<Record<ItemKind, KindCounts>>;
  /** What is still to do / already done, from the engine. */
  todo: string[];
  done: string[];
  contactGuidance: string;
}

export interface RawProject {
  project: ProjectSummary;
  items?: ProjectDetail["items"];
  counts?: ProjectDetail["counts"];
  checklist?: { done?: string[]; todo?: string[] };
  contactGuidance?: string;
}

export function normalizeProject(raw: RawProject): ProjectDetail {
  return {
    ...raw.project,
    items: raw.items ?? {},
    counts: raw.counts ?? {},
    todo: raw.checklist?.todo ?? [],
    done: raw.checklist?.done ?? [],
    contactGuidance: raw.contactGuidance ?? "",
  };
}

export interface CatalogEntry {
  key: string;
  category?: string;
  label: string;
  status: "SUPPORTED" | "PARTIAL" | "UNSUPPORTED";
  mapsTo?: string | null;
  message?: string;
  suggestion?: string;
}

export interface Limits {
  maxFlowText: number;
  maxScreenshots: number;
  maxScreenshotBytes: number;
}

export interface MigrationMeta {
  enabled: boolean;
  accounts: Array<{ id: string; username: string; tokenStatus: string }>;
  catalog: CatalogEntry[];
  limits: Limits;
  me: { userId: string; role: string; canWrite: boolean };
}

/** analyzeFlowText() result (also behind the analyze-text API). */
export interface TextAnalysis {
  triggers: Array<{ kind: string; detail?: string }>;
  nodes: Array<{ kind: string; count: number }>;
  /** Features without a full equivalent (PARTIAL: warning, UNSUPPORTED: error). */
  unsupported: ItemWarning[];
  notes: ItemWarning[];
  language?: string;
}

export interface ConversionPreview {
  graph: FlowGraph;
  name?: string;
  summary?: string | null;
  warnings: ItemWarning[];
  audit: AuditView;
  policy: PolicyView;
  model?: string;
  repaired?: boolean;
}

export interface ImportedFlow {
  flowId: string;
  link?: string | null;
}

export const STEPS = [
  { key: "connect", label: "Ulash" },
  { key: "analyze", label: "Tahlil" },
  { key: "mapping", label: "Moslashtirish" },
  { key: "flows", label: "Flow'lar" },
  { key: "finish", label: "Yakun" },
] as const;
export type StepKey = (typeof STEPS)[number]["key"];

export function stepFromParam(value: string | null): number {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 && n < STEPS.length ? n : 0;
}

export function itemsOf(project: ProjectDetail | null, kind: ItemKind): MigrationItem[] {
  return project?.items?.[kind] ?? [];
}

export function countOf(project: ProjectDetail | null, kind: ItemKind): number {
  return project?.counts?.[kind]?.total ?? itemsOf(project, kind).length;
}

export function warningLine(w: ItemWarning): string {
  return w.suggestion ? `${w.message} Yechim: ${w.suggestion}` : w.message;
}

export function str(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : value == null ? fallback : String(value);
}

export function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 102.4) / 10} KB`;
  return `${Math.round(bytes / 104857.6) / 10} MB`;
}

export const SCREENSHOT_TYPES = ["image/png", "image/jpeg", "image/webp"] as const;

export function readFileAsBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(new Error("Faylni o'qib bo'lmadi"));
    reader.readAsDataURL(file);
  });
}

export const CONTACT_GUIDANCE_FALLBACK = [
  "ManyChat obunachilari ko'chirilmaydi: Instagram kontaktlari yangi akkauntda qayta rozilik (opt-in) berishi kerak.",
  "Yo'l 1: ig.me/m/<username>?ref=<kod> havolasini bio, story va reklamalarga qo'ying — ref kodi bilan kim qaerdan kelganini ko'rasiz.",
  "Yo'l 2: Comment 2.0 trigger — izohga kalit so'z yozgan odamga DM yuboriladi.",
  "Yo'l 3: Story javob trigger — story'ga javob bergan odamga DM yuboriladi.",
];
