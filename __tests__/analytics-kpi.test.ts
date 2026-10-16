/**
 * ETAP 10 - observability KPIs: values from seeded data, and every loader is
 * isolated (a failing source becomes null + an entry in `failed`).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
// No Redis in unit tests: the real implementations are replaced through deps; these keep the imports inert.
vi.mock("@/lib/ops/worker-health", () => ({ getWorkerHealth: vi.fn() }));
vi.mock("@/lib/foundation/queue-stats", () => ({ loadQueueStats: vi.fn() }));

import { loadKpi, rateSample } from "@/lib/analytics/kpi";
import type { QueueStats } from "@/lib/foundation/queue-stats";

const WS = "ws_1";
const NOW = new Date("2026-10-15T10:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const queueStats = async () =>
  ({
    dm: { queued: 12, processing: 1, truncated: false, completed24h: 5, failed24h: 1, skipped24h: 0, sentLastHour: 6, etaMinutes: 120, etaLabel: "~2 soat" },
    triggers: { backlog: 3, last24h: {} },
    rate: [],
    checkedAt: NOW.toISOString(),
  }) as unknown as QueueStats;

const healthy = async () => ({ healthy: true, heartbeat: null, ageMs: 5000 });

beforeEach(() => {
  resetDb();
  db.seed("automation", { workspaceId: WS, instagramAccountId: "ig_1", name: "a", isActive: true });
  db.seed("automation", { workspaceId: WS, instagramAccountId: "ig_1", name: "b", isActive: false });
  db.seed("triggerCampaign", { workspaceId: WS, instagramAccountId: "ig_1", name: "t", active: true });
  db.seed("instagramAccount", { id: "ig_1", workspaceId: WS, username: "acme", instagramId: "17841", connectedAt: NOW, tokenStatus: "ACTIVE", accessToken: "x", tokenExpiresAt: new Date("2027-01-01T00:00:00Z") });
});

describe("rateSample", () => {
  it("computes failure and success rates, null without attempts", () => {
    expect(rateSample(3, 12)).toEqual({ rate: 0.25, attempts: 12, failures: 3 });
    expect(rateSample(3, 12, "success").rate).toBe(0.75);
    expect(rateSample(0, 0).rate).toBeNull();
  });
});

describe("loadKpi", () => {
  it("computes the live tiles from seeded data", async () => {
    // 3 sends in the last 10 minutes (2 DM + 1 operator message), 1 failure in the last hour
    db.seed("dmLog", { workspaceId: WS, automationId: "a", instagramAccountId: "ig_1", status: "SENT", dmSentAt: minutesAgo(1), createdAt: minutesAgo(1), updatedAt: minutesAgo(1) });
    db.seed("dmLog", { workspaceId: WS, automationId: "a", instagramAccountId: "ig_1", status: "SENT", dmSentAt: minutesAgo(5), createdAt: minutesAgo(5), updatedAt: minutesAgo(5) });
    db.seed("dmLog", { workspaceId: WS, automationId: "a", instagramAccountId: "ig_1", status: "FAILED", createdAt: minutesAgo(30), updatedAt: minutesAgo(30) });
    db.seed("conversation", { id: "c1", workspaceId: WS, instagramAccountId: "ig_1", igUserId: "u" });
    db.seed("conversationMessage", { conversationId: "c1", author: "OPERATOR", text: "hi", createdAt: minutesAgo(2) });
    db.seed("conversationMessage", { conversationId: "c1", author: "CUSTOMER", text: "hello", createdAt: minutesAgo(2) });
    db.seed("llmUsage", { workspaceId: WS, kind: "reply", costUsd: 0.5, latencyMs: 400, ok: true, createdAt: minutesAgo(10) });
    db.seed("llmUsage", { workspaceId: WS, kind: "reply", costUsd: 0.25, latencyMs: 800, ok: false, createdAt: minutesAgo(20) });
    db.seed("instagramEvent", { workspaceId: WS, instagramAccountId: "ig_1", eventType: "COMMENT", messageId: "m1", senderId: "s", timestamp: minutesAgo(12), createdAt: minutesAgo(10), rawPayload: {} });
    db.seed("instagramEvent", { workspaceId: WS, instagramAccountId: "ig_1", eventType: "COMMENT", messageId: "m2", senderId: "s", timestamp: minutesAgo(40), createdAt: minutesAgo(30), rawPayload: {} });
    db.seed("analyticsDaily", { workspaceId: WS, day: new Date("2026-10-15T00:00:00Z"), metric: "sales.leads", value: 4 });
    db.seed("analyticsDaily", { workspaceId: WS, day: new Date("2026-10-15T00:00:00Z"), metric: "ai.conversations", value: 7 });

    const kpi = await loadKpi(WS, NOW, { loadQueueStats: queueStats, getWorkerHealth: healthy, loadQueueDepths: async () => [{ queue: "dm-processing", label: "Comment DM", waiting: 2, active: 1, delayed: 0, failed: 0 }] });

    expect(kpi.failed).toEqual([]);
    expect(kpi.activeCampaigns).toEqual({ automations: 1, triggers: 1, total: 2 });
    expect(kpi.connections).toMatchObject({ total: 1 });
    expect(kpi.messagesPerMin?.last10min).toBe(3);
    expect(kpi.messagesPerMin?.perMin).toBe(0.3);
    expect(kpi.messagesPerMin?.sparkline).toHaveLength(10);
    expect(kpi.messagesPerMin?.sparkline.reduce((a, b) => a + b, 0)).toBe(3);
    expect(kpi.metaErrorRate).toEqual({ rate: 0.3333, attempts: 3, failures: 1 });
    expect(kpi.messageSuccessRate?.rate).toBeCloseTo(0.6667, 3);
    expect(kpi.errors).toEqual({ last1h: 1, last24h: 1 });
    expect(kpi.aiLatencyMs).toMatchObject({ avg: 600, calls: 2 });
    expect(kpi.aiCostTodayUsd).toBe(0.75);
    expect(kpi.webhookDelay).toEqual({ avgMs: 6 * 60_000, maxMs: 10 * 60_000, samples: 2 });
    expect(kpi.queue?.dm.queued).toBe(12);
    expect(kpi.queueDepths).toHaveLength(1);
    expect(kpi.today).toEqual({ aiConversations: 7, leads: 4, hot: 0, conversions: 0 });
    expect(kpi.worker).toEqual({ healthy: true, ageMs: 5000 });
  });

  it("tolerates failing loaders: they become null and are listed in `failed`", async () => {
    const kpi = await loadKpi(WS, NOW, {
      loadQueueStats: async () => {
        throw new Error("redis down");
      },
      getWorkerHealth: async () => {
        throw new Error("redis down");
      },
      loadQueueDepths: async () => {
        throw new Error("redis down");
      },
    });
    expect(kpi.queue).toBeNull();
    expect(kpi.worker).toBeNull();
    expect(kpi.queueDepths).toBeNull();
    expect(kpi.failed.sort()).toEqual(["queue", "queueDepths", "worker"]);
    // everything else still loaded
    expect(kpi.activeCampaigns).not.toBeNull();
    expect(kpi.errors).toEqual({ last1h: 0, last24h: 0 });
    expect(kpi.metaErrorRate?.rate).toBeNull();
  });

  it("a worker health check that never answers does not hang the page", async () => {
    vi.useFakeTimers();
    try {
      const pending = loadKpi(WS, NOW, {
        loadQueueStats: queueStats,
        getWorkerHealth: () => new Promise(() => {}),
        loadQueueDepths: async () => [],
      });
      await vi.advanceTimersByTimeAsync(5000);
      const kpi = await pending;
      expect(kpi.worker).toBeNull();
      expect(kpi.failed).toContain("worker");
    } finally {
      vi.useRealTimers();
    }
  });
});
