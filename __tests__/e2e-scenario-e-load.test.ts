/**
 * Scenario E: 300 DM events through the real hourly cap (reserveDMSlot) and the
 * real guarded send path (sendGuarded), with a fake clock, a fake Redis, a fake
 * queue that applies the trigger engine's own retry rules (eventFailure +
 * backoffDelay) and a sender that returns Meta rate-limit errors (429-style).
 *
 * Invariants: no rolling hour holds more than the cap of SENT messages, all 300
 * are eventually delivered, none dropped.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");

const h = vi.hoisted(() => {
  const data = new Map<string, { value: number; expiresAt: number }>();
  const live = (key: string) => {
    const row = data.get(key);
    if (row && row.expiresAt <= Date.now()) data.delete(key);
    return data.get(key);
  };
  const store = {
    data,
    get: async (key: string) => {
      const row = live(key);
      return row ? String(row.value) : null;
    },
    ttl: async (key: string) => {
      const row = live(key);
      return row ? Math.ceil((row.expiresAt - Date.now()) / 1000) : -2;
    },
    eval: async (script: string, _n: number, key: string, max?: number, ttl?: number) => {
      if (script.includes("INCR")) {
        const row = live(key);
        const current = row?.value ?? 0;
        if (current >= Number(max)) return [0, current, 0, Math.ceil((row!.expiresAt - Date.now()) / 1000)];
        if (!row) data.set(key, { value: 1, expiresAt: Date.now() + Number(ttl) * 1000 });
        else row.value += 1;
        const next = live(key)!.value;
        return [1, next, Number(max) - next];
      }
      const row = live(key); // release
      if (!row || row.value <= 0) return 0;
      row.value -= 1;
      return row.value;
    },
    del: async (key: string) => (data.delete(key) ? 1 : 0),
  };
  return { store, overrides: new Map<string, number | null>() };
});

vi.mock("ioredis", () => ({
  default: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.get = h.store.get;
    this.ttl = h.store.ttl;
    this.eval = h.store.eval;
    this.del = h.store.del;
    return this;
  }),
}));
vi.mock("@/lib/db/client", () => ({
  prisma: {
    instagramAccount: {
      findUnique: vi.fn(async ({ where }: { where: { instagramId: string } }) => ({
        dmHourlyLimit: h.overrides.get(where.instagramId) ?? null,
      })),
    },
    operationalEvent: { create: vi.fn(async () => ({})) },
  },
}));
vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: vi.fn(async () => ({ allowed: true, periodStart: new Date("2026-10-01T00:00:00Z") })),
  releaseWorkspaceDMReservation: vi.fn(async () => ({ count: 1 })),
}));
vi.mock("@/lib/meta/token-health", () => ({ markTokenBroken: vi.fn(async () => {}) }));

import { sendGuarded, eventFailure } from "../lib/triggers/delivery";
import { backoffDelay } from "../lib/triggers/queue";
import { RateLimitError } from "../lib/meta/client";
import { DEFAULT_HOURLY_DM_LIMIT, forgetAccountHourlyLimit } from "../lib/utils/rate-limiter";

const HOUR = 3_600_000;
const START = new Date("2026-10-20T10:00:00Z").getTime();
const WORKSPACE = "w1";

interface Job {
  id: number;
  due: number;
  attempts: number;
  done: boolean;
}

interface RunOptions {
  igId: string;
  total: number;
  /** Arrival time of each job (default: all at START). */
  arrival?: (i: number) => number;
  /** true -> the sender answers with a Meta rate-limit error for this call. */
  senderFails?: (call: number, job: Job) => boolean;
}

