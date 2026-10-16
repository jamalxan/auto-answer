/**
 * ETAP 8 — Google Sheets connector, request side (no dependency: the
 * service-account JWT is signed with node:crypto).
 *
 *   service account JSON ─▶ parseServiceAccountJson
 *   buildJwtAssertion (RS256) ─▶ buildTokenRequest ─▶ parseTokenResponse
 *   access token (Redis, tokenCacheKey, ~50 min) ─▶ buildAppendRequest /
 *   buildHeaderReadRequest / buildHeaderWriteRequest / buildAddSheetRequest
 *   non-2xx ─▶ classifySheetsError
 *
 * Every builder returns `{ url, init }` for `fetch`; nothing here performs
 * a request. The worker wires them together and caches the token.
 */

import { createSign } from "node:crypto";
import { z } from "zod";

export const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
export const SHEETS_API = "https://sheets.googleapis.com/v4/spreadsheets";
export const SHEETS_SCOPE = "https://www.googleapis.com/auth/spreadsheets";
export const JWT_TTL_SEC = 3600;

// ─── Service account ──────────────────────────────────────────────────────────

export const serviceAccountSchema = z.object({
  type: z.literal("service_account"),
  client_email: z.email(),
  private_key: z.string().regex(/^-----BEGIN (RSA )?PRIVATE KEY-----[\s\S]+-----END (RSA )?PRIVATE KEY-----\s*$/),
  project_id: z.string().optional(),
});

export interface ServiceAccount {
  client_email: string;
  private_key: string;
  project_id: string | null;
}

export type ParseServiceAccountResult = { ok: true; account: ServiceAccount } | { ok: false; reason: string };

/** The downloaded key file → the three fields we store (encrypted). Rejects OAuth client / API key files. */
export function parseServiceAccountJson(text: string): ParseServiceAccountResult {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return { ok: false, reason: "Fayl JSON formatida emas" };
  }
  if (raw && typeof raw === "object" && (raw as { type?: unknown }).type !== "service_account") {
    return { ok: false, reason: "Bu service account kaliti emas (type: service_account bo'lishi kerak). Google Cloud → IAM → Service accounts → Keys → JSON." };
  }
  // Some copy-paste paths keep the key's newlines as literal "\n".
  const record = raw && typeof raw === "object" ? { ...(raw as Record<string, unknown>) } : raw;
  if (record && typeof record === "object" && typeof (record as { private_key?: unknown }).private_key === "string") {
    (record as { private_key: string }).private_key = (record as { private_key: string }).private_key.replace(/\\n/g, "\n");
  }
  const parsed = serviceAccountSchema.safeParse(record);
  if (!parsed.success) {
    return { ok: false, reason: "Kalit faylida client_email yoki private_key yo'q yoki noto'g'ri" };
  }
  return {
    ok: true,
    account: {
      client_email: parsed.data.client_email,
      private_key: parsed.data.private_key,
      project_id: parsed.data.project_id ?? null,
    },
  };
}

// ─── JWT ──────────────────────────────────────────────────────────────────────

function base64url(value: string | Buffer): string {
  return Buffer.from(value).toString("base64url");
}

export interface JwtAssertionInput {
  clientEmail: string;
  /** PEM (PKCS#8 or PKCS#1). */
  privateKey: string;
  now?: Date;
  scope?: string;
  audience?: string;
  ttlSec?: number;
}

/** `header.payload.signature`, RS256, for the JWT-bearer grant. */
export function buildJwtAssertion(input: JwtAssertionInput): string {
  const iat = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const claims = base64url(
    JSON.stringify({
      iss: input.clientEmail,
      scope: input.scope ?? SHEETS_SCOPE,
      aud: input.audience ?? GOOGLE_TOKEN_URL,
      iat,
      exp: iat + (input.ttlSec ?? JWT_TTL_SEC),
    })
  );
  const signingInput = `${header}.${claims}`;
  const signature = createSign("RSA-SHA256").update(signingInput).end().sign(input.privateKey, "base64url");
  return `${signingInput}.${signature}`;
}

export interface HttpRequest {
  url: string;
  init: RequestInit;
}

export function buildTokenRequest(assertion: string): HttpRequest {
  const body = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    assertion,
  }).toString();
  return {
    url: GOOGLE_TOKEN_URL,
    init: {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body,
    },
  };
}

const tokenResponseSchema = z.object({
  access_token: z.string().min(1),
  expires_in: z.number().int().positive(),
  token_type: z.string().optional(),
});

export interface AccessToken {
  accessToken: string;
  expiresInSec: number;
}

/** Token endpoint JSON → `{ accessToken, expiresInSec }`, or null when it is not a token. */
export function parseTokenResponse(json: unknown): AccessToken | null {
  const parsed = tokenResponseSchema.safeParse(json);
  if (!parsed.success) return null;
  return { accessToken: parsed.data.access_token, expiresInSec: parsed.data.expires_in };
}

export function tokenCacheKey(integrationId: string): string {
  return `integrations2:sheets:token:${integrationId}`;
}

