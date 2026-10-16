/**
 * ETAP 11 — ManyChat Page API response shapes, TOLERANT by design.
 *
 * UNVERIFIED: these shapes follow ManyChat's public API documentation
 * (https://api.manychat.com/swagger) as remembered, NOT a live call. Every
 * field is optional with a fallback, unknown fields are ignored, and a list
 * may arrive as `data: []`, `data: { <name>: [] }` or `data: { items: [] }`.
 * The first real key will confirm or correct them; the normalisers below are
 * the only place that needs to change. Envelope: `{ "status": "success", "data": ... }`.
 */

import { z } from "zod";

export const envelopeSchema = z.object({ status: z.string().optional(), data: z.unknown().optional(), message: z.string().optional() }).passthrough();

const str = (value: unknown): string => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");
const optStr = (value: unknown): string | null => str(value) || null;

const record = (value: unknown): Record<string, unknown> => (value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {});

export interface ManychatPageInfo {
  id: string | null;
  name: string | null;
  username: string | null;
  category: string | null;
  isPro: boolean | null;
  timezone: string | null;
}

export interface ManychatTag {
  id: string;
  name: string;
}

export interface ManychatCustomField {
  id: string;
  name: string;
  /** text | number | date | datetime | boolean | array | ... as ManyChat spells it (lowercased); "text" when absent. */
  type: string;
  description: string | null;
}

export interface ManychatBotField {
  id: string;
  name: string;
  type: string;
  /** Always stringified (bot fields are short texts / numbers). */
  value: string | null;
}

export interface ManychatFlow {
  /** `ns` — the flow's namespace id, e.g. "content20240101123456_123456". */
  ns: string;
  name: string;
  folder: string | null;
}

export interface ManychatGrowthTool {
  id: string;
  name: string;
  type: string | null;
}

/** Finds the array of rows in a response whatever the wrapper is. */
export function extractRows(data: unknown, preferredKeys: readonly string[] = []): Record<string, unknown>[] {
  const toRows = (value: unknown) => (Array.isArray(value) ? value.filter((row): row is Record<string, unknown> => !!row && typeof row === "object" && !Array.isArray(row)) : null);
  const direct = toRows(data);
  if (direct) return direct;
  const obj = record(data);
  for (const key of [...preferredKeys, "items", "data", "list"]) {
    const rows = toRows(obj[key]);
    if (rows) return rows;
  }
  for (const value of Object.values(obj)) {
    const rows = toRows(value);
    if (rows) return rows;
  }
  return [];
}

export function normalizePageInfo(data: unknown): ManychatPageInfo {
  const d = record(data);
  return {
    id: optStr(d.id) ?? optStr(d.page_id),
    name: optStr(d.name) ?? optStr(d.title),
    username: optStr(d.username),
    category: optStr(d.category),
    isPro: typeof d.is_pro === "boolean" ? d.is_pro : null,
    timezone: optStr(d.timezone),
  };
}

export function normalizeTags(data: unknown): ManychatTag[] {
  return extractRows(data, ["tags"])
    .map((row) => ({ id: str(row.id) || str(row.tag_id), name: str(row.name) || str(row.title) }))
    .filter((tag) => tag.name);
}

export function normalizeCustomFields(data: unknown): ManychatCustomField[] {
  return extractRows(data, ["custom_fields", "fields"])
    .map((row) => ({
      id: str(row.id) || str(row.field_id),
      name: str(row.name),
      type: (str(row.type) || "text").toLowerCase(),
      description: optStr(row.description),
    }))
    .filter((field) => field.name);
}

export function normalizeBotFields(data: unknown): ManychatBotField[] {
  return extractRows(data, ["bot_fields", "fields"])
    .map((row) => {
      const raw = row.value;
      const value = raw === null || raw === undefined ? null : typeof raw === "object" ? JSON.stringify(raw) : String(raw);
      return { id: str(row.id) || str(row.field_id), name: str(row.name), type: (str(row.type) || "text").toLowerCase(), value };
    })
    .filter((field) => field.name);
}

export function normalizeFlows(data: unknown): ManychatFlow[] {
  const d = record(data);
  const folders = new Map<string, string>();
  for (const folder of extractRows(d.folders ?? [], ["folders"])) {
    const id = str(folder.id) || str(folder.folder_id);
    if (id) folders.set(id, str(folder.name));
  }
  return extractRows(data, ["flows"])
    .map((row) => {
      const folderId = str(row.folder_id);
      return {
        ns: str(row.ns) || str(row.id) || str(row.flow_ns),
        name: str(row.name),
        folder: optStr(row.folder_name) ?? (folderId ? folders.get(folderId) ?? null : null),
      };
    })
    .filter((flow) => flow.ns && flow.name);
}

export function normalizeGrowthTools(data: unknown): ManychatGrowthTool[] {
  return extractRows(data, ["growth_tools", "tools"])
    .map((row) => ({ id: str(row.id) || str(row.ns) || str(row.growth_tool_id), name: str(row.name), type: optStr(row.type) }))
    .filter((tool) => tool.id && tool.name);
}
