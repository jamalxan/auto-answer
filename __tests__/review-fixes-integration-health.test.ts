/**
 * Review fix M5: integration health checks do not oscillate or spam alerts,
 * run with bounded concurrency and a per-check timeout.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");

const mocks = vi.hoisted(() => ({
  busCheck: vi.fn(),
  alertWorkspace: vi.fn(async () => {}),
  runConnectionCheck: vi.fn(),
}));

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/assistant-queue", () => ({
  enqueueDelivery: vi.fn(async () => {}),
  enqueueNotify: vi.fn(async () => {}),
  scheduleReply: vi.fn(async () => {}),
}));
vi.mock("../lib/telegram/notify", () => ({
  alertWorkspace: mocks.alertWorkspace,
  getWorkspaceChats: vi.fn(async () => []),
  sendWithRetry: vi.fn(async () => ({ message_id: 1 })),
  notifyWorkspaceChats: vi.fn(async () => 1),
}));
vi.mock("../lib/integrations2/connectors", async (original) => ({
  ...(await original<typeof import("../lib/integrations2/connectors")>()),
  checkBusIntegration: mocks.busCheck,
}));

import { BROKEN_ALERT_COOLDOWN_MS } from "../lib/leads/delivery";
import { RESUME_AFTER_PASSES, runConnectionCheck } from "../lib/integrations/service";
import { db, resetDb } from "./helpers/db-instance";

type Row = Record<string, unknown>;
const integration = () => (db.rows("integration") as Row[])[0];
const AUTH = { ok: false, reason: "auth", message: "401" };
const OK = { ok: true };

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-10-17T12:00:00Z"));
  db.seed("workspace", { id: "w1", name: "T" });
  db.seed("integration", { id: "i1", workspaceId: "w1", type: "WEBHOOK", name: "CRM", status: "ACTIVE", config: {} });
});
afterEach(() => vi.useRealTimers());

describe("flapping integration", () => {
  it("an auth failure breaks it and alerts once", async () => {
    mocks.busCheck.mockResolvedValue(AUTH);
    await runConnectionCheck("i1");
    expect(integration()).toMatchObject({ status: "BROKEN" });
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(1);
    expect(db.rows("operationalEvent")).toHaveLength(1);
  });

  it("one passing background check does not resume it; two in a row do", async () => {
    mocks.busCheck.mockResolvedValue(AUTH);
    await runConnectionCheck("i1");
    mocks.busCheck.mockResolvedValue(OK);
    await runConnectionCheck("i1");
    expect(integration()).toMatchObject({ status: "BROKEN", healthOkStreak: 1 });
    await runConnectionCheck("i1");
    expect(RESUME_AFTER_PASSES).toBe(2);
    expect(integration()).toMatchObject({ status: "ACTIVE", healthOkStreak: 0, lastError: null });
  });

  it("a failure between two passes restarts the streak", async () => {
    mocks.busCheck.mockResolvedValue(AUTH);
    await runConnectionCheck("i1");
    mocks.busCheck.mockResolvedValue(OK);
    await runConnectionCheck("i1");
    mocks.busCheck.mockResolvedValue(AUTH);
    await runConnectionCheck("i1");
    expect(integration()).toMatchObject({ status: "BROKEN", healthOkStreak: 0 });
    mocks.busCheck.mockResolvedValue(OK);
    await runConnectionCheck("i1");
    expect(integration()).toMatchObject({ status: "BROKEN", healthOkStreak: 1 });
  });

  it("a manual re-check resumes at once", async () => {
    mocks.busCheck.mockResolvedValue(AUTH);
    await runConnectionCheck("i1");
    mocks.busCheck.mockResolvedValue(OK);
    await runConnectionCheck("i1", { manual: true });
    expect(integration()).toMatchObject({ status: "ACTIVE" });
  });

  it("a break/repair/break cycle alerts at most once per 6h, then again after the cooldown", async () => {
    const cycle = async () => {
      mocks.busCheck.mockResolvedValue(AUTH);
      await runConnectionCheck("i1");
      mocks.busCheck.mockResolvedValue(OK);
      await runConnectionCheck("i1", { manual: true });
    };
    await cycle();
    vi.advanceTimersByTime(5 * 60_000);
    await cycle();
    vi.advanceTimersByTime(5 * 60_000);
    mocks.busCheck.mockResolvedValue(AUTH);
    await runConnectionCheck("i1");
    expect(integration()).toMatchObject({ status: "BROKEN" });
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(1);
    expect(db.rows("operationalEvent")).toHaveLength(1);

    mocks.busCheck.mockResolvedValue(OK);
    await runConnectionCheck("i1", { manual: true });
    vi.advanceTimersByTime(BROKEN_ALERT_COOLDOWN_MS);
    mocks.busCheck.mockResolvedValue(AUTH);
    await runConnectionCheck("i1");
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(2);
  });
});

describe("health runner: concurrency and timeout", () => {
  it("runs at most 3 checks at once and gives up on a hung check after 8s", async () => {
    vi.resetModules();
    vi.doMock("../lib/integrations/service", () => ({ runConnectionCheck: mocks.runConnectionCheck }));
    const { runIntegrationHealthChecks, HEALTH_CHECK_CONCURRENCY, HEALTH_CHECK_TIMEOUT_MS } = await import("../lib/integrations/health");
    expect([HEALTH_CHECK_CONCURRENCY, HEALTH_CHECK_TIMEOUT_MS]).toEqual([3, 8000]);

    for (let i = 0; i < 7; i++) {
      db.seed("integration", { id: `a${i}`, workspaceId: "w1", type: "AMOCRM", name: `amo${i}`, status: "ACTIVE", config: {} });
    }
    let running = 0;
    let peak = 0;
    mocks.runConnectionCheck.mockImplementation(async (id: string) => {
      running++;
      peak = Math.max(peak, running);
      try {
        if (id === "a0") await new Promise(() => {}); // hangs forever
        await new Promise((resolve) => setTimeout(resolve, 100));
        return { ok: true };
      } finally {
        running--;
      }
    });

    const pending = runIntegrationHealthChecks();
    await vi.advanceTimersByTimeAsync(20_000);
    const result = await pending;
    expect(peak).toBeLessThanOrEqual(3);
    expect(result).toMatchObject({ checked: 7, timedOut: 1 });
    expect(mocks.runConnectionCheck).toHaveBeenCalledTimes(7);
    vi.doUnmock("../lib/integrations/service");
  });
});
