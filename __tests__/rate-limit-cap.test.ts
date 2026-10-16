/**
 * B-03: the per-account hourly DM cap is configurable (default 200), and a
 * burst over the cap is delayed to later windows — never dropped.
 *
 * Unit-form load test: 300 queued sends against a fake Redis and a fake clock.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const store = vi.hoisted(() => {
  const data = new Map<string, { value: number; expiresAt: number }>();
  const live = (key: string) => {
    const row = data.get(key);
    if (row && row.expiresAt <= Date.now()) data.delete(key);
    return data.get(key);
  };
  return {
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
      return 0;
    },
    del: async () => 0,
  };
});

vi.mock("ioredis", () => ({
  default: vi.fn().mockImplementation(function (this: Record<string, unknown>) {
    this.get = store.get;
    this.ttl = store.ttl;
    this.eval = store.eval;
    this.del = store.del;
    return this;
  }),
}));
vi.stubEnv("REDIS_URL", "redis://localhost:6379");

import {
  DEFAULT_HOURLY_DM_LIMIT,
  defaultHourlyLimit,
  forgetAccountHourlyLimit,
  nextWindowDelayMs,
  reserveDMSlot,
} from "../lib/utils/rate-limiter";

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
  store.data.clear();
  forgetAccountHourlyLimit();
  vi.unstubAllEnvs();
  vi.stubEnv("REDIS_URL", "redis://localhost:6379");
});
afterEach(() => vi.useRealTimers());

describe("hourly DM limit configuration", () => {
  it("defaults to 200 per hour (TZ), not 750", () => {
    expect(DEFAULT_HOURLY_DM_LIMIT).toBe(200);
    expect(defaultHourlyLimit({} as NodeJS.ProcessEnv)).toBe(200);
  });

  it("DM_HOURLY_LIMIT_DEFAULT overrides it; garbage falls back to 200", () => {
    expect(defaultHourlyLimit({ DM_HOURLY_LIMIT_DEFAULT: "120" } as unknown as NodeJS.ProcessEnv)).toBe(120);
    expect(defaultHourlyLimit({ DM_HOURLY_LIMIT_DEFAULT: "abc" } as unknown as NodeJS.ProcessEnv)).toBe(200);
    expect(defaultHourlyLimit({ DM_HOURLY_LIMIT_DEFAULT: "-5" } as unknown as NodeJS.ProcessEnv)).toBe(200);
  });
});

describe("nextWindowDelayMs", () => {
  it("waits for the window to end and backs off more on every attempt", () => {
    const first = nextWindowDelayMs(600, 0, 0.5);
    const later = nextWindowDelayMs(600, 6, 0.5);
    expect(first).toBeGreaterThanOrEqual(600_000);
    expect(later).toBeGreaterThan(first);
    expect(nextWindowDelayMs(null, 0, 0.5)).toBeGreaterThan(0);
  });
});

describe("300 queued sends against the hourly cap", () => {
  it("never exceeds the cap in a window and delivers every message", async () => {
    const TOTAL = 300;
    const cap = DEFAULT_HOURLY_DM_LIMIT;
    const account = "ig_load_test";
    const due = new Map<number, number>(); // job -> due time (ms)
    for (let i = 0; i < TOTAL; i++) due.set(i, Date.now());

    const perWindow = new Map<number, number>(); // window start (ms) -> sends
    const attempts = new Map<number, number>();
    let delivered = 0;
    let dropped = 0;

    let guard = 0;
    while (due.size > 0 && guard++ < 10_000) {
      const now = Date.now();
      const ready = [...due.entries()].filter(([, at]) => at <= now).map(([id]) => id);
      if (ready.length === 0) {
        vi.setSystemTime(Math.min(...due.values()));
        continue;
      }
      for (const id of ready) {
        const attempt = attempts.get(id) ?? 0;
        const result = await reserveDMSlot(account, attempt);
        if (result.allowed) {
          // the window this slot belongs to = the counter's expiry minus one hour
          const windowStart = store.data.get(`rate:dm:${account}`)!.expiresAt - 3_600_000;
          perWindow.set(windowStart, (perWindow.get(windowStart) ?? 0) + 1);
          delivered++;
          due.delete(id);
        } else if (result.shouldSkip) {
          dropped++;
          due.delete(id);
        } else {
          attempts.set(id, attempt + 1);
          due.set(id, now + result.requeueDelayMs);
        }
      }
    }

    expect(dropped).toBe(0);
    expect(delivered).toBe(TOTAL);
    expect(perWindow.size).toBeGreaterThanOrEqual(2);
    for (const count of perWindow.values()) expect(count).toBeLessThanOrEqual(cap);
  });
});
