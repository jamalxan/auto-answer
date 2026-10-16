/**
 * ETAP 6 — flow variables and `{{...}}` templating (analysis §1.2).
 *
 * Vocabulary (resolved lazily by the engine into a `FlowContext`):
 *   contact.name / username / phone / email / language
 *   vars.<key>            run variables (Button saveAs, AI ask, webhook saveAs, Action set)
 *   trigger.text / keyword / intent / source / mediaId
 *   last_message.text / at
 *   tags, score, temperature, audience, window.open, time.hour, time.weekday, run.sends
 *
 * Template syntax: `{{key}}`, `{{a.b}}`, `{{key|fallback}}`. Shorthands:
 * `{{name}}` = contact.name, `{{username}}` = contact.username,
 * `{{phone}}` = contact.phone, `{{email}}` = contact.email,
 * `{{product}}` = vars.product. Rendering is plain-text substitution (DMs are
 * plain text); an unknown key is an audit error at save time; an empty value
 * at runtime becomes the fallback or "" — the customer never sees raw braces.
 *
 * Pure: no database.
 */

export type VariableKind = "string" | "number" | "boolean" | "phone" | "email" | "list" | "datetime";

export interface VariableSpec {
  key: string;
  /** Shown in the variable picker (Uzbek). */
  label: string;
  kind: VariableKind;
  /** Where the engine reads it from. */
  source: "contact" | "trigger" | "conversation" | "crm" | "run" | "time";
}

export const VARIABLE_SPECS: VariableSpec[] = [
  { key: "contact.name", label: "Mijoz ismi", kind: "string", source: "contact" },
  { key: "contact.username", label: "Instagram username", kind: "string", source: "contact" },
  { key: "contact.phone", label: "Mijoz telefoni", kind: "phone", source: "contact" },
  { key: "contact.email", label: "Mijoz emaili", kind: "email", source: "contact" },
  { key: "contact.language", label: "Mijoz tili", kind: "string", source: "contact" },
  { key: "trigger.text", label: "Komment / xabar matni", kind: "string", source: "trigger" },
  { key: "trigger.keyword", label: "Mos kelgan kalit so'z", kind: "string", source: "trigger" },
  { key: "trigger.intent", label: "Mos kelgan niyat", kind: "string", source: "trigger" },
  { key: "trigger.source", label: "Manba (ADS / LINK / organic)", kind: "string", source: "trigger" },
  { key: "trigger.mediaId", label: "Post identifikatori", kind: "string", source: "trigger" },
  { key: "last_message.text", label: "Oxirgi xabar matni", kind: "string", source: "conversation" },
  { key: "last_message.at", label: "Oxirgi xabar vaqti", kind: "datetime", source: "conversation" },
  { key: "tags", label: "Teglar", kind: "list", source: "crm" },
  { key: "score", label: "Ball", kind: "number", source: "crm" },
  { key: "temperature", label: "Harorat (COLD / WARM / HOT)", kind: "string", source: "crm" },
  { key: "audience", label: "Auditoriya (NEW / RETURNING / REOPENED)", kind: "string", source: "trigger" },
  { key: "window.open", label: "24 soatlik oyna ochiq", kind: "boolean", source: "conversation" },
  { key: "time.hour", label: "Soat (Toshkent)", kind: "number", source: "time" },
  { key: "time.weekday", label: "Hafta kuni (1 = dushanba)", kind: "number", source: "time" },
  { key: "run.sends", label: "Yuborilgan xabarlar soni", kind: "number", source: "run" },
];

export const VARS_PREFIX = "vars.";

export const TEMPLATE_SHORTHANDS: Record<string, string> = {
  name: "contact.name",
  username: "contact.username",
  phone: "contact.phone",
  email: "contact.email",
  product: "vars.product",
};

const SPEC_KEYS = new Set(VARIABLE_SPECS.map((spec) => spec.key));
const VAR_KEY = /^[a-z][a-z0-9_]{0,31}$/;

/** `vars.<key>` → key, or null for every other path. */
export function varsKey(path: string): string | null {
  if (!path.startsWith(VARS_PREFIX)) return null;
  const key = path.slice(VARS_PREFIX.length);
  return VAR_KEY.test(key) ? key : null;
}

/** Shorthand → canonical path; everything else unchanged. */
export function canonicalKey(key: string): string {
  const trimmed = key.trim();
  return TEMPLATE_SHORTHANDS[trimmed] ?? trimmed;
}

