/**
 * ETAP 8 — Google Sheets row layout v1. One sheet per workspace, append
 * only; every event becomes one row aligned to SHEET_HEADERS. The column
 * list is frozen: adding a column means a v2 header list and a new tab,
 * never a shift of existing columns.
 */

import type { OutboundPayloadV1 } from "../events";

export const SHEET_HEADERS = [
  "event_at",
  "event",
  "lead_id",
  "name",
  "phone",
  "ig_username",
  "product",
  "score",
  "temperature",
  "source",
  "channel",
  "campaign",
  "keyword",
  "ad_id",
  "ref",
  "tags",
  "stage",
  "summary",
  "conversation_url",
  "is_test",
] as const;

export type SheetHeader = (typeof SHEET_HEADERS)[number];

export const DEFAULT_SHEET_NAME = "SocialAuto";

/** Asia/Tashkent is UTC+5 with no DST (same convention as reports / usage). */
export const TASHKENT_OFFSET_MIN = 5 * 60;

/** ISO 8601 with the +05:00 offset so the sheet shows local time without conversion. */
export function formatTashkent(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return typeof value === "string" ? value : "";
  const local = new Date(date.getTime() + TASHKENT_OFFSET_MIN * 60_000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return (
    `${local.getUTCFullYear()}-${pad(local.getUTCMonth() + 1)}-${pad(local.getUTCDate())}` +
    `T${pad(local.getUTCHours())}:${pad(local.getUTCMinutes())}:${pad(local.getUTCSeconds())}+05:00`
  );
}

export const yesNo = (value: boolean): string => (value ? "ha" : "yo'q");

/** A payload → one row of strings, column i = SHEET_HEADERS[i]. */
export function payloadToRow(payload: OutboundPayloadV1): string[] {
  const cells: Record<SheetHeader, string> = {
    event_at: formatTashkent(payload.occurred_at),
    event: payload.type,
    lead_id: payload.lead?.id ?? "",
    name: payload.lead?.name ?? "",
    phone: payload.lead?.phone ?? "",
    ig_username: payload.lead?.ig_username ?? "",
    product: payload.lead?.product ?? "",
    score: payload.score ? String(payload.score.value) : "",
    temperature: payload.score?.temperature ?? "",
    source: payload.source?.kind ?? "",
    channel: payload.source?.channel ?? "",
    campaign: payload.source?.campaign ?? "",
    keyword: payload.source?.keyword ?? "",
    ad_id: payload.source?.ad_id ?? "",
    ref: payload.source?.ref ?? "",
    tags: (payload.contact?.tags ?? []).join(", "),
    stage: payload.deal?.stage ?? "",
    summary: payload.lead?.summary ?? "",
    conversation_url: payload.lead?.conversation_url ?? "",
    is_test: yesNo(payload.is_test),
  };
  return SHEET_HEADERS.map((h) => cells[h]);
}

/** True when row 1 of the tab already is the v1 header list (prefix match, extra user columns allowed). */
export function headersMatch(existing: readonly (string | null | undefined)[] | null | undefined): boolean {
  if (!existing || existing.length < SHEET_HEADERS.length) return false;
  return SHEET_HEADERS.every((h, i) => (existing[i] ?? "").trim().toLowerCase() === h);
}