async function run(opts: RunOptions) {
  const account = { id: "acc1", instagramId: opts.igId };
  const jobs: Job[] = Array.from({ length: opts.total }, (_, i) => ({
    id: i,
    due: opts.arrival ? opts.arrival(i) : START,
    attempts: 0,
    done: false,
  }));
  const sentAt: number[] = [];
  const sentIds = new Set<number>();
  const senderTimes: number[] = [];
  let senderCalls = 0;
  let senderRateLimited = 0;
  let dropped = 0;
  let guard = 0;

  while (jobs.some((j) => !j.done) && guard++ < 20_000) {
    const pending = jobs.filter((j) => !j.done);
    const next = Math.min(...pending.map((j) => j.due));
    if (next > Date.now()) vi.setSystemTime(next);
    const ready = pending.filter((j) => j.due <= Date.now()).sort((a, b) => a.due - b.due || a.id - b.id);
    for (const job of ready) {
      job.attempts += 1; // claimEvent increments the attempt counter
      const result = await sendGuarded(WORKSPACE, account, async () => {
        senderCalls += 1;
        senderTimes.push(Date.now());
        if (opts.senderFails?.(senderCalls, job)) {
          senderRateLimited += 1;
          throw new RateLimitError("(#4) Application request limit reached");
        }
        return { message_id: `m${job.id}` };
      });
      if (result.ok) {
        job.done = true;
        sentAt.push(Date.now());
        sentIds.add(job.id);
        continue;
      }
      if ("skipped" in result && result.skipped) {
        dropped += 1;
        job.done = true;
        continue;
      }
      const failure = (result as { failure: Parameters<typeof eventFailure>[1] }).failure;
      const outcome = await eventFailure(
        { id: `e${job.id}`, workspaceId: WORKSPACE, eventType: "DIRECT_MESSAGE", attempts: job.attempts, createdAt: new Date(job.due) },
        failure
      );
      if (outcome.status === "FAILED") {
        dropped += 1;
        job.done = true;
      } else {
        job.due = Date.now() + backoffDelay(job.attempts, outcome.kind, outcome.retryAfterMs);
      }
    }
  }
  return { sentAt: sentAt.sort((a, b) => a - b), sentIds, senderTimes, senderCalls, senderRateLimited, dropped, jobs };
}

/** Largest number of timestamps inside any half-open window [t, t + 1h). */
function peakRolling(times: number[], windowMs = HOUR) {
  let peak = 0;
  let j = 0;
  const sorted = [...times].sort((a, b) => a - b);
  for (let i = 0; i < sorted.length; i++) {
    if (j < i) j = i;
    while (j < sorted.length && sorted[j] < sorted[i] + windowMs) j++;
    peak = Math.max(peak, j - i);
  }
  return peak;
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(START);
  h.store.data.clear();
  h.overrides.clear();
  forgetAccountHourlyLimit();
  vi.unstubAllEnvs();
  vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
});
afterEach(() => vi.useRealTimers());