// ─── Spreadsheet requests ─────────────────────────────────────────────────────

/** A pasted sheet URL or a bare id → the spreadsheet id, or null. */
export function parseSpreadsheetId(input: string): string | null {
  const text = input.trim();
  const fromUrl = text.match(/\/spreadsheets\/d\/([a-zA-Z0-9_-]{20,})/);
  if (fromUrl) return fromUrl[1];
  return /^[a-zA-Z0-9_-]{20,}$/.test(text) ? text : null;
}

/** `'Leads'!A1` — always quoted so names with spaces / apostrophes work. */
export function sheetRange(sheetName: string, cells: string): string {
  return `'${sheetName.replace(/'/g, "''")}'!${cells}`;
}

function authHeaders(accessToken: string, json = true): Record<string, string> {
  return {
    Authorization: `Bearer ${accessToken}`,
    ...(json ? { "Content-Type": "application/json" } : {}),
  };
}

export interface SheetTarget {
  spreadsheetId: string;
  sheetName: string;
  accessToken: string;
}

/** `values:append` with RAW input so phones / ids stay strings. */
export function buildAppendRequest(input: SheetTarget & { row: string[] }): HttpRequest {
  const range = encodeURIComponent(sheetRange(input.sheetName, "A1"));
  return {
    url: `${SHEETS_API}/${encodeURIComponent(input.spreadsheetId)}/values/${range}:append?valueInputOption=RAW&insertDataOption=INSERT_ROWS`,
    init: {
      method: "POST",
      headers: authHeaders(input.accessToken),
      body: JSON.stringify({ majorDimension: "ROWS", values: [input.row] }),
    },
  };
}

/** Row 1 of the tab — the worker compares it with SHEET_HEADERS before the first append. */
export function buildHeaderReadRequest(input: SheetTarget): HttpRequest {
  const range = encodeURIComponent(sheetRange(input.sheetName, "1:1"));
  return {
    url: `${SHEETS_API}/${encodeURIComponent(input.spreadsheetId)}/values/${range}?majorDimension=ROWS`,
    init: { method: "GET", headers: authHeaders(input.accessToken, false) },
  };
}

export function buildHeaderWriteRequest(input: SheetTarget & { headers: readonly string[] }): HttpRequest {
  const range = encodeURIComponent(sheetRange(input.sheetName, "A1"));
  return {
    url: `${SHEETS_API}/${encodeURIComponent(input.spreadsheetId)}/values/${range}?valueInputOption=RAW`,
    init: {
      method: "PUT",
      headers: authHeaders(input.accessToken),
      body: JSON.stringify({ majorDimension: "ROWS", values: [[...input.headers]] }),
    },
  };
}

/** `batchUpdate` adding the missing tab (404 on the range → add the sheet → write headers). */
export function buildAddSheetRequest(input: SheetTarget): HttpRequest {
  return {
    url: `${SHEETS_API}/${encodeURIComponent(input.spreadsheetId)}:batchUpdate`,
    init: {
      method: "POST",
      headers: authHeaders(input.accessToken),
      body: JSON.stringify({ requests: [{ addSheet: { properties: { title: input.sheetName } } }] }),
    },
  };
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export type SheetsErrorKind = "auth" | "permission" | "config" | "retry" | "dead";

export interface SheetsErrorClassification {
  kind: SheetsErrorKind;
  message: string;
}

function googleErrorText(body: unknown): string {
  if (typeof body === "string") return body.slice(0, 200);
  const error = (body as { error?: { message?: unknown; status?: unknown } } | null)?.error;
  if (error && typeof error === "object") {
    const message = typeof error.message === "string" ? error.message : "";
    const status = typeof error.status === "string" ? error.status : "";
    return [status, message].filter(Boolean).join(": ").slice(0, 200);
  }
  return "";
}

/**
 * 401 → auth (key revoked: integration BROKEN) · 403 → permission (sheet not
 * shared with the service account) · 404 → config (spreadsheet / tab) ·
 * 429 / 5xx → retry · other → dead.
 */
export function classifySheetsError(status: number, body?: unknown, clientEmail?: string | null): SheetsErrorClassification {
  const detail = googleErrorText(body);
  const suffix = detail ? ` (${detail})` : "";
  if (status === 401) return { kind: "auth", message: `Service account kaliti qabul qilinmadi — kalitni qayta yuklang${suffix}` };
  if (status === 403) {
    const who = clientEmail ? ` ${clientEmail}` : " service account";
    return { kind: "permission", message: `Jadvalga kirish yo'q. Google Sheets'da «Share» orqali${who} manziliga Editor huquqini bering${suffix}` };
  }
  if (status === 404) return { kind: "config", message: `Jadval yoki varaq topilmadi — spreadsheet ID va varaq nomini tekshiring${suffix}` };
  if (status === 429 || status >= 500) return { kind: "retry", message: `Google vaqtincha javob bermadi (HTTP ${status}) — qayta uriniladi${suffix}` };
  return { kind: "dead", message: `Google Sheets rad etdi (HTTP ${status})${suffix}` };
}
