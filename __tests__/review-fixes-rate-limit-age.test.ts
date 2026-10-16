/**
 * Review fix M3: hourly-cap waits have a hard age cap (24h DMs, 7 days private
 * replies) and the trigger path waits for the window's TTL, not a fixed 65 min.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));

import {
  isRateLimitExpired,
  RATE_LIMIT_EXPIRED_MESSAGE,
  RATE_LIMIT_MAX_AGE_DM_MS,
  RATE_LIMIT_MAX_AGE_PRIVATE_REPLY_MS,
} from "@/lib/utils/rate-limit-age";
import { capRateLimitAge, eventFailure, failExecution } from "@/lib/triggers/delivery";
import { backoffDelay, TRIGGER_RATE_LIMIT_BACKOFF_MS } from "@/lib/triggers/queue";
import type { ClassifiedFailure } from "@/lib/triggers/errors";

const NOW = new Date("2026-10-17T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);
const H = 3600_000;

const rateLimited: ClassifiedFailure = {
  kind: "rate_limit",
  retryable: true,
  userMessage: "Soatlik DM limiti to'lgan — keyinroq qayta yuboriladi.",
  technical: "reserveDMSlot: count=200",
  retryAfterMs: 20 * 60_000,
};

beforeEach(() => {
  resetDb();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => vi.useRealTimers());

describe("isRateLimitExpired", () => {
  it("DMs expire at 24h, private replies at 7 days", () => {
    expect(isRateLimitExpired(ago(RATE_LIMIT_MAX_AGE_DM_MS - 1000), "dm", NOW)).toBe(false);
    expect(isRateLimitExpired(ago(RATE_LIMIT_MAX_AGE_DM_MS), "dm", NOW)).toBe(true);
    expect(isRateLimitExpired(ago(2 * 24 * H), "private_reply", NOW)).toBe(false);
    expect(isRateLimitExpired(ago(RATE_LIMIT_MAX_AGE_PRIVATE_REPLY_MS), "private_reply", NOW)).toBe(true);
    expect(isRateLimitExpired(null, "dm", NOW)).toBe(false);
  });
});

describe("capRateLimitAge", () => {
  it("keeps a young DM retryable, ends a 25h-old DM, ends only 7-day-old comments", () => {
    expect(capRateLimitAge({ eventType: "DIRECT_MESSAGE", timestamp: ago(2 * H) }, rateLimited, NOW).retryable).toBe(true);
    const old = capRateLimitAge({ eventType: "DIRECT_MESSAGE", timestamp: ago(25 * H) }, rateLimited, NOW);
    expect(old).toMatchObject({ retryable: false, userMessage: RATE_LIMIT_EXPIRED_MESSAGE });
    expect(capRateLimitAge({ eventType: "COMMENT", timestamp: ago(25 * H) }, rateLimited, NOW).retryable).toBe(true);
    expect(capRateLimitAge({ eventType: "COMMENT", timestamp: ago(7 * 24 * H) }, rateLimited, NOW).retryable).toBe(false);
  });

  it("leaves other failures alone", () => {
    const other: ClassifiedFailure = { kind: "temporary", retryable: true, userMessage: "x", technical: "y" };
    expect(capRateLimitAge({ eventType: "DIRECT_MESSAGE", timestamp: ago(48 * H) }, other, NOW)).toBe(other);
  });
});

describe("backoffDelay uses the computed TTL wait", () => {
  it("rate_limit: retryAfterMs when given (clamped), else the fixed 65 min", () => {
    expect(backoffDelay(1, "rate_limit", 20 * 60_000)).toBe(20 * 60_000);
    expect(backoffDelay(1, "rate_limit", 5)).toBe(30_000);
    expect(backoffDelay(1, "rate_limit", 10 * H)).toBe(TRIGGER_RATE_LIMIT_BACKOFF_MS);
    expect(backoffDelay(1, "rate_limit")).toBe(TRIGGER_RATE_LIMIT_BACKOFF_MS);
  });
});

describe("failExecution / eventFailure", () => {
  const base = { id: "e1", workspaceId: "ws1", attempts: 3 };

  it("a rate-limited execution retries at the TTL wait while the event is young", async () => {
    db.seed("triggerExecution", { id: "x1", status: "PENDING" });
    const result = await failExecution({ ...base, eventType: "DIRECT_MESSAGE", timestamp: ago(H) } as never, "x1", rateLimited);
    expect(result).toMatchObject({ status: "RETRYING", kind: "rate_limit", retryAfterMs: 20 * 60_000 });
    const row = db.rows("triggerExecution")[0] as { status: string; nextRetryAt: Date };
    expect(row.status).toBe("RETRYING");
    expect(row.nextRetryAt.getTime()).toBe(NOW.getTime() + 20 * 60_000);
  });

  it("a 25h-old DM is FAILED with the clear reason", async () => {
    db.seed("triggerExecution", { id: "x1", status: "PENDING" });
    const result = await failExecution({ ...base, eventType: "DIRECT_MESSAGE", timestamp: ago(25 * H) } as never, "x1", rateLimited);
    expect(result).toMatchObject({ status: "FAILED", error: RATE_LIMIT_EXPIRED_MESSAGE });
    expect(db.rows("triggerExecution")[0]).toMatchObject({ status: "FAILED", error: RATE_LIMIT_EXPIRED_MESSAGE, nextRetryAt: null });
  });

  it("eventFailure ends an old private reply only after 7 days", async () => {
    expect(await eventFailure({ ...base, eventType: "COMMENT", timestamp: ago(3 * 24 * H) } as never, rateLimited)).toMatchObject({ status: "RETRYING" });
    expect(await eventFailure({ ...base, eventType: "COMMENT", timestamp: ago(8 * 24 * H) } as never, rateLimited)).toMatchObject({
      status: "FAILED",
      error: RATE_LIMIT_EXPIRED_MESSAGE,
    });
  });
});
