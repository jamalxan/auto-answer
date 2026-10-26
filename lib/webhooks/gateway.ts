/**
 * Webhook gateway helpers (audit 2026-10-26, T2), shared by every inbound
 * webhook route (Meta, Telegram, later Facebook / Threads / YouTube):
 *
 *   - a hard body size limit, read before parsing (a 50 MB "event" never
 *     reaches JSON.parse)
 *   - dedup of (channel, external event id) in Redis for 48 h: a redelivery
 *     answers 200 and is not processed again
 *   - rejected requests (bad signature / secret) are logged rate-limited and
 *     without the body: an attacker cannot flood the database or plant data
 *     in the logs
 *
 * Signature checks stay next to their channel (lib/meta/webhook, the
 * Telegram route): they need the channel's own secret.
 */

import { createHash } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { getRedisConnection } from "@/lib/queue/client";

export const MAX_WEBHOOK_BODY_BYTES = 1_000_000;
export const DEDUP_TTL_SEC = 48 * 3600;
const REJECT_LOGS_PER_MINUTE = 5;

export type BodyResult = { ok: true; body: string } | { ok: false; status: 413 | 400 };

/** Reads the body as text, refusing anything over the limit (declared or actual). */
export async function readLimitedBody(request: Request, max = MAX_WEBHOOK_BODY_BYTES): Promise<BodyResult> {
  const declared = Number(request.headers.get("content-length") ?? "");
  if (Number.isFinite(declared) && declared > max) return { ok: false, status: 413 };
  if (!request.body) return { ok: true, body: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return { ok: false, status: 413 };
    }
    chunks.push(value);
  }
  try {
    return { ok: true, body: new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)) };
  } catch {
    return { ok: false, status: 400 };
  }
}

export function bodyFingerprint(body: string): string {
  return createHash("sha256").update(body).digest("hex");
}

/**
 * True when this (channel, id) was already accepted in the last 48 h.
 * Redis unavailable → false: processing twice is handled by the downstream
 * idempotency keys, dropping an event is not recoverable.
 */
export async function seenBefore(channel: string, externalId: string): Promise<boolean> {
  try {
    const result = await getRedisConnection().set(`wh:dedup:${channel}:${externalId}`, "1", "EX", DEDUP_TTL_SEC, "NX");
    return result !== "OK";
  } catch {
    return false;
  }
}

/** Forget a dedup key (the handler failed before anything was stored: let Meta's retry through). */
export async function forgetSeen(channel: string, externalId: string): Promise<void> {
  await Promise.resolve()
    .then(() => getRedisConnection().del(`wh:dedup:${channel}:${externalId}`))
    .catch(() => {});
}

/** At most a few rejection records a minute per channel; never the body. */
export async function logRejectedWebhook(channel: string, reason: string, meta: { bodyLength?: number; hadSignature?: boolean } = {}): Promise<void> {
  let count = 1;
  try {
    const key = `wh:rejected:${channel}:${Math.floor(Date.now() / 60_000)}`;
    const redis = getRedisConnection();
    count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 120);
  } catch {
    // Without Redis, still log (the database is the last resort, not a flood vector on its own).
  }
  if (count > REJECT_LOGS_PER_MINUTE) return;
  await prisma.operationalEvent
    .create({
      data: {
        source: "SYSTEM",
        level: "WARNING",
        message: `Webhook rejected (${channel}): ${reason}`.slice(0, 300),
        payload: { channel, reason, bodyLength: meta.bodyLength ?? null, hadSignatureHeader: meta.hadSignature ?? null },
      },
    })
    .catch(() => {});
}
