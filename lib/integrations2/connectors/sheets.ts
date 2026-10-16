/**
 * ETAP 8 — Google Sheets connector.
 *
 * credentials  { client_email, private_key }          (tenant service account, encrypted)
 * config       { spreadsheetId, sheetName }           (one sheet per workspace, append-only)
 *
 * Flow per delivery: access token (Redis cache ~50 min, memory fallback) →
 * once per tab: read row 1, add the tab when it is missing and write the
 * v1 header row (a tab that already holds something else is refused rather
 * than overwritten) → `values:append` with the payload row.
 *
 * Errors: 401 → auth (key revoked); 403 / 404 → the owner has to fix the
 * sharing or the id, so the integration is marked BROKEN and the deliveries
 * wait (a successful "Test connection" releases them); 429 / 5xx / network →
 * retry; other 4xx → DEAD.
 */

import type { Integration } from "@/app/generated/prisma/client";
import { z } from "zod";
import { IntegrationAuthError } from "@/lib/integrations/errors";
import { SHEETS_TOKEN_CACHE_SEC, OUTBOUND_EVENT_TYPES } from "../config";
import { maskSnippet } from "../events";
import { kvDel, kvGet, kvSet } from "../kv";
import { readSheetsCredentials, type SheetsCredentials } from "../secrets";
import {
  buildAddSheetRequest,
  buildAppendRequest,
  buildHeaderReadRequest,
  buildHeaderWriteRequest,
  buildJwtAssertion,
  buildTokenRequest,
  classifySheetsError,
  parseTokenResponse,
  tokenCacheKey,
  type HttpRequest,
} from "./sheets-auth";
import { DEFAULT_SHEET_NAME, SHEET_HEADERS, headersMatch, payloadToRow } from "./sheets-rows";
import type { ConnectionCheckResult, ConnectorResult, OutboundConnector, SendContext } from "./types";

export const sheetsConfigSchema = z.object({
  spreadsheetId: z.string().trim().min(10).max(200),
  sheetName: z.string().trim().min(1).max(100).default(DEFAULT_SHEET_NAME),
});

export type SheetsConfig = z.infer<typeof sheetsConfigSchema>;

export function readSheetsConfig(value: unknown): SheetsConfig | null {
  const parsed = sheetsConfigSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}

const HTTP_TIMEOUT_MS = 15_000;
const HEADERS_OK_TTL_SEC = 24 * 3600;

interface Reply {
  status: number | null;
  body: unknown;
  error?: string;
}

async function call(request: HttpRequest): Promise<Reply> {
  try {
    const response = await globalThis.fetch(request.url, { ...request.init, signal: AbortSignal.timeout(HTTP_TIMEOUT_MS) });
    const text = await response.text().catch(() => "");
    let body: unknown = text;
    try {
      body = text ? JSON.parse(text) : null;
    } catch {
      body = text;
    }
    return { status: response.status, body };
  } catch (error) {
    return { status: null, body: null, error: error instanceof Error ? error.message : String(error) };
  }
}

function snippetOf(reply: Reply): string {
  return maskSnippet(typeof reply.body === "string" ? reply.body : reply.body ? JSON.stringify(reply.body) : (reply.error ?? ""));
}

const networkRetry = (reply: Reply): ConnectorResult => ({
  outcome: "retry",
  note: `Google'ga ulanib bo'lmadi: ${maskSnippet(reply.error ?? "javob yo'q", 120)}`,
  responseSnippet: maskSnippet(reply.error ?? ""),
});

/** Maps a failed Sheets call onto a connector outcome. */
function failure(reply: Reply, clientEmail: string): ConnectorResult {
  if (reply.status === null) return networkRetry(reply);
  const classified = classifySheetsError(reply.status, reply.body, clientEmail);
  const common = { note: classified.message, responseCode: reply.status, responseSnippet: snippetOf(reply) };
  switch (classified.kind) {
    case "retry":
      return { outcome: "retry", ...common };
    case "dead":
      return { outcome: "dead", ...common };
    default:
      // auth / permission / config: the owner must act; hold and flag the integration.
      return { outcome: "auth", ...common };
  }
}

type TokenResult = { ok: true; token: string; cached: boolean } | { ok: false; result: ConnectorResult };

async function accessToken(integrationId: string, credentials: SheetsCredentials, fresh = false): Promise<TokenResult> {
  const key = tokenCacheKey(integrationId);
  if (!fresh) {
    const cached = await kvGet(key);
    if (cached) return { ok: true, token: cached, cached: true };
  }
  let assertion: string;
  try {
    assertion = buildJwtAssertion({ clientEmail: credentials.client_email, privateKey: credentials.private_key });
  } catch {
    return {
      ok: false,
      result: { outcome: "auth", note: "Service account private_key o'qilmadi — kalit faylini qayta yuklang" },
    };
  }
  const reply = await call(buildTokenRequest(assertion));
  if (reply.status === null) return { ok: false, result: networkRetry(reply) };
  const token = reply.status >= 200 && reply.status < 300 ? parseTokenResponse(reply.body) : null;
  if (!token) {
    const common = { responseCode: reply.status, responseSnippet: snippetOf(reply) };
    if (reply.status === 429 || reply.status >= 500) {
      return { ok: false, result: { outcome: "retry", note: `Google token olinmadi (HTTP ${reply.status})`, ...common } };
    }
    return {
      ok: false,
      result: { outcome: "auth", note: `Google service account tokenni rad etdi (HTTP ${reply.status}) — kalitni qayta yuklang`, ...common },
    };
  }
  await kvSet(key, token.accessToken, Math.min(SHEETS_TOKEN_CACHE_SEC, Math.max(60, token.expiresInSec - 300)));
  return { ok: true, token: token.accessToken, cached: false };
}

