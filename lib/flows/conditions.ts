/**
 * ETAP 6 — flow condition DSL (analysis §1.2), same shape as the CRM
 * segment filter (lib/crm/segments.ts):
 *
 *   { v: 1, all: [cond, ...], any?: [cond, ...] }
 *
 * but compiled to an in-memory predicate over a `FlowContext` instead of a
 * Prisma `where`. Fields are the flow variable vocabulary; `keyword` and
 * `intent` reuse the campaign normaliser (lib/triggers/keywords.ts) so
 * "Нархи канча?" matches the keyword "narx" exactly as a campaign would.
 *
 * Branch evaluation: array order, first match wins, otherwise "else".
 *
 * Pure: no database. User-facing text is Uzbek Latin.
 */

import { z } from "zod";
import { BUILT_IN_INTENTS, findIntent, findKeyword, isBuiltInIntent, normalizeForMatch } from "@/lib/triggers/keywords";
import { type FlowContext, resolveVariable, stringifyValue, varsKey } from "./variables";

// ─── Vocabulary ───────────────────────────────────────────────────────────────

export const FLOW_OPERATORS = ["eq", "neq", "in", "gte", "lte", "contains", "is_set", "not_set", "keyword", "intent"] as const;
export type FlowOperator = (typeof FLOW_OPERATORS)[number];

export const FLOW_CONDITION_FIELDS = [
  "contact.name",
  "contact.username",
  "contact.phone",
  "contact.email",
  "contact.language",
  "trigger.text",
  "trigger.keyword",
  "trigger.intent",
  "trigger.source",
  "trigger.mediaId",
  "last_message.text",
  "tags",
  "score",
  "temperature",
  "audience",
  "window.open",
  "time.hour",
  "time.weekday",
  "run.sends",
] as const;
export type FlowConditionField = (typeof FLOW_CONDITION_FIELDS)[number];

type ValueKind = "string" | "number" | "boolean" | "list" | "none" | "any";

export interface FlowFieldSpec {
  label: string;
  ops: FlowOperator[];
  value: ValueKind;
}

const TEXT_OPS: FlowOperator[] = ["eq", "neq", "in", "contains", "is_set", "not_set", "keyword", "intent"];
const ENUM_OPS: FlowOperator[] = ["eq", "neq", "in", "is_set", "not_set"];
const NUMBER_OPS: FlowOperator[] = ["eq", "neq", "in", "gte", "lte", "is_set", "not_set"];

export const FIELD_SPECS: Record<FlowConditionField, FlowFieldSpec> = {
  "contact.name": { label: "Mijoz ismi", ops: TEXT_OPS, value: "string" },
  "contact.username": { label: "Username", ops: TEXT_OPS, value: "string" },
  "contact.phone": { label: "Telefon", ops: ["is_set", "not_set", "eq", "contains"], value: "string" },
  "contact.email": { label: "Email", ops: ["is_set", "not_set", "eq", "contains"], value: "string" },
  "contact.language": { label: "Til", ops: ENUM_OPS, value: "string" },
  "trigger.text": { label: "Komment / xabar matni", ops: TEXT_OPS, value: "string" },
  "trigger.keyword": { label: "Mos kelgan kalit so'z", ops: ENUM_OPS, value: "string" },
  "trigger.intent": { label: "Mos kelgan niyat", ops: ENUM_OPS, value: "string" },
  "trigger.source": { label: "Manba", ops: ENUM_OPS, value: "string" },
  "trigger.mediaId": { label: "Post", ops: ENUM_OPS, value: "string" },
  "last_message.text": { label: "Oxirgi xabar", ops: TEXT_OPS, value: "string" },
  tags: { label: "Teglar", ops: ["contains", "in", "is_set", "not_set"], value: "list" },
  score: { label: "Ball", ops: NUMBER_OPS, value: "number" },
  temperature: { label: "Harorat", ops: ENUM_OPS, value: "string" },
  audience: { label: "Auditoriya", ops: ENUM_OPS, value: "string" },
  "window.open": { label: "24 soatlik oyna", ops: ["eq"], value: "boolean" },
  "time.hour": { label: "Soat", ops: NUMBER_OPS, value: "number" },
  "time.weekday": { label: "Hafta kuni", ops: NUMBER_OPS, value: "number" },
  "run.sends": { label: "Yuborilgan xabarlar", ops: NUMBER_OPS, value: "number" },
};

/** `vars.<key>`: anything a node saved — every operator, any value kind. */
export const VARS_FIELD_SPEC: FlowFieldSpec = { label: "O'zgaruvchi", ops: [...FLOW_OPERATORS], value: "any" };

