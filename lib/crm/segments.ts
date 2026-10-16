/**
 * ETAP 5.1 — segment filter DSL (TZ 29).
 *
 *   { v: 1, all: [cond, ...], any?: [cond, ...] }
 *
 * `all` conditions must all hold; when `any` is given at least one of them
 * must hold too ("Toshkent + HOT + IELTS + telefon bor"). A condition is
 * `{ field, op, value? }`; which operators and value kinds a field accepts is
 * declared in FIELD_SPECS and enforced by `segmentFilterSchema`.
 *
 * `compileSegmentWhere` turns a filter into a plain object in the shape of
 * Prisma's `CrmContactWhereInput` (no workspaceId — the caller adds it), so
 * the segment preview, the contact list and the broadcast audience all go
 * through the same `where`. `describeFilter` renders the same filter as one
 * Uzbek sentence for the segment card.
 *
 * Pure: no database, no Prisma import (the model does not exist yet).
 */

import { z } from "zod";
import {
  CONTACT_SOURCE_LABELS,
  CONTACT_STATUS_LABELS,
  TEMPERATURE_LABELS,
  type CrmContactSource,
  type CrmContactStatus,
  type CrmTemperature,
} from "./types";

// ─── Vocabulary ───────────────────────────────────────────────────────────────

export const SEGMENT_OPERATORS = [
  "eq",
  "neq",
  "in",
  "gte",
  "lte",
  "contains",
  "within_days",
  "is_true",
  "is_false",
] as const;
export type SegmentOperator = (typeof SEGMENT_OPERATORS)[number];

export const SEGMENT_FIELDS = [
  "tag",
  "not_tag",
  "score",
  "temperature",
  "status",
  "stage",
  "pipeline",
  "assigned",
  "phone_present",
  "email_present",
  "language",
  "source",
  "account",
  "last_interaction",
  "window_open",
  "opted_out",
] as const;
export type SegmentField = (typeof SEGMENT_FIELDS)[number];

/** `custom.<key>` reads `CrmContact.customFields[key]` (JSON). */
export const CUSTOM_FIELD_PREFIX = "custom.";
const CUSTOM_KEY = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

type ValueKind = "string" | "number" | "none" | "any";

export interface SegmentFieldSpec {
  /** Shown in the builder. */
  label: string;
  ops: SegmentOperator[];
  value: ValueKind;
}

export const FIELD_SPECS: Record<SegmentField, SegmentFieldSpec> = {
  tag: { label: "Teg", ops: ["eq", "in"], value: "string" },
  not_tag: { label: "Tegsiz", ops: ["eq", "in"], value: "string" },
  score: { label: "Ball", ops: ["eq", "neq", "gte", "lte"], value: "number" },
  temperature: { label: "Harorat", ops: ["eq", "neq", "in"], value: "string" },
  status: { label: "Holat", ops: ["eq", "neq", "in"], value: "string" },
  stage: { label: "Bosqich", ops: ["eq", "neq", "in"], value: "string" },
  pipeline: { label: "Voronka", ops: ["eq", "in"], value: "string" },
  assigned: { label: "Operator", ops: ["is_true", "is_false", "eq", "neq", "in"], value: "string" },
  phone_present: { label: "Telefon", ops: ["is_true", "is_false"], value: "none" },
  email_present: { label: "Email", ops: ["is_true", "is_false"], value: "none" },
  language: { label: "Til", ops: ["eq", "neq", "in"], value: "string" },
  source: { label: "Manba", ops: ["eq", "neq", "in"], value: "string" },
  account: { label: "Akkaunt", ops: ["eq", "neq", "in"], value: "string" },
  // within_days N / lte N: wrote within the last N days; gte N: silent for N days or more.
  last_interaction: { label: "Oxirgi aloqa", ops: ["within_days", "gte", "lte"], value: "number" },
  window_open: { label: "24 soatlik oyna", ops: ["is_true", "is_false"], value: "none" },
  opted_out: { label: "Obunadan chiqqan", ops: ["is_true", "is_false"], value: "none" },
};

export const CUSTOM_FIELD_SPEC: SegmentFieldSpec = {
  label: "Maxsus maydon",
  ops: ["eq", "neq", "in", "gte", "lte", "contains", "is_true", "is_false"],
  value: "any",
};