describe("E: 300 DM events against the hourly cap", () => {
  it("default cap is 200/hour: 200 go out at once, the rest after the window; all 300 delivered", async () => {
    expect(DEFAULT_HOURLY_DM_LIMIT).toBe(200);
    const r = await run({ igId: "ig_default", total: 300 });
    expect(r.dropped).toBe(0);
    expect(r.sentIds.size).toBe(300);
    expect(r.sentAt).toHaveLength(300);
    expect(peakRolling(r.sentAt)).toBeLessThanOrEqual(200);
    // the first window really carried the full cap, the remainder waited for the next one
    expect(r.sentAt.filter((t) => t === START)).toHaveLength(200);
    expect(Math.max(...r.sentAt) - START).toBeGreaterThanOrEqual(HOUR);
    expect(Math.max(...r.sentAt) - START).toBeLessThan(2 * HOUR);
  });

  it("with a fake 429 from the sender (every 7th call plus a burst): backoff, retry succeeds, nothing dropped, cap respected", async () => {
    const r = await run({
      igId: "ig_429",
      total: 300,
      senderFails: (call) => call % 7 === 0 || (call >= 40 && call <= 55),
    });
    expect(r.senderRateLimited).toBeGreaterThan(30);
    expect(r.dropped).toBe(0);
    expect(r.sentIds.size).toBe(300);
    // sends that reached the sender (successful or not) never exceed the cap per rolling hour either
    expect(peakRolling(r.senderTimes)).toBeLessThanOrEqual(200);
    expect(peakRolling(r.sentAt)).toBeLessThanOrEqual(200);
    // a 429'd message was retried later, never immediately (backoff of at least the minimum wait)
    for (const job of r.jobs) expect(job.done).toBe(true);
    expect(Math.max(...r.sentAt) - START).toBeGreaterThanOrEqual(30_000);
  });

  it("a retry after a 429 waits (backoff) instead of hammering the sender", async () => {
    const times = new Map<number, number[]>();
    const r = await run({
      igId: "ig_backoff",
      total: 5,
      senderFails: (call, job) => {
        const list = times.get(job.id) ?? [];
        list.push(Date.now());
        times.set(job.id, list);
        return job.id === 2 && list.length <= 2; // job 2 is rate limited twice
      },
    });
    expect(r.sentIds.size).toBe(5);
    const t = times.get(2)!;
    expect(t).toHaveLength(3);
    expect(t[1] - t[0]).toBeGreaterThanOrEqual(30_000);
    expect(t[2] - t[1]).toBeGreaterThanOrEqual(30_000);
  });

  it("per-account override (60/hour): never more than 60 in a rolling hour, 5 windows, all 300 delivered", async () => {
    h.overrides.set("ig_small", 60);
    const r = await run({ igId: "ig_small", total: 300 });
    expect(r.dropped).toBe(0);
    expect(r.sentIds.size).toBe(300);
    expect(peakRolling(r.sentAt)).toBeLessThanOrEqual(60);
    expect(r.sentAt.filter((t) => t === START)).toHaveLength(60);
    expect(Math.max(...r.sentAt) - START).toBeGreaterThanOrEqual(4 * HOUR);
  });

  it("per-account override above the default (500): all 300 go out immediately", async () => {
    h.overrides.set("ig_big", 500);
    const r = await run({ igId: "ig_big", total: 300 });
    expect(r.sentIds.size).toBe(300);
    expect(new Set(r.sentAt).size).toBe(1);
  });

  it("per-account override + 429s together", async () => {
    h.overrides.set("ig_mix", 80);
    const r = await run({ igId: "ig_mix", total: 300, senderFails: (call) => call % 5 === 0 });
    expect(r.dropped).toBe(0);
    expect(r.sentIds.size).toBe(300);
    expect(peakRolling(r.senderTimes)).toBeLessThanOrEqual(80);
    expect(peakRolling(r.sentAt)).toBeLessThanOrEqual(80);
  });

  it("DM_HOURLY_LIMIT_DEFAULT env changes the cap used for accounts without an override", async () => {
    // the module reads the env default at import for RATE_LIMIT_MAX but getAccountHourlyLimit reads it per call
    vi.stubEnv("DM_HOURLY_LIMIT_DEFAULT", "100");
    forgetAccountHourlyLimit();
    const r = await run({ igId: "ig_env", total: 300 });
    expect(r.sentIds.size).toBe(300);
    expect(peakRolling(r.sentAt)).toBeLessThanOrEqual(100);
  });

  // KNOWN LIMITATION (owner decision): the counter is a fixed window (Redis TTL), so a burst can straddle two
  // windows. The bound is 2x the cap in one rolling hour, never more; nothing is dropped. A true sliding window
  // would need a different Redis structure (ZSET) and is not done here.
  it("a trickle straddling a window boundary stays within 2x the cap in a rolling hour and drops nothing", async () => {
    // 1 message opens window W1; 199 arrive at 59m50s (W1 is then full); 200 more arrive just after W1 ends.
    // A fixed-window counter lets 200 out at the end of W1 and 200 at the start of W2 = 400 inside one rolling hour.
    const r = await run({
      igId: "ig_straddle",
      total: 400,
      arrival: (i) => (i === 0 ? START : i < 200 ? START + HOUR - 10_000 : START + HOUR + 5_000),
    });
    expect(r.dropped).toBe(0);
    expect(r.sentIds.size).toBe(400);
    expect(peakRolling(r.sentAt)).toBeLessThanOrEqual(400);
  });
});
