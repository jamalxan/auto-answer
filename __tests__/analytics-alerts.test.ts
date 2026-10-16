/**
 * ETAP 10 - monitoring alerts: thresholds, one alert per rule per 6 hours
 * (AnalyticsAlertState), unknown inputs never fire.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/ops/worker-health", () => ({ getWorkerHealth: vi.fn(async () => ({ healthy: false, heartbeat: null, ageMs: null })) }));
vi.mock("@/lib/foundation/queue-stats", () => ({
  loadQueueStats: vi.fn(async () => ({ dm: { etaMinutes: 90 } })),
}));
vi.mock("@/lib/telegram/notify", () => ({ alertWorkspace: vi.fn(async () => {}) }));

import {
  ALERT_COOLDOWN_MS,
  describeAlertRules,
  evaluateAlertRules,
  loadAlertInputs,
  runAlertsForWorkspace,
  type AlertInputs,
} from "@/lib/analytics/alerts";

const WS = "ws_1";
const NOW = new Date("2026-10-15T10:00:00Z");
const minutesAgo = (m: number) => new Date(NOW.getTime() - m * 60_000);

const calm: AlertInputs = {
  workerDown: false,
  workerAgeMs: 1000,
  metaAttempts: 50,
  metaFailures: 2,
  dmQueueEtaMinutes: 5,
  webhookDelayMaxMs: 2000,
  llmCalls: 20,
  llmFailures: 1,
};

beforeEach(() => {
  resetDb();
});

describe("evaluateAlertRules", () => {
  it("is quiet when everything is healthy", () => {
    expect(evaluateAlertRules(calm)).toEqual([]);
  });

  it("fires each rule exactly past its threshold", () => {
    const ids = (over: Partial<AlertInputs>) => evaluateAlertRules({ ...calm, ...over }).map((a) => a.rule.id);
    expect(ids({ workerDown: true })).toEqual(["worker_down"]);
    // Meta: > 20% with at least 10 attempts
    expect(ids({ metaAttempts: 10, metaFailures: 3 })).toEqual(["meta_error_rate"]);
    expect(ids({ metaAttempts: 10, metaFailures: 2 })).toEqual([]);
    expect(ids({ metaAttempts: 9, metaFailures: 9 })).toEqual([]);
    // DM queue ETA: > 60 minutes
    expect(ids({ dmQueueEtaMinutes: 61 })).toEqual(["dm_queue_eta"]);
    expect(ids({ dmQueueEtaMinutes: 60 })).toEqual([]);
    // Webhook delay: > 5 minutes
    expect(ids({ webhookDelayMaxMs: 5 * 60_000 + 1 })).toEqual(["webhook_delay"]);
    expect(ids({ webhookDelayMaxMs: 5 * 60_000 })).toEqual([]);
    // LLM: > 30% with at least 5 calls
    expect(ids({ llmCalls: 10, llmFailures: 4 })).toEqual(["llm_failure_rate"]);
    expect(ids({ llmCalls: 4, llmFailures: 4 })).toEqual([]);
  });

  it("unknown inputs (Redis down, no data) never fire", () => {
    const unknown: AlertInputs = { workerDown: null, workerAgeMs: null, metaAttempts: null, metaFailures: null, dmQueueEtaMinutes: null, webhookDelayMaxMs: null, llmCalls: null, llmFailures: null };
    expect(evaluateAlertRules(unknown)).toEqual([]);
  });
});

describe("runAlertsForWorkspace", () => {
  const bad: AlertInputs = { ...calm, workerDown: true, dmQueueEtaMinutes: 90 };

  it("alerts once, then respects the 6 hour cooldown, then alerts again", async () => {
    const notify = vi.fn(async () => {});
    const deps = { loadInputs: async () => bad, notify };

    const first = await runAlertsForWorkspace(WS, NOW, deps);
    expect(first.fired.sort()).toEqual(["dm_queue_eta", "worker_down"]);
    expect(notify).toHaveBeenCalledTimes(2);
    expect(db.rows("analyticsAlertState")).toHaveLength(2);

    const soon = await runAlertsForWorkspace(WS, new Date(NOW.getTime() + 5 * 60_000), deps);
    expect(soon.fired).toEqual([]);
    expect(soon.cooledDown.sort()).toEqual(["dm_queue_eta", "worker_down"]);
    expect(notify).toHaveBeenCalledTimes(2);

    const almost = await runAlertsForWorkspace(WS, new Date(NOW.getTime() + ALERT_COOLDOWN_MS - 1), deps);
    expect(almost.fired).toEqual([]);

    const later = await runAlertsForWorkspace(WS, new Date(NOW.getTime() + ALERT_COOLDOWN_MS), deps);
    expect(later.fired.sort()).toEqual(["dm_queue_eta", "worker_down"]);
    expect(notify).toHaveBeenCalledTimes(4);
    // state rows are updated, not duplicated
    expect(db.rows("analyticsAlertState")).toHaveLength(2);
  });

  it("cooldown is per rule: a new problem alerts while an old one is cooling down", async () => {
    const notify = vi.fn(async () => {});
    await runAlertsForWorkspace(WS, NOW, { loadInputs: async () => ({ ...calm, workerDown: true }), notify });
    const later = new Date(NOW.getTime() + 60 * 60_000);
    const res = await runAlertsForWorkspace(WS, later, { loadInputs: async () => ({ ...calm, workerDown: true, llmCalls: 10, llmFailures: 9 }), notify });
    expect(res.fired).toEqual(["llm_failure_rate"]);
    expect(res.cooledDown).toEqual(["worker_down"]);
  });

  it("cooldown is per workspace and a failing delivery does not break the run", async () => {
    const notify = vi.fn(async () => {
      throw new Error("telegram down");
    });
    const a = await runAlertsForWorkspace("ws_a", NOW, { loadInputs: async () => bad, notify });
    const b = await runAlertsForWorkspace("ws_b", NOW, { loadInputs: async () => bad, notify });
    expect(a.fired).toHaveLength(2);
    expect(b.fired).toHaveLength(2);
    expect(db.rows("analyticsAlertState")).toHaveLength(4);
  });

  it("delivers a readable message through alertWorkspace by default", async () => {
    const { alertWorkspace } = await import("@/lib/telegram/notify");
    await runAlertsForWorkspace(WS, NOW, { loadInputs: async () => ({ ...calm, workerDown: true }) });
    expect(alertWorkspace).toHaveBeenCalledWith(WS, expect.stringContaining("Worker ishlamayapti"), expect.stringContaining("Worker"), expect.stringContaining("Worker"));
  });
});

describe("loadAlertInputs", () => {
  it("measures the last 15 minutes from the database and tolerates unknown sources", async () => {
    // 12 attempts, 3 failed, inside the window; one old failure outside it
    for (let i = 0; i < 9; i++) db.seed("dmLog", { workspaceId: WS, automationId: "a", instagramAccountId: "ig", status: "SENT", createdAt: minutesAgo(5) });
    for (let i = 0; i < 3; i++) db.seed("dmLog", { workspaceId: WS, automationId: "a", instagramAccountId: "ig", status: "FAILED", createdAt: minutesAgo(6) });
    db.seed("dmLog", { workspaceId: WS, automationId: "a", instagramAccountId: "ig", status: "FAILED", createdAt: minutesAgo(60) });
    db.seed("instagramEvent", { workspaceId: WS, instagramAccountId: "ig", eventType: "COMMENT", messageId: "m", senderId: "s", timestamp: minutesAgo(20), createdAt: minutesAgo(10), rawPayload: {} });
    for (let i = 0; i < 5; i++) db.seed("llmUsage", { workspaceId: WS, kind: "reply", ok: i < 2, createdAt: minutesAgo(3) });

    const inputs = await loadAlertInputs(WS, NOW);
    expect(inputs).toMatchObject({ metaAttempts: 12, metaFailures: 3, webhookDelayMaxMs: 10 * 60_000, llmCalls: 5, llmFailures: 3, dmQueueEtaMinutes: 90, workerDown: true });
    const fired = evaluateAlertRules(inputs).map((a) => a.rule.id).sort();
    expect(fired).toEqual(["dm_queue_eta", "llm_failure_rate", "meta_error_rate", "webhook_delay", "worker_down"]);
  });
});

describe("describeAlertRules", () => {
  it("lists every rule with the time it last alerted", async () => {
    await runAlertsForWorkspace(WS, NOW, { loadInputs: async () => ({ ...calm, workerDown: true }), notify: async () => {} });
    const rules = await describeAlertRules(WS);
    expect(rules).toHaveLength(5);
    expect(rules.find((r) => r.id === "worker_down")?.lastAlertedAt).toBe(NOW.toISOString());
    expect(rules.find((r) => r.id === "meta_error_rate")?.lastAlertedAt).toBeNull();
  });
});