export function fieldSpec(field: string): FlowFieldSpec | null {
  if (varsKey(field)) return VARS_FIELD_SPEC;
  return (FIELD_SPECS as Record<string, FlowFieldSpec>)[field] ?? null;
}

// ─── Schema ───────────────────────────────────────────────────────────────────

const scalarSchema = z.union([z.string().max(200), z.number().finite(), z.boolean()]);
const listSchema = z.array(z.union([z.string().max(200), z.number().finite()])).min(1).max(100);
const valueSchema = z.union([scalarSchema, listSchema]);

export const flowConditionSchema = z
  .object({
    field: z.string().min(1).max(40),
    op: z.enum(FLOW_OPERATORS),
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
    if (cond.op === "is_set" || cond.op === "not_set") return; // value ignored
    const value = cond.value;
    if (value === undefined) {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Qiymat kiritilmagan" });
      return;
    }
    if (cond.op === "keyword") {
      const list = Array.isArray(value) ? value : [value];
      if (list.some((v) => typeof v !== "string" || !normalizeForMatch(v))) {
        ctx.addIssue({ code: "custom", path: ["value"], message: "Kalit so'z (yoki ro'yxat) kerak" });
      }
      return;
    }
    if (cond.op === "intent") {
      const list = Array.isArray(value) ? value : [value];
      const bad = list.find((v) => typeof v !== "string" || !isBuiltInIntent(v));
      if (bad !== undefined) {
        ctx.addIssue({ code: "custom", path: ["value"], message: `Noma'lum niyat: ${String(bad)}` });
      }
      return;
    }
    if (cond.op === "in") {
      if (!Array.isArray(value)) {
        ctx.addIssue({ code: "custom", path: ["value"], message: `"in" uchun ro'yxat kerak` });
      } else if (spec.value === "number" && value.some((v) => typeof v !== "number")) {
        ctx.addIssue({ code: "custom", path: ["value"], message: "Ro'yxatda faqat raqamlar bo'lishi kerak" });
      } else if ((spec.value === "string" || spec.value === "list") && value.some((v) => typeof v !== "string")) {
        ctx.addIssue({ code: "custom", path: ["value"], message: "Ro'yxatda faqat matn bo'lishi kerak" });
      }
      return;
    }
    if (Array.isArray(value)) {
      ctx.addIssue({ code: "custom", path: ["value"], message: `Ro'yxat faqat "in" operatori bilan ishlaydi` });
      return;
    }
    if (cond.op === "gte" || cond.op === "lte") {
      if (typeof value !== "number") ctx.addIssue({ code: "custom", path: ["value"], message: "Raqam kerak" });
      return;
    }
    if (cond.op === "contains") {
      if (typeof value !== "string") ctx.addIssue({ code: "custom", path: ["value"], message: "Matn kerak" });
      return;
    }
    if (spec.value === "string" && typeof value !== "string") {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Matn kerak" });
    } else if (spec.value === "number" && typeof value !== "number") {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Raqam kerak" });
    } else if (spec.value === "boolean" && typeof value !== "boolean") {
      ctx.addIssue({ code: "custom", path: ["value"], message: "Ha / yo'q kerak" });
    }
  });

export const flowFilterSchema = z.object({
  v: z.literal(1),
  all: z.array(flowConditionSchema).max(50),
  any: z.array(flowConditionSchema).max(50).optional(),
});

export type FlowCondition = z.infer<typeof flowConditionSchema>;
export type FlowFilter = z.infer<typeof flowFilterSchema>;

export const EMPTY_FLOW_FILTER: FlowFilter = { v: 1, all: [] };