const headersKey = (integrationId: string, sheetName: string) => `integrations2:sheets:headers:${integrationId}:${sheetName}`;

function isMissingTab(reply: Reply): boolean {
  return reply.status === 400 && /unable to parse range/i.test(JSON.stringify(reply.body ?? ""));
}

/** Makes sure row 1 of the tab is the v1 header row. Returns an outcome only when something is wrong. */
async function ensureHeaders(
  integrationId: string,
  target: { spreadsheetId: string; sheetName: string; accessToken: string },
  clientEmail: string
): Promise<ConnectorResult | null> {
  const key = headersKey(integrationId, target.sheetName);
  if (await kvGet(key)) return null;

  const read = await call(buildHeaderReadRequest(target));
  let needWrite = false;
  if (read.status !== null && read.status >= 200 && read.status < 300) {
    const rows = (read.body as { values?: unknown[][] } | null)?.values;
    const first = Array.isArray(rows?.[0]) ? (rows![0] as unknown[]).map((v) => String(v ?? "")) : [];
    if (first.length === 0 || first.every((cell) => !cell.trim())) needWrite = true;
    else if (!headersMatch(first)) {
      return {
        outcome: "auth",
        note: `«${target.sheetName}» varag'ining 1-qatorida boshqa ma'lumot bor. Boshqa varaq nomini kiriting yoki bo'sh varaq oching — mavjud ma'lumotga tegilmaydi.`,
        responseCode: read.status,
      };
    }
  } else if (isMissingTab(read)) {
    const added = await call(buildAddSheetRequest(target));
    if (added.status === null || added.status < 200 || added.status >= 300) return failure(added, clientEmail);
    needWrite = true;
  } else {
    return failure(read, clientEmail);
  }

  if (needWrite) {
    const written = await call(buildHeaderWriteRequest({ ...target, headers: SHEET_HEADERS }));
    if (written.status === null || written.status < 200 || written.status >= 300) return failure(written, clientEmail);
  }
  await kvSet(key, "1", HEADERS_OK_TTL_SEC);
  return null;
}

export function sheetUrl(spreadsheetId: string): string {
  return `https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`;
}

export const sheetsConnector: OutboundConnector = {
  supports: (type) => (OUTBOUND_EVENT_TYPES as readonly string[]).includes(type),

  async send(context: SendContext): Promise<ConnectorResult> {
    const config = readSheetsConfig(context.integration.config);
    const credentials = readSheetsCredentials(context.integration);
    if (!config || !credentials) {
      return { outcome: "auth", note: "Google Sheets sozlamalari yoki kalit o'qilmadi — integratsiyani qayta ulang" };
    }
    const started = Date.now();
    const integrationId = context.integration.id;

    let token = await accessToken(integrationId, credentials);
    if (!token.ok) return token.result;
    const target = () => ({ spreadsheetId: config.spreadsheetId, sheetName: config.sheetName, accessToken: (token as { token: string }).token });

    let problem = await ensureHeaders(integrationId, target(), credentials.client_email);
    if (problem?.outcome === "auth" && problem.responseCode === 401 && token.cached) {
      // A cached token can be revoked early: fetch a fresh one once.
      await kvDel(tokenCacheKey(integrationId));
      token = await accessToken(integrationId, credentials, true);
      if (!token.ok) return token.result;
      problem = await ensureHeaders(integrationId, target(), credentials.client_email);
    }
    if (problem) return problem;

    let reply = await call(buildAppendRequest({ ...target(), row: payloadToRow(context.payload) }));
    if (reply.status === 401 && token.cached) {
      await kvDel(tokenCacheKey(integrationId));
      token = await accessToken(integrationId, credentials, true);
      if (!token.ok) return token.result;
      reply = await call(buildAppendRequest({ ...target(), row: payloadToRow(context.payload) }));
    }
    if (reply.status === null || reply.status < 200 || reply.status >= 300) return failure(reply, credentials.client_email);

    const updatedRange = (reply.body as { updates?: { updatedRange?: string } } | null)?.updates?.updatedRange ?? null;
    return {
      outcome: "sent",
      responseCode: reply.status,
      responseSnippet: updatedRange ? maskSnippet(updatedRange) : "",
      externalId: updatedRange,
      externalUrl: sheetUrl(config.spreadsheetId),
      durationMs: Date.now() - started,
    };
  },

  async check(integration: Integration): Promise<ConnectionCheckResult> {
    const config = readSheetsConfig(integration.config);
    const credentials = readSheetsCredentials(integration);
    if (!config || !credentials) return { ok: false, reason: "auth", message: "Google Sheets sozlamalari o'qilmadi" };
    try {
      const token = await accessToken(integration.id, credentials, true);
      if (!token.ok) {
        throw new IntegrationAuthError("google_sheets", token.result.outcome === "retry" ? token.result.note : (token.result as { note: string }).note);
      }
      const read = await call(buildHeaderReadRequest({ ...config, accessToken: token.token }));
      if ((read.status !== null && read.status >= 200 && read.status < 300) || isMissingTab(read)) return { ok: true };
      const outcome = failure(read, credentials.client_email);
      const message = "note" in outcome && outcome.note ? outcome.note : "Google Sheets javob bermadi";
      return { ok: false, reason: outcome.outcome === "auth" ? "auth" : "error", message };
    } catch (error) {
      if (error instanceof IntegrationAuthError) return { ok: false, reason: "auth", message: error.message };
      return { ok: false, reason: "error", message: error instanceof Error ? error.message : String(error) };
    }
  },
};