export function customFieldKey(field: string): string | null {
  if (!field.startsWith(CUSTOM_FIELD_PREFIX)) return null;
  const key = field.slice(CUSTOM_FIELD_PREFIX.length);
  return CUSTOM_KEY.test(key) ? key : null;
}

export function fieldSpec(field: string): SegmentFieldSpec | null {
  if (customFieldKey(field)) return CUSTOM_FIELD_SPEC;
  return (FIELD_SPECS as Record<string, SegmentFieldSpec>)[field] ?? null;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const scalarSchema = z.union([z.string().max(200), z.number().finite(), z.boolean()]);
const valueSchema = z.union([scalarSchema, z.array(z.union([z.string().max(200), z.number().finite()])).min(1).max(100)]);

export const segmentConditionSchema = z
  .object({
    field: z.string().min(1).max(40),
    op: z.enum(SEGMENT_OPERATORS),
    value: valueSchema.optional(),
  })
  .superRefine((cond, ctx) => {
    const spec = fieldSpec(cond.field);
    if (!spec) {
      ctx.addIssue({ code: "custom", path: ["field"], message: `Noma'lum maydon: ${cond.field}` });
      return;
    }
    if (!spec.ops.includes(cond.op)) {
      ctx.addIssue({ code: "custom", path: ["op"], message: `"${cond.field}" uchun "${cond.op}" operatori mos emas` });
      return;
    }
    const value = cond.value;
    if (cond.op === "is_true" || cond.op === "is_false") return; // value ignored
    if (value === undefined) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Qiymat kiritilmagan" });
      return;
    }
    if (cond.op === "in") {
      if (!Array.isArray(value)) {
        ctx.addIssue({ code: "custom", path: ["value"], message: `"in" uchun ro'yxat kerak` });
      } else if (spec.value === "number" && value.some((v) => typeof v !== "number")) {
        ctx.addIssue({ code: "custom", path: ["value"], message: "Ro'yxatda faqat raqamlar bo'lishi kerak" });
      } else if (spec.value === "string" && value.some((v) => typeof v !== "string")) {
        ctx.addIssue({ code: "custom", path: ["value"], message: "Ro'yxatda faqat matn bo'lishi kerak" });
      }
      return;
    }
    if (Array.isArray(value)) {
      ctx.addIssue({ code: "custom", path: ["value"], message: `Ro'yxat faqat "in" operatori bilan ishlaydi` });
      return;
    }
    if (cond.op === "within_days" || cond.op === "gte" || cond.op === "lte") {
      if (spec.value !== "any" && typeof value !== "number") {
        ctx.addIssue({ code: "custom", path: ["value"], message: "Raqam kerak" });
      } else if (cond.op === "within_days" && (typeof value !== "number" || value < 0)) {
        ctx.addIssue({ code: "custom", path: ["value"], message: "Kunlar soni manfiy bo'lmasligi kerak" });
      }
      return;
    }
    if (cond.op === "contains" && typeof value !== "string") {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Matn kerak" });
      return;
    }
    if (spec.value === "string" && typeof value !== "string") {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Matn kerak" });
    } else if (spec.value === "number" && typeof value !== "number") {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Raqam kerak" });
    }
  });

export const segmentFilterSchema = z.object({
  v: z.literal(1),
  all: z.array(segmentConditionSchema).max(50),
  any: z.array(segmentConditionSchema).max(50).optional(),
});

export type SegmentCondition = z.infer<typeof segmentConditionSchema>;
export type SegmentFilter = z.infer<typeof segmentFilterSchema>;

export const EMPTY_FILTER: SegmentFilter = { v: 1, all: [] };