export function parseFlowFilter(input: unknown): FlowFilter | null {
  const parsed = flowFilterSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

// ─── Compile → predicate ──────────────────────────────────────────────────────

export type FlowPredicate = (ctx: FlowContext) => boolean;

type Scalar = string | number | boolean;

function list(value: unknown): Scalar[] {
  return Array.isArray(value) ? (value as Scalar[]) : [value as Scalar];
}

function isEmpty(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (typeof value === "string") return value.trim() === "";
  if (Array.isArray(value)) return value.length === 0;
  if (typeof value === "number") return !Number.isFinite(value);
  return false;
}

/** Loose equality for the builder: "1" == 1, "true" == true, case/script-insensitive strings. */
function same(actual: unknown, expected: Scalar): boolean {
  if (typeof expected === "boolean") {
    if (typeof actual === "boolean") return actual === expected;
    const s = stringifyValue(actual).toLowerCase();
    return expected ? s === "true" || s === "ha" || s === "1" : s === "false" || s === "yo'q" || s === "0" || s === "";
  }
  if (typeof expected === "number") {
    const n = typeof actual === "number" ? actual : Number(stringifyValue(actual));
    return Number.isFinite(n) && n === expected;
  }
  if (Array.isArray(actual)) return actual.some((item) => same(item, expected));
  return normalizeForMatch(stringifyValue(actual)) === normalizeForMatch(expected);
}

function asNumber(actual: unknown): number | null {
  const n = typeof actual === "number" ? actual : Number(stringifyValue(actual));
  return Number.isFinite(n) ? n : null;
}

function compileOne(cond: FlowCondition): FlowPredicate {
  const { field, op, value } = cond;
  return (ctx) => {
    const actual = resolveVariable(field, ctx);
    switch (op) {
      case "is_set":
        return !isEmpty(actual);
      case "not_set":
        return isEmpty(actual);
      case "eq":
        return !isEmpty(actual) && same(actual, value as Scalar);
      case "neq":
        return !same(actual, value as Scalar);
      case "in":
        return !isEmpty(actual) && list(value).some((v) => same(actual, v));
      case "gte": {
        const n = asNumber(actual);
        return n !== null && n >= Number(value);
      }
      case "lte": {
        const n = asNumber(actual);
        return n !== null && n <= Number(value);
      }
      case "contains": {
        const needle = normalizeForMatch(String(value));
        if (!needle) return false;
        if (Array.isArray(actual)) return actual.some((item) => normalizeForMatch(stringifyValue(item)) === needle);
        return normalizeForMatch(stringifyValue(actual)).includes(needle);
      }
      case "keyword":
        return findKeyword(stringifyValue(actual), list(value).map(String), "CONTAINS") !== null;
      case "intent":
        return findIntent(stringifyValue(actual), list(value).map(String)) !== null;
    }
    return false;
  };
}

/** `all` must hold; when `any` is given at least one of its conditions too. */
export function compilePredicate(filter: FlowFilter): FlowPredicate {
  const all = filter.all.map(compileOne);
  const any = (filter.any ?? []).map(compileOne);
  return (ctx) => all.every((p) => p(ctx)) && (any.length === 0 || any.some((p) => p(ctx)));
}

export function evaluateFilter(filter: FlowFilter, ctx: FlowContext): boolean {
  return compilePredicate(filter)(ctx);
}

export const ELSE_HANDLE = "else";

/** Structural view of a condition node — avoids importing the graph schema here. */
export interface BranchLike {
  id: string;
  when: FlowFilter;
}

/** First branch (array order) whose filter holds; "else" when none does. */
export function evaluateBranches(node: { branches: BranchLike[] }, ctx: FlowContext): string {
  for (const branch of node.branches) {
    if (evaluateFilter(branch.when, ctx)) return branch.id;
  }
  return ELSE_HANDLE;
}

// ─── Describe (Uzbek) ─────────────────────────────────────────────────────────

const OP_SYMBOL: Partial<Record<FlowOperator, string>> = { eq: "=", neq: "≠", gte: "≥", lte: "≤" };

function intentLabel(key: string): string {
  return BUILT_IN_INTENTS.find((intent) => intent.key === key)?.label ?? key;
}

export function describeConditionItem(cond: FlowCondition): string {
  const { field, op, value } = cond;
  const label = fieldSpec(field)?.label ?? field;
  const name = varsKey(field) ? `{{${field}}}` : label;
  const values = list(value).map(String);
  switch (op) {
    case "is_set":
      return `${name} bor`;
    case "not_set":
      return `${name} yo'q`;
    case "in":
      return `${name}: ${values.join(" yoki ")}`;
    case "contains":
      return `${name} ichida "${values[0] ?? ""}"`;
    case "keyword":
      return `${name}da kalit so'z: ${values.join(" / ")}`;
    case "intent":
      return `${name}da niyat: ${values.map(intentLabel).join(" / ")}`;
    case "eq":
      if (field === "window.open") return value ? "24 soatlik oyna ochiq" : "24 soatlik oyna yopiq";
      return `${name} = ${values[0] ?? ""}`;
    default:
      return `${name} ${OP_SYMBOL[op] ?? op} ${values[0] ?? ""}`;
  }
}

/** One Uzbek sentence: "Ball ≥ 70 va Teglar ichida "hot" va (Til = uz yoki Til = ru)". */
export function describeCondition(filter: FlowFilter): string {
  const parts = filter.all.map(describeConditionItem);
  const any = (filter.any ?? []).map(describeConditionItem);
  if (any.length === 1) parts.push(any[0]);
  else if (any.length > 1) parts.push(`(${any.join(" yoki ")})`);
  return parts.length > 0 ? parts.join(" va ") : "Har doim";
}
