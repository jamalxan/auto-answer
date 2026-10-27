/**
 * JSON calls for the Graph-style APIs (Facebook, Threads) and Google
 * (YouTube), on top of channelFetch (timeouts, retries, 429, tenant cap),
 * with each platform's error body mapped onto ChannelError kinds:
 *
 *   Meta     190 / 102 / 463 → auth · 10 / 200–299 → permission ·
 *            4 / 17 / 32 / 613 / 80001–80014 → rate_limit ·
 *            2534022 / 551 → window_closed · everything else → invalid
 *   Google   401 → auth · quotaExceeded / dailyLimitExceeded → rate_limit
 *            (until Pacific midnight) · 403 other → permission ·
 *            invalid_grant (token endpoint) → auth · everything else → invalid
 *
 * Messages never include the URL: query strings carry access tokens.
 */

import { channelFetch } from "./http";
import { ChannelError } from "./types";

export interface CallOptions {
  method?: string;
  body?: unknown;
  form?: Record<string, string>;
  headers?: Record<string, string>;
  tenantId?: string | null;
  idempotencyKey?: string;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface MetaErrorBody {
  error?: { message?: string; code?: number; error_subcode?: number; type?: string };
}

const META_RATE = new Set([4, 17, 32, 613]);

export function metaError(status: number, body: MetaErrorBody, label: string): ChannelError {
  const code = body.error?.code;
  const sub = body.error?.error_subcode;
  const message = (body.error?.message ?? `HTTP ${status}`).slice(0, 200);
  if (code === 190 || code === 102 || code === 463 || sub === 463 || sub === 460) return new ChannelError("auth", `${label} ulanishi eskirgan — qayta ulang`);
  if (code !== undefined && (META_RATE.has(code) || (code >= 80001 && code <= 80014))) return new ChannelError("rate_limit", `${label} so'rovlarni cheklab qo'ydi`, 3600);
  if (sub === 2534022 || code === 551 || sub === 2018278) return new ChannelError("window_closed", "Xabar yuborish oynasi yopiq");
  if (code === 10 || (code !== undefined && code >= 200 && code <= 299)) return new ChannelError("permission", `${label} ruxsati yetarli emas: ${message}`);
  if (status >= 500) return new ChannelError("transient", `${label} vaqtincha javob bermadi`);
  return new ChannelError("invalid", `${label}: ${message}`);
}

/** Seconds until the next midnight in America/Los_Angeles (YouTube quota reset). */
export function secondsToPacificMidnight(now = new Date()): number {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: "America/Los_Angeles", hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23" }).formatToParts(now);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const elapsed = get("hour") * 3600 + get("minute") * 60 + get("second");
  return Math.max(60, 86_400 - elapsed);
}

interface GoogleErrorBody {
  error?: string | { code?: number; message?: string; errors?: Array<{ reason?: string }> };
  error_description?: string;
}

export function googleError(status: number, body: GoogleErrorBody, now = new Date()): ChannelError {
  if (typeof body.error === "string") {
    if (body.error === "invalid_grant" || body.error === "unauthorized_client") return new ChannelError("auth", "Google ruxsati bekor qilingan — YouTube'ni qayta ulang");
    return new ChannelError("invalid", `Google: ${body.error_description ?? body.error}`);
  }
  const reasons = (body.error?.errors ?? []).map((e) => e.reason ?? "");
  const message = (body.error?.message ?? `HTTP ${status}`).slice(0, 200);
  if (reasons.some((r) => r === "quotaExceeded" || r === "dailyLimitExceeded")) return new ChannelError("rate_limit", "YouTube kunlik kvotasi tugadi", secondsToPacificMidnight(now));
  if (reasons.includes("uploadLimitExceeded")) return new ChannelError("rate_limit", "YouTube yuklash limiti tugadi", secondsToPacificMidnight(now));
  if (status === 401) return new ChannelError("auth", "YouTube ulanishi eskirgan — qayta ulang");
  if (status === 403) return new ChannelError("permission", `YouTube ruxsati yetarli emas: ${message}`);
  if (status === 429) return new ChannelError("rate_limit", "YouTube so'rovlarni cheklab qo'ydi", 60);
  if (status >= 500) return new ChannelError("transient", "YouTube vaqtincha javob bermadi");
  return new ChannelError("invalid", `YouTube: ${message}`);
}

async function call(url: string, opts: CallOptions): Promise<{ status: number; body: unknown; headers: Headers }> {
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  let body: BodyInit | undefined;
  if (opts.form) {
    body = new URLSearchParams(opts.form);
    headers["Content-Type"] = "application/x-www-form-urlencoded";
  } else if (opts.body !== undefined) {
    body = JSON.stringify(opts.body);
    headers["Content-Type"] = "application/json";
  }
  const response = await channelFetch(url, {
    method: opts.method ?? (body ? "POST" : "GET"),
    headers,
    body,
    tenantId: opts.tenantId,
    idempotencyKey: opts.idempotencyKey,
    timeoutMs: opts.timeoutMs,
    fetchImpl: opts.fetchImpl,
  });
  const text = await response.text();
  let parsed: unknown = {};
  try {
    parsed = text ? JSON.parse(text) : {};
  } catch {
    parsed = { raw: text.slice(0, 200) };
  }
  return { status: response.status, body: parsed, headers: response.headers };
}

export async function metaJson<T>(url: string, label: string, opts: CallOptions = {}): Promise<T> {
  const { status, body } = await call(url, opts);
  if (status >= 400 || (body as MetaErrorBody).error) throw metaError(status, body as MetaErrorBody, label);
  return body as T;
}

export async function googleJson<T>(url: string, opts: CallOptions = {}): Promise<T> {
  const { status, body } = await call(url, opts);
  if (status >= 400 || (typeof (body as GoogleErrorBody).error === "string")) throw googleError(status, body as GoogleErrorBody);
  return body as T;
}

/** Google resumable upload start: the session URI is in the Location header. */
export async function googleUploadSession(url: string, opts: CallOptions): Promise<string> {
  const { status, body, headers } = await call(url, opts);
  if (status >= 400) throw googleError(status, body as GoogleErrorBody);
  const location = headers.get("location");
  if (!location) throw new ChannelError("transient", "YouTube yuklash sessiyasi ochilmadi");
  return location;
}