/** Parses untrusted JSON (segment row / request body) into a filter; null when invalid. */
export function parseSegmentFilter(input: unknown): SegmentFilter | null {
  const parsed = segmentFilterSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

// ─── Compile → Prisma where ───────────────────────────────────────────────────

export const DAY_MS = 24 * 3600_000;
/** Same semantics as lib/triggers/followups isWindowOpen: 24h minus a 5-minute margin. */
export const WINDOW_OPEN_MS = 24 * 3600_000 - 5 * 60_000;

export type WhereObject = Record<string, unknown>;

type Scalar = string | number | boolean;

function list(value: unknown): Scalar[] {
  return Array.isArray(value) ? (value as Scalar[]) : [value as Scalar];
}

/** eq / neq / in on a scalar column. */
function scalarWhere(column: string, op: SegmentOperator, value: unknown): WhereObject {
  if (op === "in") return { [column]: { in: list(value) } };
  if (op === "neq") return { [column]: { not: value } };
  return { [column]: value };
}

function slugWhere(op: SegmentOperator, value: unknown): WhereObject {
  return op === "in" ? { slug: { in: list(value) } } : { slug: value };
}

function compileCondition(cond: SegmentCondition, now: Date): WhereObject {
  const { field, op, value } = cond;
  const customKey = customFieldKey(field);
  if (customKey) return compileCustom(customKey, op, value);

  switch (field as SegmentField) {
    case "tag":
      return { tags: { some: { tag: slugWhere(op, value) } } };
    case "not_tag":
      return { tags: { none: { tag: slugWhere(op, value) } } };
    case "score":
      if (op === "gte" || op === "lte") return { score: { [op]: value } };
      return scalarWhere("score", op, value);
    case "temperature":
      return scalarWhere("temperature", op, value);
    case "status":
      return scalarWhere("status", op, value);
    case "stage":
      // neq = no deal sits in that stage (not "some deal elsewhere").
      if (op === "neq") return { deals: { none: { stageId: value } } };
      return { deals: { some: op === "in" ? { stageId: { in: list(value) } } : { stageId: value } } };
    case "pipeline":
      return { deals: { some: { stage: op === "in" ? { pipelineId: { in: list(value) } } : { pipelineId: value } } } };
    case "assigned":
      if (op === "is_true") return { assignedMemberId: { not: null } };
      if (op === "is_false") return { assignedMemberId: null };
      return scalarWhere("assignedMemberId", op, value);
    case "phone_present":
      return op === "is_true" ? { phoneE164: { not: null } } : { phoneE164: null };
    case "email_present":
      return op === "is_true" ? { email: { not: null } } : { email: null };
    case "language":
      return scalarWhere("language", op, value);
    case "source":
      return scalarWhere("source", op, value);
    case "account":
      return scalarWhere("instagramAccountId", op, value);
    case "last_interaction": {
      const edge = new Date(now.getTime() - Number(value) * DAY_MS);
      // gte N = N or more days of silence; within_days / lte N = active in the last N days.
      return op === "gte" ? { lastInteractionAt: { lte: edge } } : { lastInteractionAt: { gte: edge } };
    }
    case "window_open": {
      const edge = new Date(now.getTime() - WINDOW_OPEN_MS);
      if (op === "is_true") return { lastInboundAt: { gt: edge } };
      return { OR: [{ lastInboundAt: null }, { lastInboundAt: { lte: edge } }] };
    }
    case "opted_out":
      return op === "is_true" ? { optedOutAt: { not: null } } : { optedOutAt: null };
  }
  // Unreachable after schema validation; a defensive no-op keeps `where` valid.
  return {};
}

/** Prisma JSON filter on `customFields` (Postgres: `path` is a string array). */
function compileCustom(key: string, op: SegmentOperator, value: unknown): WhereObject {
  const path = [key];
  const json = (filter: WhereObject): WhereObject => ({ customFields: { path, ...filter } });
  switch (op) {
    case "eq":
      return json({ equals: value });
    case "neq":
      return json({ not: value });
    case "in":
      return { OR: list(value).map((v) => json({ equals: v })) };
    case "gte":
      return json({ gte: value });
    case "lte":
      return json({ lte: value });
    case "contains":
      return json({ string_contains: value });
    case "is_true":
      return json({ equals: true });
    case "is_false":
      return json({ equals: false });
    default:
      return {};
  }
}

/**
 * `where` for `CrmContact` rows that match the filter, relative to `now`
 * (window / days computations are evaluated once, at compile time — recompile
 * for every preview or send, never cache the result).
 */
export function compileSegmentWhere(filter: SegmentFilter, now: Date = new Date()): WhereObject {
  const clauses: WhereObject[] = filter.all.map((cond) => compileCondition(cond, now));
  const any = (filter.any ?? []).map((cond) => compileCondition(cond, now));
  if (any.length > 0) clauses.push({ OR: any });
  return clauses.length > 0 ? { AND: clauses } : {};
}

// ─── Describe (Uzbek) ─────────────────────────────────────────────────────────

export interface DescribeOptions {
  /** id → human name for stage / pipeline / member / account / tag values. */
  stageNames?: Record<string, string>;
  pipelineNames?: Record<string, string>;
  memberNames?: Record<string, string>;
  accountNames?: Record<string, string>;
  tagNames?: Record<string, string>;
}

const OP_SYMBOL: Partial<Record<SegmentOperator, string>> = { eq: "=", neq: "≠", gte: "≥", lte: "≤" };

function named(value: unknown, names?: Record<string, string>): string {
  const key = String(value);
  return names?.[key] ?? key;
}

function joinValues(value: unknown, names?: Record<string, string>): string {
  return list(value)
    .map((v) => named(v, names))
    .join(" yoki ");
}

function enumLabel(value: unknown, labels: Record<string, string>): string {
  return labels[String(value)] ?? String(value);
}

function describeCondition(cond: SegmentCondition, opts: DescribeOptions): string {
  const { field, op, value } = cond;
  const customKey = customFieldKey(field);
  if (customKey) {
    if (op === "is_true") return `${customKey}: ha`;
    if (op === "is_false") return `${customKey}: yo'q`;
    if (op === "in") return `${customKey}: ${joinValues(value)}`;
    if (op === "contains") return `${customKey} ichida "${String(value)}"`;
    return `${customKey} ${OP_SYMBOL[op] ?? op} ${String(value)}`;
  }
  switch (field as SegmentField) {
    case "tag":
      return `Teg: ${joinValues(value, opts.tagNames)}`;
    case "not_tag":
      return `Tegsiz: ${joinValues(value, opts.tagNames)}`;
    case "score":
      return `Ball ${OP_SYMBOL[op] ?? op} ${String(value)}`;
    case "temperature":
      return `Harorat${op === "neq" ? " emas" : ""}: ${list(value)
        .map((v) => enumLabel(v, TEMPERATURE_LABELS as Record<CrmTemperature, string>))
        .join(" yoki ")}`;
    case "status":
      return `Holat${op === "neq" ? " emas" : ""}: ${list(value)
        .map((v) => enumLabel(v, CONTACT_STATUS_LABELS as Record<CrmContactStatus, string>))
        .join(" yoki ")}`;
    case "stage":
      return `Bosqich${op === "neq" ? " emas" : ""}: ${joinValues(value, opts.stageNames)}`;
    case "pipeline":
      return `Voronka: ${joinValues(value, opts.pipelineNames)}`;
    case "assigned":
      if (op === "is_true") return "Operator biriktirilgan";
      if (op === "is_false") return "Operator biriktirilmagan";
      return `Operator${op === "neq" ? " emas" : ""}: ${joinValues(value, opts.memberNames)}`;
    case "phone_present":
      return op === "is_true" ? "Telefon bor" : "Telefon yo'q";
    case "email_present":
      return op === "is_true" ? "Email bor" : "Email yo'q";
    case "language":
      return `Til${op === "neq" ? " emas" : ""}: ${joinValues(value)}`;
    case "source":
      return `Manba${op === "neq" ? " emas" : ""}: ${list(value)
        .map((v) => enumLabel(v, CONTACT_SOURCE_LABELS as Record<CrmContactSource, string>))
        .join(" yoki ")}`;
    case "account":
      return `Akkaunt${op === "neq" ? " emas" : ""}: ${joinValues(value, opts.accountNames)}`;
    case "last_interaction":
      return op === "gte" ? `Oxirgi aloqa: ${String(value)} kundan beri yo'q` : `Oxirgi aloqa: ${String(value)} kun ichida`;
    case "window_open":
      return op === "is_true" ? "24 soatlik oyna ochiq" : "24 soatlik oyna yopiq";
    case "opted_out":
      return op === "is_true" ? "Obunadan chiqqan" : "Obunadan chiqmagan";
  }
  return `${field} ${op}`;
}

/** One Uzbek sentence for the segment card: "Teg: hot va Telefon bor va (Til: uz yoki Til: ru)". */
export function describeFilter(filter: SegmentFilter, opts: DescribeOptions = {}): string {
  const parts = filter.all.map((cond) => describeCondition(cond, opts));
  const any = (filter.any ?? []).map((cond) => describeCondition(cond, opts));
  if (any.length === 1) parts.push(any[0]);
  else if (any.length > 1) parts.push(`(${any.join(" yoki ")})`);
  return parts.length > 0 ? parts.join(" va ") : "Barcha kontaktlar";
}
