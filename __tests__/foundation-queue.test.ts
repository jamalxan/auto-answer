/**
 * Foundation — user-visible queue (TZ §6.2): ETA, rate usage, and the loader's
 * tenant filtering of the shared DM queue plus its Redis-failure tolerance.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    instagramAccount: { findMany: vi.fn() },
    dmLog: { groupBy: vi.fn(), count: vi.fn() },
    instagramEvent: { count: vi.fn(), groupBy: vi.fn() },
  },
  getJobs: vi.fn(),
  pipelineExec: vi.fn(),
  pipelineCalls: [] as string[],
}));

vi.mock("@/lib/db/client", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/queue/client", () => ({
  getDMQueue: () => ({ getJobs: mocks.getJobs }),
  getRedisConnection: () => ({
    pipeline: () => {
      const pipeline = {
        get: (key: string) => (mocks.pipelineCalls.push(`get ${key}`), pipeline),
        ttl: (key: string) => (mocks.pipelineCalls.push(`ttl ${key}`), pipeline),
        exec: mocks.pipelineExec,
      };
      return pipeline;
    },
  }),
}));

import {
  buildRateUsage,
  estimateEtaMinutes,
  formatEta,
  loadQueueStats,
  QUEUE_SCAN_LIMIT,
} from "@/lib/foundation/queue-stats";
import { formatAgo, formatMinutes } from "@/lib/foundation/time";

describe("estimateEtaMinutes", () => {
  it("is 0 for an empty queue", () => {
    expect(estimateEtaMinutes(0, 0)).toBe(0);
    expect(estimateEtaMinutes(-3, 100)).toBe(0);
  });

  it("is null when nothing is moving", () => {
    expect(estimateEtaMinutes(10, 0)).toBeNull();
    expect(estimateEtaMinutes(10, Number.NaN)).toBeNull();
  });

  it("matches the spec example and rounds up", () => {
    expect(estimateEtaMinutes(312, 208)).toBe(90); // "312 waiting, 1h 30m"
    expect(estimateEtaMinutes(1, 750)).toBe(1);
    expect(estimateEtaMinutes(750, 750)).toBe(60);
  });
});

describe("formatting", () => {
  it("formatEta", () => {
    expect(formatEta(null)).toBe("Hisoblab bo'lmadi");
    expect(formatEta(0)).toBe("Navbat bo'sh");
    expect(formatEta(12)).toBe("~12 daqiqa");
    expect(formatEta(90)).toBe("~1 soat 30 daqiqa");
    expect(formatEta(120)).toBe("~2 soat");
  });

  it("formatMinutes / formatAgo", () => {
    expect(formatMinutes(0.2)).toBe("1 daqiqa");
    const now = new Date("2026-10-15T12:00:00Z");
    expect(formatAgo(new Date(now.getTime() - 20_000), now)).toBe("hozirgina");
    expect(formatAgo(new Date(now.getTime() - 2 * 60_000), now)).toBe("2 daqiqa oldin");
    expect(formatAgo(new Date(now.getTime() - 3 * 3_600_000), now)).toBe("3 soat oldin");
    expect(formatAgo(new Date(now.getTime() - 50 * 3_600_000), now)).toBe("2 kun oldin");
    expect(formatAgo(null, now)).toBe("—");
  });
});

describe("buildRateUsage", () => {
  it("normal usage", () => {
    expect(buildRateUsage(120, 1800, 750)).toEqual({
      used: 120,
      limit: 750,
      remaining: 630,
      percent: 16,
      resetInSeconds: 1800,
      tone: "success",
    });
  });

  it("warning from 80%, error at the cap, never over 100%", () => {
    expect(buildRateUsage(600, 100, 750).tone).toBe("warning");
    expect(buildRateUsage(750, 100, 750)).toMatchObject({ tone: "error", remaining: 0, percent: 100 });
    expect(buildRateUsage(900, 100, 750)).toMatchObject({ percent: 100, remaining: 0 });
  });

  it("no running window when the key is missing or has no TTL", () => {
    expect(buildRateUsage(0, -2).resetInSeconds).toBeNull();
    expect(buildRateUsage(5, -1).resetInSeconds).toBeNull();
    expect(buildRateUsage(5, null).resetInSeconds).toBeNull();
    expect(buildRateUsage(Number.NaN, 10).used).toBe(0);
  });
});

describe("loadQueueStats", () => {
  const NOW = new Date("2026-10-15T12:00:00Z");
  const accounts = [
    { id: "acc1", username: "shop", instagramId: "IG1" },
    { id: "acc2", username: "shop2", instagramId: "IG2" },
  ];
  const job = (ig: string) => ({ data: { instagramAccountId: ig } });

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.pipelineCalls.length = 0;
    mocks.prisma.instagramAccount.findMany.mockResolvedValue(accounts);
    mocks.prisma.dmLog.groupBy.mockResolvedValue([
      { status: "SENT", _count: { _all: 40 } },
      { status: "FAILED", _count: { _all: 3 } },
      { status: "SKIPPED_DEDUP", _count: { _all: 2 } },
      { status: "SKIPPED_RATE_LIMIT", _count: { _all: 1 } },
    ]);
    mocks.prisma.dmLog.count.mockResolvedValue(30);
    mocks.prisma.instagramEvent.count.mockResolvedValue(4);
    mocks.prisma.instagramEvent.groupBy.mockResolvedValue([{ processingStatus: "PROCESSED", _count: { _all: 9 } }]);
    mocks.getJobs.mockImplementation(async (types: string[]) =>
      types.includes("active") ? [job("IG1"), job("OTHER")] : [job("IG1"), job("IG2"), job("OTHER"), job("OTHER")]
    );
    mocks.pipelineExec.mockResolvedValue([
      [null, "170"],
      [null, 1200],
      [null, null],
      [null, -2],
    ]);
  });

  it("counts only this workspace's jobs and DmLogs", async () => {
    const stats = await loadQueueStats("ws_1", { now: NOW });
    expect(stats.dm).toMatchObject({
      queued: 2,
      processing: 1,
      truncated: false,
      completed24h: 40,
      failed24h: 3,
      skipped24h: 3,
      sentLastHour: 30,
      etaMinutes: 4,
      etaLabel: "~4 daqiqa",
    });
    expect(mocks.prisma.instagramAccount.findMany.mock.calls[0][0].where).toEqual({ workspaceId: "ws_1" });
    expect(mocks.prisma.dmLog.groupBy.mock.calls[0][0].where.workspaceId).toBe("ws_1");
    expect(mocks.prisma.instagramEvent.count.mock.calls[0][0].where.workspaceId).toBe("ws_1");
    expect(stats.triggers).toEqual({ backlog: 4, last24h: { PROCESSED: 9 } });
  });

  it("reads rate counters by Instagram id (the key the workers use)", async () => {
    const stats = await loadQueueStats("ws_1", { now: NOW });
    expect(mocks.pipelineCalls).toEqual(["get rate:dm:IG1", "ttl rate:dm:IG1", "get rate:dm:IG2", "ttl rate:dm:IG2"]);
    expect(stats.rate[0]).toMatchObject({ instagramAccountId: "acc1", usage: { used: 170, limit: 200, tone: "warning", resetInSeconds: 1200 } });
    expect(stats.rate[1]).toMatchObject({ instagramAccountId: "acc2", usage: { used: 0, resetInSeconds: null } });
  });

  it("flags a truncated scan", async () => {
    mocks.getJobs.mockImplementation(async (types: string[]) =>
      types.includes("active") ? [] : Array.from({ length: QUEUE_SCAN_LIMIT }, () => job("IG1"))
    );
    const stats = await loadQueueStats("ws_1", { now: NOW });
    expect(stats.dm).toMatchObject({ queued: QUEUE_SCAN_LIMIT, truncated: true });
  });

  it("survives Redis being down", async () => {
    mocks.getJobs.mockRejectedValue(new Error("ECONNREFUSED"));
    mocks.pipelineExec.mockRejectedValue(new Error("ECONNREFUSED"));
    const stats = await loadQueueStats("ws_1", { now: NOW });
    expect(stats.dm).toMatchObject({ queued: null, processing: null, etaMinutes: null });
    expect(stats.dm.etaLabel).toContain("Redis");
    expect(stats.rate.every((r) => r.usage === null)).toBe(true);
    expect(stats.dm.completed24h).toBe(40);
  });

  it("skips Redis entirely when the workspace has no accounts", async () => {
    mocks.prisma.instagramAccount.findMany.mockResolvedValue([]);
    const stats = await loadQueueStats("ws_1", { now: NOW });
    expect(mocks.getJobs).not.toHaveBeenCalled();
    expect(stats.dm).toMatchObject({ queued: 0, etaLabel: "Navbat bo'sh" });
    expect(stats.rate).toEqual([]);
  });
});