/** True for a vocabulary key or any well-formed `vars.<key>`. */
export function isKnownVariable(path: string): boolean {
  const key = canonicalKey(path);
  return SPEC_KEYS.has(key) || varsKey(key) !== null;
}

// ─── Runtime context ──────────────────────────────────────────────────────────

export interface FlowContext {
  contact?: { name?: string | null; username?: string | null; phone?: string | null; email?: string | null; language?: string | null };
  vars?: Record<string, unknown>;
  trigger?: { text?: string | null; keyword?: string | null; intent?: string | null; source?: string | null; mediaId?: string | null };
  last_message?: { text?: string | null; at?: string | Date | null };
  tags?: string[];
  score?: number | null;
  temperature?: string | null;
  audience?: string | null;
  window?: { open?: boolean };
  time?: { hour?: number; weekday?: number };
  run?: { sends?: number };
}

/** Raw value at a canonical path (`contact.name`, `vars.city`, `tags`); undefined when absent. */
export function resolveVariable(path: string, ctx: FlowContext): unknown {
  const key = canonicalKey(path);
  const parts = key.split(".");
  let current: unknown = ctx;
  for (const part of parts) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

/** Plain-text form of a value ("" for empty / null / undefined). */
export function stringifyValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "";
  if (typeof value === "boolean") return value ? "ha" : "yo'q";
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? "" : value.toISOString();
  if (Array.isArray(value)) return value.map(stringifyValue).filter(Boolean).join(", ");
  return "";
}

// ─── Templates ────────────────────────────────────────────────────────────────

/** `{{ key }}` or `{{ key | fallback }}` — key up to the first `|`, no braces inside. */
const TEMPLATE_REF = /\{\{\s*([^{}|]*?)\s*(?:\|([^{}]*))?\}\}/g;

export interface TemplateRef {
  /** As written (shorthand kept). */
  raw: string;
  /** Canonical path. */
  key: string;
  fallback: string | null;
}

/** Every `{{...}}` reference in order of appearance. */
export function parseTemplateRefs(text: string): TemplateRef[] {
  const refs: TemplateRef[] = [];
  for (const match of text.matchAll(TEMPLATE_REF)) {
    const raw = match[1].trim();
    const fallback = match[2] === undefined ? null : match[2].trim();
    refs.push({ raw, key: canonicalKey(raw), fallback });
  }
  return refs;
}

/** Unique canonical keys used in a template. */
export function extractTemplateKeys(text: string): string[] {
  return [...new Set(parseTemplateRefs(text).map((ref) => ref.key))];
}

/**
 * Keys that are neither in the vocabulary nor a declared `vars.<key>`
 * (`declaredVars` = keys of the graph's `variables[]` plus anything a node
 * saves). Empty `{{}}` counts as unknown ("").
 */
export function validateTemplateKeys(text: string, declaredVars: Iterable<string> = []): string[] {
  const declared = new Set(declaredVars);
  const unknown: string[] = [];
  for (const key of extractTemplateKeys(text)) {
    if (SPEC_KEYS.has(key)) continue;
    const name = varsKey(key);
    if (name && declared.has(name)) continue;
    unknown.push(key);
  }
  return unknown;
}

export interface RenderResult {
  text: string;
  /** Canonical keys that resolved to nothing (fallback or "" was used). */
  missing: string[];
}

/**
 * Substitutes every reference; an empty value becomes the fallback or "".
 * No `{{` / `}}` ever survive — a malformed template loses its braces.
 */
export function renderTemplate(text: string, ctx: FlowContext): RenderResult {
  const missing: string[] = [];
  const rendered = text.replace(TEMPLATE_REF, (_match, rawKey: string, fallback: string | undefined) => {
    const key = canonicalKey(rawKey);
    const value = stringifyValue(resolveVariable(key, ctx)).trim();
    if (value) return value;
    if (!missing.includes(key)) missing.push(key);
    return (fallback ?? "").trim();
  });
  return { text: rendered.replace(/\{\{|\}\}/g, "").replace(/[ \t]{2,}/g, " ").trim(), missing };
}

/** Renders every value of a record (webhook body). */
export function renderTemplateRecord(values: Record<string, string>, ctx: FlowContext): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) out[key] = renderTemplate(value, ctx).text;
  return out;
}
