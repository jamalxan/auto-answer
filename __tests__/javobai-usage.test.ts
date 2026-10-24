/**
 * ETAP 4.4 — JavobAI usage accounting against the in-memory db:
 * LlmUsage rows, Tashkent month boundaries, by-kind aggregation, daily series.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));

import {
  dailySeries,
  isJavobAiKind,
  monthlyUsage,
  recordJavobAiUsage,
  roundUsd,
  tashkentDayKey,
  tashkentDayStart,
  tashkentMonthStart,
  tashkentNextMonthStart,
} from "@/lib/javobai/usage";

const WS = "ws_1";

function usage(over: Record<string, unknown>) {
  return db.seed("llmUsage", {
    workspaceId: WS,
    conversationId: null,
    kind: "javobai_reply",
    model: "gemini-3.1-flash-lite",
    inputTokens: 100,
    outputTokens: 50,
    costUsd: 0.001,
    latencyMs: 300,
    ok: true,
    ...over,
  });
}

beforeEach(() => {
  // Pin the clock to the fixtures' date: code under test also reads `new Date()`.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date("2026-10-16T10:00:00Z"));
  resetDb();
  vi.restoreAllMocks();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("Tashkent calendar", () => {
  it("month starts at 00:00 Tashkent = 19:00 UTC of the previous day", () => {
    // 2026-10-31 20:00 UTC is already 2026-11-01 01:00 in Tashkent.
    expect(tashkentMonthStart(new Date("2026-10-31T20:00:00Z")).toISOString()).toBe("2026-10-31T19:00:00.000Z");
    // 2026-10-31 18:59 UTC is still October in Tashkent.
    expect(tashkentMonthStart(new Date("2026-10-31T18:59:00Z")).toISOString()).toBe("2026-09-30T19:00:00.000Z");
    expect(tashkentNextMonthStart(new Date("2026-10-15T12:00:00Z")).toISOString()).toBe("2026-10-31T19:00:00.000Z");
    // Year boundary.
    expect(tashkentMonthStart(new Date("2026-12-31T19:30:00Z")).toISOString()).toBe("2026-12-31T19:00:00.000Z");
  });

  it("day helpers use Tashkent midnight", () => {
    const now = new Date("2026-10-16T22:30:00Z"); // 2026-10-17 03:30 Tashkent
    expect(tashkentDayStart(now, 0).toISOString()).toBe("2026-10-16T19:00:00.000Z");
    expect(tashkentDayStart(now, 1).toISOString()).toBe("2026-10-15T19:00:00.000Z");
    expect(tashkentDayKey(now)).toBe("2026-10-17");
    expect(tashkentDayKey(new Date("2026-10-16T18:59:59Z"))).toBe("2026-10-16");
  });
});

describe("recordJavobAiUsage", () => {
  it("writes an LlmUsage row in the production shape", async () => {
    const ok = await recordJavobAiUsage({
      workspaceId: WS,
      conversationId: "conv_1",
      kind: "javobai_stt",
      model: "gemini-3.1-flash",
      inputTokens: 1200.4,
      outputTokens: 80,
      costUsd: 0.00012345678,
      latencyMs: 950,
      ok: true,
    });
    expect(ok).toBe(true);
    expect(db.rows("llmUsage")).toHaveLength(1);
    expect(db.rows("llmUsage")[0]).toMatchObject({
      workspaceId: WS,
      conversationId: "conv_1",
      kind: "javobai_stt",
      model: "gemini-3.1-flash",
      inputTokens: 1200,
      outputTokens: 80,
      costUsd: 0.000123,
      latencyMs: 950,
      ok: true,
    });
  });

  it("never throws when the write fails", async () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    // The client proxy resolves `prisma.llmUsage` through db.model() on every access.
    vi.spyOn(db, "model").mockImplementationOnce(
      () => ({ create: async () => { throw new Error("db down"); } }) as never
    );
    const ok = await recordJavobAiUsage({
      workspaceId: WS, kind: "javobai_reply", model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, ok: false,
    });
    expect(ok).toBe(false);
    expect(spy).toHaveBeenCalled();
    expect(db.rows("llmUsage")).toHaveLength(0);
  });
});

describe("monthlyUsage", () => {
  it("aggregates by kind inside the Tashkent month, splitting JavobAI from production", async () => {
    const now = new Date("2026-10-16T10:00:00Z");
    usage({ kind: "javobai_reply", costUsd: 0.002, inputTokens: 100, outputTokens: 20 });
    usage({ kind: "javobai_reply", costUsd: 0.003, inputTokens: 200, outputTokens: 30, ok: false });
    usage({ kind: "javobai_vision", costUsd: 0.01, inputTokens: 900, outputTokens: 40 });
    usage({ kind: "reply", costUsd: 0.005, inputTokens: 50, outputTokens: 10 }); // production assistant
    usage({ kind: "javobai_reply", costUsd: 5, createdAt: new Date("2026-09-30T18:59:00Z") }); // September (Tashkent)
    usage({ kind: "javobai_reply", costUsd: 0.1, createdAt: new Date("2026-09-30T19:00:00Z") }); // first second of October
    usage({ kind: "javobai_reply", costUsd: 7, createdAt: new Date("2026-10-31T19:00:00Z") }); // November
    usage({ kind: "javobai_reply", costUsd: 9, workspaceId: "other" });

    const result = await monthlyUsage(WS, now);
    expect(result.periodStart.toISOString()).toBe("2026-09-30T19:00:00.000Z");
    expect(result.periodEnd.toISOString()).toBe("2026-10-31T19:00:00.000Z");
    expect(result.calls).toBe(5);
    expect(result.javobAiUsd).toBeCloseTo(0.115, 6);
    expect(result.productionUsd).toBeCloseTo(0.005, 6);
    expect(result.totalUsd).toBeCloseTo(0.12, 6);

    const reply = result.byKind.find((k) => k.kind === "javobai_reply");
    expect(reply).toMatchObject({ javobAi: true, calls: 3, failedCalls: 1, inputTokens: 400, outputTokens: 100 });
    expect(reply?.costUsd).toBeCloseTo(0.105, 6);
    expect(result.byKind.find((k) => k.kind === "reply")).toMatchObject({ javobAi: false, calls: 1 });
    // Sorted by cost, most expensive first.
    expect(result.byKind[0].kind).toBe("javobai_reply");
    expect(result.byKind.map((k) => k.kind)).toEqual(["javobai_reply", "javobai_vision", "reply"]);
  });

  it("is empty for a workspace without usage", async () => {
    const result = await monthlyUsage("nobody", new Date("2026-10-16T10:00:00Z"));
    expect(result).toMatchObject({ byKind: [], totalUsd: 0, javobAiUsd: 0, productionUsd: 0, calls: 0 });
  });

  it("reads Decimal-like values (strings / objects with toString)", async () => {
    usage({ costUsd: "0.25" });
    usage({ costUsd: { toString: () => "0.5" } });
    const result = await monthlyUsage(WS, new Date("2026-10-16T10:00:00Z"));
    expect(result.totalUsd).toBeCloseTo(0.75, 6);
  });
});

describe("dailySeries", () => {
  it("returns one zero-filled point per Tashkent day, oldest first", async () => {
    const now = new Date("2026-10-16T22:30:00Z"); // 2026-10-17 03:30 Tashkent
    usage({ costUsd: 0.1, createdAt: new Date("2026-10-16T20:00:00Z") }); // 17 Oct Tashkent
    usage({ costUsd: 0.2, kind: "reply", createdAt: new Date("2026-10-16T10:00:00Z") }); // 16 Oct
    usage({ costUsd: 0.3, createdAt: new Date("2026-10-14T19:00:00Z") }); // first second of 15 Oct
    usage({ costUsd: 9, createdAt: new Date("2026-10-14T18:59:59Z") }); // 14 Oct, outside a 3-day window

    const series = await dailySeries(WS, 3, now);
    expect(series.map((p) => p.day)).toEqual(["2026-10-15", "2026-10-16", "2026-10-17"]);
    expect(series[0]).toMatchObject({ calls: 1, javobAiUsd: 0.3, productionUsd: 0, totalUsd: 0.3 });
    expect(series[1]).toMatchObject({ calls: 1, javobAiUsd: 0, productionUsd: 0.2, totalUsd: 0.2 });
    expect(series[2]).toMatchObject({ calls: 1, javobAiUsd: 0.1, productionUsd: 0, totalUsd: 0.1 });
  });

  it("defaults to 30 days and clamps silly inputs", async () => {
    const now = new Date("2026-10-16T10:00:00Z");
    expect(await dailySeries(WS, undefined, now)).toHaveLength(30);
    expect(await dailySeries(WS, 0, now)).toHaveLength(1);
    expect(await dailySeries(WS, 10_000, now)).toHaveLength(366);
  });
});

describe("helpers", () => {
  it("isJavobAiKind / roundUsd", () => {
    expect(isJavobAiKind("javobai_reply")).toBe(true);
    expect(isJavobAiKind("reply")).toBe(false);
    expect(roundUsd(0.1234567)).toBe(0.123457);
    expect(roundUsd(-1)).toBe(0);
    expect(roundUsd(Number.NaN)).toBe(0);
  });
});
