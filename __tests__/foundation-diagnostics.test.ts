/**
 * Foundation — diagnostics checklist (TZ §51, §60): every builder branch, and
 * runDiagnostics turning a failed source into "unknown" instead of failing.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    dmLog: { findFirst: vi.fn(), findMany: vi.fn() },
    webhookEvent: { findFirst: vi.fn(), count: vi.fn() },
    instagramEvent: { findFirst: vi.fn() },
    conversationMessage: { findFirst: vi.fn() },
    workspace: { findUnique: vi.fn() },
    integration: { findMany: vi.fn() },
    leadDelivery: { groupBy: vi.fn() },
    telegramUser: { count: vi.fn() },
    telegramChat: { count: vi.fn() },
  },
  getLlmProvider: vi.fn(),
  isTelegramConfigured: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/queue/client", () => ({ getDMQueue: vi.fn(), getRedisConnection: vi.fn() }));
vi.mock("@/lib/ops/worker-health", () => ({ getWorkerHealth: vi.fn() }));
vi.mock("@/lib/meta/token-health", () => ({ checkAccountToken: vi.fn() }));
vi.mock("@/lib/assistant/llm/provider", () => ({ getLlmProvider: mocks.getLlmProvider }));
vi.mock("@/lib/telegram/api", () => ({ isTelegramConfigured: mocks.isTelegramConfigured }));

import {
  buildAiCheck,
  buildConnectionCheck,
  buildCrmCheck,
  buildLastEventCheck,
  buildMessagingCheck,
  buildQueueCheck,
  buildRateLimitCheck,
  buildTelegramCheck,
  buildTokenCheck,
  buildWebhookCheck,
  buildWorkerCheck,
  runDiagnostics,
  type AccountInput,
} from "@/lib/foundation/diagnostics";
import type { ConnectionView } from "@/lib/foundation/connections";
import type { QueueStats } from "@/lib/foundation/queue-stats";
import { buildRateUsage } from "@/lib/foundation/queue-stats";

const NOW = new Date("2026-10-15T12:00:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;
const ago = (ms: number) => new Date(NOW.getTime() - ms);

function acc(overrides: Partial<AccountInput> = {}): AccountInput {
  return {
    username: "shop",
    status: "CONNECTED",
    webhookSubscribed: true,
    tokenCheckedAt: ago(HOUR),
    expiresInDays: 40,
    ...overrides,
  };
}

function dmQueue(overrides: Partial<QueueStats["dm"]> = {}): QueueStats["dm"] {
  return {
    queued: 0,
    processing: 0,
    truncated: false,
    completed24h: 10,
    failed24h: 0,
    skipped24h: 0,
    sentLastHour: 5,
    etaMinutes: 0,
    etaLabel: "Navbat bo'sh",
    ...overrides,
  };
}

describe("buildConnectionCheck", () => {
  it("error without accounts, linking to connect", () => {
    const item = buildConnectionCheck([], NOW);
    expect(item).toMatchObject({ status: "error", value: "Akkaunt yo'q", action: { href: "/api/instagram/connect?return=/developer/foundation" } });
  });

  it("error when every account is off", () => {
    expect(buildConnectionCheck([acc({ status: "DISCONNECTED" }), acc({ status: "RECONNECT_REQUIRED" })], NOW).status).toBe("error");
  });

  it("warning when some are off", () => {
    const item = buildConnectionCheck([acc(), acc({ username: "old", status: "DISCONNECTED" })], NOW);
    expect(item).toMatchObject({ status: "warning", value: "1/2 ulangan" });
    expect(item.issue).toContain("@old");
  });

  it("ok otherwise, with meaning and last check filled", () => {
    const item = buildConnectionCheck([acc()], NOW);
    expect(item).toMatchObject({ status: "ok", issue: null, action: null, lastCheck: ago(HOUR).toISOString() });
    expect(item.meaning.length).toBeGreaterThan(10);
  });
});

describe("buildTokenCheck", () => {
  it("unknown when only disconnected accounts", () => {
    expect(buildTokenCheck([acc({ status: "DISCONNECTED" })], NOW).status).toBe("unknown");
  });

  it.each(["EXPIRED", "INVALID", "RECONNECT_REQUIRED"] as const)("error for %s", (status) => {
    const item = buildTokenCheck([acc({ status })], NOW);
    expect(item.status).toBe("error");
    expect(item.value).toBe(status === "EXPIRED" ? "Muddati tugagan" : "Yaroqsiz");
  });

  it("warning for a stale / errored check", () => {
    expect(buildTokenCheck([acc({ status: "ERROR" })], NOW)).toMatchObject({ status: "warning", value: "Holati noma'lum" });
  });

  it("warning for expiring, showing the soonest", () => {
    const item = buildTokenCheck([acc({ status: "EXPIRING", expiresInDays: 6 }), acc({ status: "EXPIRING", expiresInDays: 2 })], NOW);
    expect(item).toMatchObject({ status: "warning", value: "2 kunda tugaydi" });
  });

  it("ok when connected", () => {
    expect(buildTokenCheck([acc()], NOW).status).toBe("ok");
  });
});

describe("buildMessagingCheck", () => {
  const tokenError = "Meta API Error 190: Session has expired [code=190 sub=463 type=OAuthException trace=x]";

  it("error when a token/permission failure came after the last send", () => {
    const item = buildMessagingCheck({ lastSentAt: ago(DAY), recentFailures: [{ errorMessage: tokenError, at: ago(HOUR) }] }, NOW);
    expect(item).toMatchObject({ status: "error", value: "Yuborilmayapti", action: { href: "/api/instagram/connect?return=/developer/foundation" } });
    expect(item.issue).toContain("Instagram ulanishi tugagan");
  });

  it("ignores failures older than the last successful send", () => {
    const item = buildMessagingCheck({ lastSentAt: ago(MIN), recentFailures: [{ errorMessage: tokenError, at: ago(HOUR) }] }, NOW);
    expect(item).toMatchObject({ status: "ok", value: "Oxirgi DM: 1 daqiqa oldin" });
  });

  it("warning for other recent failures", () => {
    const item = buildMessagingCheck({ lastSentAt: ago(DAY), recentFailures: [{ errorMessage: "fetch failed", at: ago(HOUR) }] }, NOW);
    expect(item).toMatchObject({ status: "warning", value: "1 ta xato" });
  });

  it("unknown when nothing was ever sent or failed", () => {
    expect(buildMessagingCheck({ lastSentAt: null, recentFailures: [] }, NOW).status).toBe("unknown");
  });

  it("error even without any send ever when the failure is blocking", () => {
    expect(
      buildMessagingCheck({ lastSentAt: null, recentFailures: [{ errorMessage: "(#10) Application does not have permission", at: ago(HOUR) }] }, NOW)
        .status
    ).toBe("error");
  });
});

describe("buildWebhookCheck", () => {
  it("unknown without live accounts", () => {
    expect(buildWebhookCheck({ accounts: [acc({ status: "DISCONNECTED" })], lastWebhookAt: null, failed24h: 0 }, NOW).status).toBe("unknown");
  });

  it("error when a live account is not subscribed", () => {
    const item = buildWebhookCheck({ accounts: [acc({ webhookSubscribed: false })], lastWebhookAt: null, failed24h: 0 }, NOW);
    expect(item).toMatchObject({ status: "error", value: "Obuna yo'q" });
  });

  it("warning for failed webhooks", () => {
    expect(buildWebhookCheck({ accounts: [acc()], lastWebhookAt: ago(MIN), failed24h: 2 }, NOW)).toMatchObject({
      status: "warning",
      value: "2 ta xato (24 soat)",
    });
  });

  it("ok, last check = last webhook", () => {
    expect(buildWebhookCheck({ accounts: [acc()], lastWebhookAt: ago(MIN), failed24h: 0 }, NOW)).toMatchObject({
      status: "ok",
      lastCheck: ago(MIN).toISOString(),
    });
  });
});

describe("buildLastEventCheck", () => {
  it("unknown with nothing connected and no events", () => {
    expect(buildLastEventCheck(null, false, NOW)).toMatchObject({ status: "unknown", issue: null });
  });

  it("warning when connected but nothing ever arrived", () => {
    expect(buildLastEventCheck(null, true, NOW)).toMatchObject({ status: "warning", value: "Hali kelmagan" });
  });

  it("warning after 3 quiet days", () => {
    expect(buildLastEventCheck(ago(4 * DAY), true, NOW)).toMatchObject({ status: "warning", value: "4 kun oldin" });
  });

  it("ok with a relative time (TZ §51 \"2 min ago\")", () => {
    expect(buildLastEventCheck(ago(2 * MIN), true, NOW)).toMatchObject({ status: "ok", value: "2 daqiqa oldin" });
  });
});

describe("buildRateLimitCheck", () => {
  const row = (username: string, usage: ReturnType<typeof buildRateUsage> | null) => ({
    instagramAccountId: username,
    username,
    usage,
  });

  it("unknown without accounts or without Redis", () => {
    expect(buildRateLimitCheck([], NOW).status).toBe("unknown");
    expect(buildRateLimitCheck([row("a", null)], NOW)).toMatchObject({ status: "unknown", value: "Noma'lum" });
  });

  it("error at the cap, with minutes to reset", () => {
    const item = buildRateLimitCheck([row("a", buildRateUsage(10, 100)), row("b", buildRateUsage(750, 600, 750))], NOW);
    expect(item).toMatchObject({ status: "error", value: "750/750 (@b)" });
    expect(item.action?.label).toContain("10 daqiqada");
  });

  it("error at the cap without a TTL still says to wait", () => {
    expect(buildRateLimitCheck([row("a", buildRateUsage(750, -1, 750))], NOW).action?.label).toBe("Limit yangilanishini kuting.");
  });

  it("warning from 80%", () => {
    expect(buildRateLimitCheck([row("a", buildRateUsage(650, 100, 750))], NOW).status).toBe("warning");
  });

  it("ok = Normal", () => {
    expect(buildRateLimitCheck([row("a", buildRateUsage(5, 100))], NOW)).toMatchObject({ status: "ok", value: "Normal" });
  });
});

describe("buildQueueCheck", () => {
  it("unknown when Redis did not answer", () => {
    expect(buildQueueCheck(dmQueue({ queued: null }), true, NOW).status).toBe("unknown");
  });

  it("error when jobs wait and the worker is down", () => {
    expect(buildQueueCheck(dmQueue({ queued: 5, etaMinutes: 3, etaLabel: "~3 daqiqa" }), false, NOW)).toMatchObject({
      status: "error",
      value: "5 · ~3 daqiqa",
    });
  });

  it("warning when nothing moves", () => {
    expect(buildQueueCheck(dmQueue({ queued: 5, etaMinutes: null }), true, NOW).status).toBe("warning");
  });

  it("warning for a long queue", () => {
    expect(buildQueueCheck(dmQueue({ queued: 900, etaMinutes: 120 }), true, NOW).status).toBe("warning");
  });

  it("ok for an empty or short queue (worker state unknown is not an error)", () => {
    expect(buildQueueCheck(dmQueue(), true, NOW)).toMatchObject({ status: "ok", value: "0" });
    expect(buildQueueCheck(dmQueue({ queued: 3, etaMinutes: 2 }), null, NOW).status).toBe("ok");
  });
});

describe("buildWorkerCheck", () => {
  it("unknown / error / ok", () => {
    expect(buildWorkerCheck(null, NOW).status).toBe("unknown");
    expect(buildWorkerCheck({ healthy: false, ageMs: null }, NOW)).toMatchObject({ status: "error", value: "Signal yo'q" });
    expect(buildWorkerCheck({ healthy: false, ageMs: 10 * MIN }, NOW)).toMatchObject({
      status: "error",
      value: "Oxirgi signal: 10 daqiqa oldin",
      lastCheck: ago(10 * MIN).toISOString(),
    });
    expect(buildWorkerCheck({ healthy: true, ageMs: 5000 }, NOW).status).toBe("ok");
  });
});

describe("buildAiCheck", () => {
  it("warning when not configured", () => {
    expect(buildAiCheck({ configured: false, model: null, templateOnlyUntil: null }, NOW)).toMatchObject({
      status: "warning",
      value: "Sozlanmagan",
    });
  });

  it("warning while in template-only mode", () => {
    const item = buildAiCheck({ configured: true, model: "m", templateOnlyUntil: new Date(NOW.getTime() + 30 * MIN) }, NOW);
    expect(item).toMatchObject({ status: "warning", value: "Faqat shablonlar" });
    expect(item.issue).toContain("30 daqiqa");
  });

  it("ok once template-only mode has passed", () => {
    expect(buildAiCheck({ configured: true, model: "gemini", templateOnlyUntil: ago(MIN) }, NOW)).toMatchObject({
      status: "ok",
      value: "Ishlayapti · gemini",
    });
  });
});

describe("buildCrmCheck", () => {
  const integration = (status: string) => ({ name: "amoCRM", type: "AMOCRM", status, lastError: null, lastCheckedAt: ago(HOUR) });

  it("unknown when nothing (enabled) is connected", () => {
    expect(buildCrmCheck({ integrations: [], failed24h: 0, dead24h: 0 }, NOW)).toMatchObject({ status: "unknown", value: "Ulanmagan" });
    expect(buildCrmCheck({ integrations: [integration("DISABLED")], failed24h: 0, dead24h: 0 }, NOW).status).toBe("unknown");
  });

  it("error when broken or leads died", () => {
    expect(buildCrmCheck({ integrations: [integration("BROKEN")], failed24h: 0, dead24h: 0 }, NOW).status).toBe("error");
    expect(buildCrmCheck({ integrations: [integration("ACTIVE")], failed24h: 0, dead24h: 2 }, NOW).value).toBe("2 ta lid yetkazilmadi");
  });

  it("warning while retrying, ok otherwise", () => {
    expect(buildCrmCheck({ integrations: [integration("ACTIVE")], failed24h: 1, dead24h: 0 }, NOW).status).toBe("warning");
    expect(buildCrmCheck({ integrations: [integration("ACTIVE")], failed24h: 0, dead24h: 0 }, NOW)).toMatchObject({
      status: "ok",
      lastCheck: ago(HOUR).toISOString(),
    });
  });
});

describe("buildTelegramCheck", () => {
  it("unknown without a bot, warning when not linked, ok when linked", () => {
    expect(buildTelegramCheck({ botConfigured: false, linkedUsers: 1, activeChats: 1 }, NOW).status).toBe("unknown");
    expect(buildTelegramCheck({ botConfigured: true, linkedUsers: 0, activeChats: 0 }, NOW).status).toBe("warning");
    expect(buildTelegramCheck({ botConfigured: true, linkedUsers: 0, activeChats: 2 }, NOW)).toMatchObject({
      status: "ok",
      value: "Ulangan · 2 chat",
    });
  });
});

describe("runDiagnostics", () => {
  const connection = {
    id: "acc1",
    instagramId: "IG1",
    username: "shop",
    status: "CONNECTED",
    tone: "success",
    title: "Ulangan",
    explanation: "",
    action: { kind: "none", label: "" },
    expiresInDays: 40,
    webhookSubscribed: true,
    tokenExpiresAt: null,
    tokenCheckedAt: ago(HOUR).toISOString(),
    tokenBrokenAt: null,
    connectedAt: ago(DAY).toISOString(),
  } satisfies ConnectionView;

  const queue: QueueStats = {
    dm: dmQueue(),
    triggers: { backlog: 0, last24h: {} },
    rate: [{ instagramAccountId: "acc1", username: "shop", usage: buildRateUsage(3, 100) }],
    checkedAt: NOW.toISOString(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    const p = mocks.prisma;
    p.dmLog.findFirst.mockResolvedValue({ dmSentAt: ago(5 * MIN) });
    p.dmLog.findMany.mockResolvedValue([]);
    p.webhookEvent.findFirst.mockResolvedValue({ createdAt: ago(2 * MIN) });
    p.webhookEvent.count.mockResolvedValue(0);
    p.instagramEvent.findFirst.mockResolvedValue(null);
    p.conversationMessage.findFirst.mockResolvedValue(null);
    p.workspace.findUnique.mockResolvedValue({ assistantTemplateOnlyUntil: null });
    p.integration.findMany.mockResolvedValue([]);
    p.leadDelivery.groupBy.mockResolvedValue([]);
    p.telegramUser.count.mockResolvedValue(1);
    p.telegramChat.count.mockResolvedValue(1);
    mocks.getLlmProvider.mockReturnValue({ name: "openai", model: "gemini-flash-lite" });
    mocks.isTelegramConfigured.mockReturnValue(true);
  });

  it("returns the eleven TZ §51 rows, scoped to the workspace", async () => {
    const items = await runDiagnostics("ws_1", { connections: [connection], queue, worker: { healthy: true, ageMs: 1000 } }, NOW);
    expect(items.map((i) => i.key)).toEqual([
      "instagram",
      "token",
      "messaging",
      "webhook",
      "last_event",
      "rate_limit",
      "queue",
      "worker",
      "ai",
      "crm",
      "telegram",
    ]);
    expect(Object.fromEntries(items.map((i) => [i.key, i.status]))).toEqual({
      instagram: "ok",
      token: "ok",
      messaging: "ok",
      webhook: "ok",
      last_event: "ok",
      rate_limit: "ok",
      queue: "ok",
      worker: "ok",
      ai: "ok",
      crm: "unknown",
      telegram: "ok",
    });
    expect(items.find((i) => i.key === "last_event")?.value).toBe("2 daqiqa oldin");
    for (const call of [
      mocks.prisma.dmLog.findFirst,
      mocks.prisma.dmLog.findMany,
      mocks.prisma.webhookEvent.findFirst,
      mocks.prisma.webhookEvent.count,
      mocks.prisma.instagramEvent.findFirst,
      mocks.prisma.telegramUser.count,
    ]) {
      expect(call.mock.calls[0][0].where.workspaceId).toBe("ws_1");
    }
    expect(mocks.prisma.leadDelivery.groupBy.mock.calls[0][0].where.integration.workspaceId).toBe("ws_1");
    expect(mocks.prisma.telegramChat.count.mock.calls[0][0].where.integration.workspaceId).toBe("ws_1");
  });

  it("a failing source becomes an 'unknown' row, the rest still render", async () => {
    mocks.prisma.dmLog.findFirst.mockRejectedValue(new Error("db down"));
    mocks.prisma.telegramUser.count.mockRejectedValue(new Error("db down"));
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const items = await runDiagnostics("ws_1", { connections: [connection], queue, worker: null }, NOW);
    spy.mockRestore();
    const byKey = Object.fromEntries(items.map((i) => [i.key, i]));
    expect(byKey.messaging.status).toBe("unknown");
    expect(byKey.telegram.status).toBe("unknown");
    expect(byKey.worker.status).toBe("unknown");
    expect(byKey.instagram.status).toBe("ok");
  });

  it("an unconfigured LLM or a throwing provider factory reads as not configured", async () => {
    mocks.getLlmProvider.mockImplementation(() => {
      throw new Error("missing key");
    });
    const items = await runDiagnostics("ws_1", { connections: [connection], queue, worker: null }, NOW);
    expect(items.find((i) => i.key === "ai")?.value).toBe("Sozlanmagan");
  });
});
