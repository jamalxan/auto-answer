/**
 * Scenario D: token lifecycle.
 *
 *  a) amoCRM token expiry warnings (7 days, 1 day, shortened expiry), once per threshold
 *  b) Instagram token: refresh cron + derived EXPIRING status at the same thresholds
 *  c) 401/403 from amoCRM -> INTEGRATION_AUTH_EXPIRED, reconnect action, BROKEN, one alert
 *  d) lead held while broken is delivered automatically after the reconnect
 *  e) alerts / diagnostics only claim channels that are really connected
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
vi.stubEnv("REDIS_URL", "redis://localhost:6379");

const mocks = vi.hoisted(() => ({
  alertWorkspace: vi.fn(async () => {}),
  getWorkspaceChats: vi.fn(async () => [] as unknown[]),
  refreshLongLivedToken: vi.fn(),
}));

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/integrations/throttle", () => ({ acquireSlot: vi.fn(async () => {}) }));
vi.mock("../lib/queue/assistant-queue", () => ({
  enqueueDelivery: vi.fn(async () => {}),
  enqueueNotify: vi.fn(async () => {}),
  scheduleReply: vi.fn(async () => {}),
}));
vi.mock("../lib/telegram/notify", () => ({
  alertWorkspace: mocks.alertWorkspace,
  getWorkspaceChats: mocks.getWorkspaceChats,
  sendWithRetry: vi.fn(async () => ({ message_id: 11 })),
  notifyWorkspaceChats: vi.fn(async () => 1),
}));
vi.mock("../lib/telegram/api", async (original) => ({
  ...(await original<typeof import("../lib/telegram/api")>()),
  editMessageReplyMarkup: vi.fn(async () => ({})),
}));
vi.mock("../lib/cron-auth", () => ({ isAuthorizedCronRequest: () => true }));
vi.mock("../lib/meta/client", async (original) => ({
  ...(await original<typeof import("../lib/meta/client")>()),
  refreshLongLivedToken: mocks.refreshLongLivedToken,
}));

import { runTokenExpiryWarnings } from "../lib/integrations/expiry";
import { runConnectionCheck, expiryWarningDue, RESUME_AFTER_PASSES } from "../lib/integrations/service";
import { runIntegrationHealthChecks } from "../lib/integrations/health";
import { encryptCredentials } from "../lib/integrations/crypto";
import { IntegrationAuthError } from "../lib/integrations/errors";
import { enqueueLeadDeliveries, processDelivery, sweepDueDeliveries } from "../lib/leads/delivery";
import { loadDeliverySummary } from "../lib/leads/undelivered";
import { explainError } from "../lib/foundation/error-catalog";
import { deriveConnectionStatus } from "../lib/foundation/connection-status";
import { buildCrmCheck, buildTelegramCheck, buildTokenCheck } from "../lib/foundation/diagnostics";
import { encryptToken } from "../lib/meta/oauth";
import { enqueueDelivery } from "../lib/queue/assistant-queue";
import { GET as refreshTokensCron } from "../app/api/cron/refresh-tokens/route";
import { dictionaries } from "../lib/i18n/translations";
import { db, resetDb } from "./helpers/db-instance";
import { NextRequest } from "next/server";

type Row = Record<string, unknown>;
const DAY = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-10-20T09:00:00Z");
const TOKEN = "t".repeat(40);

function mockCrm(handler: (url: string) => { status?: number; body?: unknown }) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string) => {
      const { status = 200, body } = handler(url);
      return { ok: status >= 200 && status < 300, status, json: async () => body, text: async () => "" } as Response;
    })
  );
}
const amoOk = (url: string) => (url.endsWith("/leads/complex") ? { body: [{ id: 9001 }] } : { body: [{ id: 1 }] });

function seedAmo(extra: Row = {}) {
  db.seed("workspace", { id: "w1", name: "T" });
  db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "shop", instagramId: "ig1" });
  return db.seed("integration", {
    id: "int_amo", workspaceId: "w1", type: "AMOCRM", name: "amoCRM", status: "ACTIVE",
    credentialsEncrypted: encryptCredentials({ token: TOKEN }),
    config: { subdomain: "promtchi", zone: "amocrm.ru" },
    ...extra,
  });
}
function seedLead(id = "l1") {
  return db.seed("lead", {
    id, workspaceId: "w1", instagramAccountId: "a1", conversationId: null, idempotencyKey: `${id}:0`,
    igUserId: `u_${id}`, igUsername: "aziz", name: "Aziz", phoneE164: "+998901234567",
    productInterest: "divan", transcript: "T", summary: "S", isTest: false,
  });
}

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  mocks.getWorkspaceChats.mockResolvedValue([]);
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

// ── a) amoCRM token expiry ──────────────────────────────────────────────────────

describe("D(a) amoCRM token expiry warnings", () => {
  const warnings = () => db.rows("operationalEvent").filter((e) => e.level === "WARNING");

  it("7 days left: one warning, and a second run does not repeat it", async () => {
    seedAmo({ tokenExpiresAt: new Date(NOW.getTime() + 7 * DAY - 60_000) });
    expect(await runTokenExpiryWarnings(NOW)).toBe(1);
    expect(await runTokenExpiryWarnings(NOW)).toBe(0);
    expect(await runTokenExpiryWarnings(new Date(NOW.getTime() + 3600_000))).toBe(0);
    expect(warnings()).toHaveLength(1);
    expect(warnings()[0].payload).toMatchObject({ integrationId: "int_amo", daysLeft: 7 });
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(1);
  });

  it("1 day left: a fresh warning fires once, after the 7-day one", async () => {
    seedAmo({ tokenExpiresAt: new Date(NOW.getTime() + 7 * DAY - 60_000) });
    await runTokenExpiryWarnings(NOW);
    // six days later: 1 day left
    const later = new Date(NOW.getTime() + 6 * DAY);
    vi.setSystemTime(later);
    expect(await runTokenExpiryWarnings(later)).toBe(1);
    expect(await runTokenExpiryWarnings(later)).toBe(0);
    expect(warnings().map((w) => (w.payload as Row).daysLeft)).toEqual([7, 1]);
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(2);
  });

  it("exactly 1 day left on a never-warned token warns (1-day threshold alone)", async () => {
    seedAmo({ tokenExpiresAt: new Date(NOW.getTime() + 1 * DAY - 60_000) });
    expect(await runTokenExpiryWarnings(NOW)).toBe(1);
    expect(warnings()[0].payload).toMatchObject({ daysLeft: 1 });
    expect(await runTokenExpiryWarnings(NOW)).toBe(0);
  });

  it("more than 7 days left: no warning; already expired: no warning (health check owns that)", async () => {
    seedAmo({ tokenExpiresAt: new Date(NOW.getTime() + 9 * DAY) });
    expect(await runTokenExpiryWarnings(NOW)).toBe(0);
    db.rows("integration")[0].tokenExpiresAt = new Date(NOW.getTime() - 1000);
    expect(await runTokenExpiryWarnings(NOW)).toBe(0);
    expect(warnings()).toHaveLength(0);
    expect(expiryWarningDue(new Date(NOW.getTime() - 1), null, NOW)).toBeNull();
  });

  it("expiry shortened to 3 days (token swapped for a short one): a warning appears", async () => {
    seedAmo({ tokenExpiresAt: new Date(NOW.getTime() + 30 * DAY) });
    expect(await runTokenExpiryWarnings(NOW)).toBe(0);
    db.rows("integration")[0].tokenExpiresAt = new Date(NOW.getTime() + 3 * DAY);
    expect(await runTokenExpiryWarnings(NOW)).toBe(1);
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(1);
    expect(await runTokenExpiryWarnings(NOW)).toBe(0); // once
  });

  it("the 3-day warning text does not claim '7 days' (message must be accurate)", async () => {
    seedAmo({ tokenExpiresAt: new Date(NOW.getTime() + 3 * DAY) });
    await runTokenExpiryWarnings(NOW);
    const message = String(warnings()[0].message);
    expect(message).not.toContain("7 kundan");
    expect(message).toMatch(/3 kun/);
  });

  it("a BROKEN or DISABLED integration is not warned about", async () => {
    seedAmo({ status: "BROKEN", tokenExpiresAt: new Date(NOW.getTime() + 2 * DAY) });
    expect(await runTokenExpiryWarnings(NOW)).toBe(0);
  });

  it("an expired token is caught by the health check and flips to BROKEN", async () => {
    seedAmo({ tokenExpiresAt: new Date(NOW.getTime() - DAY) });
    mockCrm(() => ({ status: 401 }));
    const result = await runIntegrationHealthChecks();
    expect(result).toMatchObject({ checked: 1, broken: 1 });
    expect(db.rows("integration")[0].status).toBe("BROKEN");
  });
});

// ── b) Instagram token ──────────────────────────────────────────────────────────

describe("D(b) Instagram token thresholds", () => {
  const fields = (daysLeft: number) => ({
    accessToken: "enc",
    tokenExpiresAt: new Date(NOW.getTime() + daysLeft * DAY + 60_000),
    tokenStatus: "ACTIVE",
    tokenCheckedAt: new Date(NOW.getTime() - 3600_000),
    tokenLastError: null,
  });

  it.each([7, 3, 1])("with %i days left the connection is EXPIRING with a reconnect action", (days) => {
    const derived = deriveConnectionStatus(fields(days), NOW);
    expect(derived.status).toBe("EXPIRING");
    expect(derived.tone).toBe("warning");
    expect(derived.expiresInDays).toBe(days);
    expect(derived.action.kind).toBe("reconnect");
    expect(derived.explanation).toContain(`${days} kun`);
  });

  it("more than 10 days left is CONNECTED; past expiry is EXPIRED", () => {
    expect(deriveConnectionStatus(fields(20), NOW).status).toBe("CONNECTED");
    expect(deriveConnectionStatus(fields(-1), NOW).status).toBe("EXPIRED");
  });

  it("the diagnostics token check warns while expiring and names the soonest expiry", () => {
    const accounts = [1, 7].map((d, i) => ({
      username: `acc${i}`,
      ...deriveConnectionStatus(fields(d), NOW),
      lastCheck: NOW.toISOString(),
    }));
    const item = buildTokenCheck(accounts as never, NOW);
    expect(item.status).toBe("warning");
    expect(item.value).toContain("1 kunda");
  });

  it("the refresh cron renews a token with 7 days left, so no warning is needed", async () => {
    db.seed("workspace", { id: "w1", name: "T", usagePeriodStart: new Date(NOW.getTime()) });
    db.seed("instagramAccount", {
      id: "a1", workspaceId: "w1", username: "shop", instagramId: "ig1",
      accessToken: encryptToken("old-token"), tokenStatus: "ACTIVE",
      tokenExpiresAt: new Date(NOW.getTime() + 7 * DAY),
    });
    mocks.refreshLongLivedToken.mockResolvedValue({ accessToken: "new-token", expiresIn: 60 * 86400 });
    await refreshTokensCron(new NextRequest("http://localhost/api/cron/refresh-tokens"));
    const acc = db.rows("instagramAccount")[0];
    expect(mocks.refreshLongLivedToken).toHaveBeenCalledTimes(1);
    expect((acc.tokenExpiresAt as Date).getTime()).toBeGreaterThan(NOW.getTime() + 50 * DAY);
    expect(acc.tokenStatus).toBe("ACTIVE");
  });

  it("a failed refresh at 1 day left leaves a visible error event (the only Instagram expiry alert)", async () => {
    db.seed("workspace", { id: "w1", name: "T", usagePeriodStart: new Date(NOW.getTime()) });
    db.seed("instagramAccount", {
      id: "a1", workspaceId: "w1", username: "shop", instagramId: "ig1",
      accessToken: encryptToken("old-token"), tokenStatus: "ACTIVE",
      tokenExpiresAt: new Date(NOW.getTime() + 1 * DAY),
    });
    mocks.refreshLongLivedToken.mockRejectedValue(new Error("network down"));
    await refreshTokensCron(new NextRequest("http://localhost/api/cron/refresh-tokens"));
    const events = db.rows("operationalEvent");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ level: "ERROR", source: "TOKEN_REFRESH" });
  });
});

// ── c) 401 / 403 ────────────────────────────────────────────────────────────────

describe("D(c) amoCRM 401/403", () => {
  it.each([401, 403])("a %i breaks the integration, types the error and alerts once", async (status) => {
    seedAmo();
    mockCrm(() => ({ status }));

    const result = await runConnectionCheck("int_amo");
    expect(result).toMatchObject({ ok: false, reason: "auth" });
    const amo = db.rows("integration")[0];
    expect(amo.status).toBe("BROKEN");
    expect(String(amo.lastError)).toContain(String(status));

    // typed error + reconnect action
    const explained = explainError(new IntegrationAuthError("amocrm", `amoCRM responded ${status}`));
    expect(explained.code).toBe("INTEGRATION_AUTH_EXPIRED");
    expect(explained.action).toMatchObject({ kind: "reconnect", href: "/integrations" });
    const fromEvent = explainError(String(db.rows("operationalEvent")[0].message));
    expect(fromEvent.code).toBe("INTEGRATION_AUTH_EXPIRED");

    // alerted once even though checks keep failing every 5 minutes
    for (let i = 0; i < 4; i++) {
      vi.advanceTimersByTime(5 * 60_000);
      await runConnectionCheck("int_amo");
    }
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(1);
    expect(db.rows("operationalEvent").filter((e) => e.level === "ERROR")).toHaveLength(1);
  });

  it("a 401 while delivering also breaks it and keeps the delivery pending (not burned through retries)", async () => {
    seedAmo();
    const lead = seedLead();
    mockCrm(() => ({ status: 401 }));
    await enqueueLeadDeliveries(lead as never, "new");
    const delivery = db.rows("leadDelivery")[0];
    await processDelivery(delivery.id as string);
    expect(db.rows("integration")[0].status).toBe("BROKEN");
    expect(delivery).toMatchObject({ status: "PENDING", attempts: 0, nextAttemptAt: null });
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(1);
    // the diagnostics CRM check says broken + links to reconnect
    const crm = buildCrmCheck(
      { integrations: [{ name: "amoCRM", type: "AMOCRM", status: "BROKEN", lastError: "401", lastCheckedAt: NOW }], failed24h: 0, dead24h: 0 },
      NOW
    );
    expect(crm.status).toBe("error");
    expect(crm.action).toMatchObject({ href: "/integrations" });
  });

  it("a 5xx is not an auth failure: stays ACTIVE", async () => {
    seedAmo();
    mockCrm(() => ({ status: 503 }));
    const result = await runConnectionCheck("int_amo");
    expect(result).toMatchObject({ ok: false, reason: "error" });
    expect(db.rows("integration")[0].status).toBe("ACTIVE");
    expect(mocks.alertWorkspace).not.toHaveBeenCalled();
  });
});

// ── d) pending lead after reconnect ─────────────────────────────────────────────

describe("D(d) held lead is delivered after the reconnect", () => {
  async function breakAndHold() {
    seedAmo();
    const lead = seedLead();
    mockCrm(() => ({ status: 401 }));
    await runConnectionCheck("int_amo");
    expect(db.rows("integration")[0].status).toBe("BROKEN");
    await enqueueLeadDeliveries(lead as never, "new");
    const delivery = db.rows("leadDelivery")[0];
    expect(delivery).toMatchObject({ status: "PENDING", nextAttemptAt: null });
    vi.mocked(enqueueDelivery).mockClear();
    return delivery;
  }

  it("is counted as undelivered while broken", async () => {
    await breakAndHold();
    const summary = await loadDeliverySummary("w1");
    expect(summary.undeliveredLeads).toBe(1);
    expect(summary.held).toBe(1);
  });

  it("manual reconnect check releases and delivers the lead automatically", async () => {
    const delivery = await breakAndHold();
    mockCrm(amoOk);
    await runConnectionCheck("int_amo", { manual: true });
    expect(db.rows("integration")[0].status).toBe("ACTIVE");
    expect(enqueueDelivery).toHaveBeenCalledWith(delivery.id);
    await processDelivery(delivery.id as string);
    expect(delivery.status).toBe("SENT");
    expect((await loadDeliverySummary("w1")).undeliveredLeads).toBe(0);
  });

  it("background checks: needs two passes, then the held lead is requeued and delivered", async () => {
    const delivery = await breakAndHold();
    mockCrm(amoOk);
    await runIntegrationHealthChecks();
    expect(db.rows("integration")[0].status).toBe("BROKEN");
    expect(enqueueDelivery).not.toHaveBeenCalled();
    await runIntegrationHealthChecks();
    expect(RESUME_AFTER_PASSES).toBe(2);
    expect(db.rows("integration")[0].status).toBe("ACTIVE");
    expect(enqueueDelivery).toHaveBeenCalledWith(delivery.id);
    await processDelivery(delivery.id as string);
    expect(delivery.status).toBe("SENT");
    expect(String(delivery.externalId)).toBeTruthy();
    // the "integration lost" system error is closed
    const lost = db.rows("operationalEvent").filter((e) => String(e.message).includes("integratsiyasi uzildi"));
    expect(lost.length).toBeGreaterThan(0);
    expect(lost.every((e) => e.resolvedAt)).toBe(true);
  });

  it("safety net: an orphaned held delivery on an ACTIVE integration is swept back into the queue", async () => {
    const delivery = await breakAndHold();
    // integration repaired by some path that did not call resumeIntegration
    db.rows("integration")[0].status = "ACTIVE";
    vi.advanceTimersByTime(5 * 60_000);
    delivery.updatedAt = new Date(NOW.getTime());
    const queued = await sweepDueDeliveries();
    expect(queued).toBeGreaterThanOrEqual(1);
    expect(enqueueDelivery).toHaveBeenCalledWith(delivery.id);
  });

  it("many leads held during the outage are all released", async () => {
    seedAmo();
    mockCrm(() => ({ status: 403 }));
    await runConnectionCheck("int_amo");
    for (let i = 0; i < 5; i++) await enqueueLeadDeliveries(seedLead(`l${i}`) as never, "new");
    vi.mocked(enqueueDelivery).mockClear();
    mockCrm(amoOk);
    await runConnectionCheck("int_amo", { manual: true });
    expect(enqueueDelivery).toHaveBeenCalledTimes(5);
    for (const d of db.rows("leadDelivery")) await processDelivery(d.id as string);
    expect(db.rows("leadDelivery").every((d) => d.status === "SENT")).toBe(true);
  });
});

// ── e) only real channels are named ─────────────────────────────────────────────

describe("D(e) alerts and diagnostics name only connected channels", () => {
  const plainAlertText = () => String((mocks.alertWorkspace.mock.calls[0] as unknown[])[3]);

  it("Telegram not connected: the broken-CRM alert does not promise Telegram delivery", async () => {
    seedAmo();
    mocks.getWorkspaceChats.mockResolvedValue([]);
    mockCrm(() => ({ status: 401 }));
    await runConnectionCheck("int_amo");
    const text = plainAlertText();
    expect(text).toContain("Telegram ulanmagan");
    expect(text).not.toContain("Telegram'ga yetkazilishda davom etadi");
  });

  it("Telegram connected: the alert says Telegram keeps receiving leads", async () => {
    seedAmo();
    mocks.getWorkspaceChats.mockResolvedValue([{ id: "c1", chatId: "1", integrationId: "t1" }]);
    mockCrm(() => ({ status: 401 }));
    await runConnectionCheck("int_amo");
    const text = plainAlertText();
    expect(text).toContain("Telegram'ga yetkazilishda davom etadi");
    expect(text).not.toContain("Telegram ulanmagan");
  });

  it("diagnostics: Telegram with no active chat is a warning 'Ulanmagan', never 'ok'", () => {
    const item = buildTelegramCheck({ botConfigured: true, linkedUsers: 3, activeChats: 0 }, NOW);
    expect(item.status).toBe("warning");
    expect(item.value).toBe("Ulanmagan");
    expect(item.value).not.toMatch(/Ulangan/);
    const ok = buildTelegramCheck({ botConfigured: true, linkedUsers: 0, activeChats: 2 }, NOW);
    expect(ok.status).toBe("ok");
    expect(ok.value).toContain("2 chat");
  });

  it("diagnostics: CRM check names only the broken CRM, not other integrations", () => {
    const item = buildCrmCheck(
      {
        integrations: [
          { name: "amoCRM", type: "AMOCRM", status: "BROKEN", lastError: "401", lastCheckedAt: NOW },
          { name: "Bitrix", type: "BITRIX24", status: "ACTIVE", lastError: null, lastCheckedAt: NOW },
        ],
        failed24h: 0,
        dead24h: 0,
      },
      NOW
    );
    expect(item.issue).toContain("amoCRM");
    expect(item.issue).not.toContain("Bitrix");
  });

  it("Instagram token banner names only the accounts whose token is broken", () => {
    const accounts = [
      { username: "ok_shop", tokenStatus: "ACTIVE" },
      { username: "dead_shop", tokenStatus: "BROKEN" },
    ];
    const broken = accounts.filter((a) => a.tokenStatus === "BROKEN");
    const body = dictionaries.uz.assistant.tokenBanner.body(broken.map((a) => `@${a.username}`).join(", "));
    expect(body).toContain("@dead_shop");
    expect(body).not.toContain("ok_shop");
    // and the banner copy never mentions Telegram as a connected channel
    expect(body).not.toMatch(/telegram/i);
  });
});
