/**
 * ETAP 8 — Webhook / Make / Zapier connector, request side.
 *
 * `buildWebhookRequest` turns a frozen payload into a signed `fetch` request
 * (POST JSON, no redirects, 10 s abort); `classifyWebhookResponse` maps the
 * outcome onto the delivery state machine; `sendWebhook` is the thin executor
 * the worker calls with the real `fetch` (tests pass a fake).
 *
 *   2xx                       → sent
 *   408 / 425 / 429 / 5xx     → retry (Retry-After honoured, ≤ 6h)
 *   network error / timeout   → retry
 *   410 Gone                  → dead_disable (subscription switched off)
 *   other 4xx, 3xx, 1xx       → dead
 */

import { RETRY_AFTER_MAX_MS, WEBHOOK_TIMEOUT_MS } from "../config";
import { maskSnippet, type OutboundPayloadV1 } from "../events";
import { signatureHeaders } from "../signing";

// ─── Request ──────────────────────────────────────────────────────────────────

export interface BuildWebhookRequestInput {
  url: string;
  secret: string;
  previousSecret?: string | null;
  event: { id: string; type: string };
  delivery: { id: string };
  payload: OutboundPayloadV1;
  now?: Date;
  timeoutMs?: number;
  userAgent?: string;
}

export interface WebhookRequest {
  url: string;
  init: RequestInit;
  /** Exact bytes that were signed. */
  body: string;
  /** Unix seconds, the X-SocialAuto-Timestamp value. */
  timestamp: number;
  headers: Record<string, string>;
  /** Clears the timeout timer; `sendWebhook` calls it, other executors must too. */
  release: () => void;
}

export const USER_AGENT = "SocialAuto-Webhooks/1.0";

export function buildWebhookRequest(input: BuildWebhookRequestInput): WebhookRequest {
  const body = JSON.stringify(input.payload);
  const timestamp = Math.floor((input.now ?? new Date()).getTime() / 1000);
  const headers: Record<string, string> = {
    "Content-Type": "application/json; charset=utf-8",
    "User-Agent": input.userAgent ?? USER_AGENT,
    ...signatureHeaders({
      event: input.event.type,
      eventId: input.event.id,
      deliveryId: input.delivery.id,
      timestamp,
      rawBody: body,
      secret: input.secret,
      previousSecret: input.previousSecret,
    }),
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new Error("timeout")), input.timeoutMs ?? WEBHOOK_TIMEOUT_MS);
  timer.unref?.();

  return {
    url: input.url,
    body,
    timestamp,
    headers,
    init: { method: "POST", headers, body, redirect: "manual", signal: controller.signal },
    release: () => clearTimeout(timer),
  };
}

// ─── Classification ───────────────────────────────────────────────────────────

export type WebhookOutcome = "sent" | "retry" | "dead" | "dead_disable";

export interface WebhookClassification {
  outcome: WebhookOutcome;
  /** Parsed `Retry-After`, clamped to RETRY_AFTER_MAX_MS; absent = use the schedule. */
  retryAfterMs?: number;
  /** Short operator-facing note (Uzbek). */
  note: string;
}

type HeaderSource = { get(name: string): string | null } | Record<string, string | undefined> | null | undefined;

function headerGet(headers: HeaderSource, name: string): string | null {
  if (!headers) return null;
  if (typeof (headers as { get?: unknown }).get === "function") {
    return (headers as { get(name: string): string | null }).get(name);
  }
  const record = headers as Record<string, string | undefined>;
  const key = Object.keys(record).find((k) => k.toLowerCase() === name.toLowerCase());
  return key ? (record[key] ?? null) : null;
}

/** Seconds or an HTTP date → milliseconds from `now`, clamped to [0, 6h]; null when absent / unparseable. */
export function parseRetryAfter(value: string | null | undefined, now: number = Date.now()): number | null {
  if (!value) return null;
  const text = value.trim();
  let ms: number;
  if (/^\d+$/.test(text)) ms = Number(text) * 1000;
  else {
    const date = Date.parse(text);
    if (Number.isNaN(date)) return null;
    ms = date - now;
  }
  return Math.max(0, Math.min(RETRY_AFTER_MAX_MS, ms));
}

const RETRYABLE_4XX = new Set([408, 425, 429]);

export function classifyWebhookResponse(
  status: number | null | undefined,
  headers?: HeaderSource,
  error?: unknown,
  now: number = Date.now()
): WebhookClassification {
  if (error || status === null || status === undefined) {
    const message = error instanceof Error ? error.message : error ? String(error) : "javob yo'q";
    const timeout = /abort|timeout/i.test(message);
    return { outcome: "retry", note: timeout ? "Javob kutish vaqti tugadi (10 s)" : `Tarmoq xatosi: ${maskSnippet(message, 120)}` };
  }
  if (status >= 200 && status < 300) return { outcome: "sent", note: `HTTP ${status}` };
  if (status === 410) return { outcome: "dead_disable", note: "HTTP 410 Gone — qabul qiluvchi o'chirilgan, obuna to'xtatildi" };
  if (status >= 500 || RETRYABLE_4XX.has(status)) {
    const retryAfterMs = parseRetryAfter(headerGet(headers, "retry-after"), now);
    return {
      outcome: "retry",
      ...(retryAfterMs !== null && retryAfterMs > 0 ? { retryAfterMs } : {}),
      note: `HTTP ${status} — qayta uriniladi`,
    };
  }
  if (status >= 300 && status < 400) return { outcome: "dead", note: `HTTP ${status} — yo'naltirishlar (redirect) qabul qilinmaydi` };
  return { outcome: "dead", note: `HTTP ${status} — qabul qiluvchi rad etdi` };
}

// ─── Executor ─────────────────────────────────────────────────────────────────

export type FetchImpl = (url: string, init: RequestInit) => Promise<Response>;

export interface WebhookSendResult {
  status: number | null;
  /** Response body (or error message), phones masked, ≤ 300 chars. */
  snippet: string;
  durationMs: number;
  classification: WebhookClassification;
}

/** Performs the request; never throws — network errors become a `retry` classification. */
export async function sendWebhook(req: WebhookRequest, fetchImpl: FetchImpl = fetch, now: () => number = Date.now): Promise<WebhookSendResult> {
  const started = now();
  try {
    const response = await fetchImpl(req.url, req.init);
    let text = "";
    try {
      text = await response.text();
    } catch {
      text = "";
    }
    return {
      status: response.status,
      snippet: maskSnippet(text),
      durationMs: now() - started,
      classification: classifyWebhookResponse(response.status, response.headers, undefined, now()),
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      status: null,
      snippet: maskSnippet(message),
      durationMs: now() - started,
      classification: classifyWebhookResponse(null, undefined, error, now()),
    };
  } finally {
    req.release();
  }
}
