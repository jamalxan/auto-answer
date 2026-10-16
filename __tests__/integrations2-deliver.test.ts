/**
 * ETAP 8 — the delivery engine: retry schedule, DEAD, redeliver, 410 and the
 * auto-disable, auth hold + resume, rate limit, URL policy at send time,
 * the signature a receiver verifies, enrichment waiting for the lead push.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/integrations/throttle", () => ({ acquireSlot: vi.fn(async () => {}) }));
vi.mock("../lib/integrations2/queue", async (original) => ({
  ...(await original<typeof import("../lib/integrations2/queue")>()),
  enqueueMaterialize: vi.fn(async () => {}),
  enqueueOutboundDelivery: vi.fn(async () => {}),
}));
vi.mock("../lib/telegram/notify", () => ({
  alertWorkspace: vi.fn(async () => {}),
  sendWithRetry: vi.fn(async () => ({ message_id: 7 })),
  notifyWorkspaceChats: vi.fn(async () => 1),
}));

import { encryptCredentials } from "../lib/integrations/crypto";
import { MAX_DELIVERY_ATTEMPTS, RETRY_DELAYS_MS } from "../lib/integrations/errors";
import { setWebhookPolicyOptionsForTests } from "../lib/integrations2/connectors/webhook";
import { HEADER_SIGNATURE, HEADER_TIMESTAMP } from "../lib/integrations2/signing";
import { sampleEvent } from "../lib/integrations2/events";
import {
  processOutboundDelivery,
  purgeOldOutbound,
  redeliver,
  redeliverAllDead,
  resumeOutboundIntegration,
  sweepDueOutbound,
} from "../lib/integrations2/deliver";
import { resetKvForTests } from "../lib/integrations2/kv";
import { enqueueOutboundDelivery } from "../lib/integrations2/queue";
import { verifySignature } from "../lib/integrations2/signing";
import { alertWorkspace, sendWithRetry } from "../lib/telegram/notify";
import { db, resetDb } from "./helpers/db-instance";
import {
  PUBLIC_RESOLVER,
  SECRET,
  fakeFetch,
  privateKeyPem,
  seedDelivery,
  seedSheets,
  seedSubscription,
  seedWebhook,
  seedWorkspace,
  type FakeReply,
  type FetchCall,
} from "./helpers/integrations2";

type Row = Record<string, unknown>;
const rows = (model: string) => db.rows(model) as Row[];
const delivery = (id: string) => rows("outboundDelivery").find((d) => d.id === id)!;

function stubFetch(handler: (call: FetchCall) => FakeReply | Promise<FakeReply>) {
  const fake = fakeFetch(handler);
  vi.stubGlobal("fetch", fake.impl);
  return fake;
}

/** Make a delivery due again (the real worker waits for nextAttemptAt). */
const makeDue = (id: string) => {
  delivery(id).nextAttemptAt = new Date(Date.now() - 1000);
};

beforeEach(() => {
  resetDb();
  resetKvForTests();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  setWebhookPolicyOptionsForTests({ resolve: PUBLIC_RESOLVER, allowHosts: [], denyHosts: [] });
  seedWorkspace();
});

describe("webhook lifecycle", () => {
  it("500 → retry schedule → DEAD → redeliver → SENT, alert throttled to once an hour", async () => {
    const hook = seedWebhook();
    const sub = seedSubscription(hook.id as string);
    const d = seedDelivery({ integrationId: hook.id as string, subscriptionId: sub.id as string });
    stubFetch(() => ({ status: 500, body: "boom" }));

    for (let attempt = 1; attempt < MAX_DELIVERY_ATTEMPTS; attempt++) {
      expect((await processOutboundDelivery(d.id as string)).outcome).toBe("retry");
      const row = delivery(d.id as string);
      expect(row.status).toBe("FAILED");
      expect(row.attempts).toBe(attempt);
      const delay = (row.nextAttemptAt as Date).getTime() - Date.now();
      const expected = RETRY_DELAYS_MS[attempt - 1];
      expect(delay).toBeGreaterThan(expected - 2000);
      expect(delay).toBeLessThanOrEqual(expected);
      expect(enqueueOutboundDelivery).toHaveBeenLastCalledWith(d.id, expected, attempt);
      makeDue(d.id as string);
    }

    expect((await processOutboundDelivery(d.id as string)).outcome).toBe("dead");
    expect(delivery(d.id as string)).toMatchObject({ status: "DEAD", attempts: MAX_DELIVERY_ATTEMPTS, nextAttemptAt: null, responseCode: 500 });
    expect(rows("operationalEvent").filter((e) => String(e.message).includes("yetkazilmadi"))).toHaveLength(1);
    expect(alertWorkspace).toHaveBeenCalledTimes(1);

    // a second dead delivery of the same integration within the hour: event yes, alert no
    const d2 = seedDelivery({ integrationId: hook.id as string, subscriptionId: sub.id as string, attempts: MAX_DELIVERY_ATTEMPTS - 1 });
    expect((await processOutboundDelivery(d2.id as string)).outcome).toBe("dead");
    expect(alertWorkspace).toHaveBeenCalledTimes(1);

    // the receiver is fixed → redeliver → SENT
    stubFetch(() => ({ status: 200, body: "ok" }));
    expect(await redeliver(d.id as string)).toEqual({ queued: true });
    expect(delivery(d.id as string)).toMatchObject({ status: "PENDING", attempts: 0 });
    expect((await processOutboundDelivery(d.id as string)).outcome).toBe("sent");
    expect(delivery(d.id as string)).toMatchObject({ status: "SENT", attempts: 1, responseCode: 200, lastError: null });
    expect(delivery(d.id as string).sentAt).toBeInstanceOf(Date);
  });

  it("honours Retry-After instead of the schedule", async () => {
    const hook = seedWebhook();
    const d = seedDelivery({ integrationId: hook.id as string });
    stubFetch(() => ({ status: 429, headers: { "Retry-After": "120" } }));
    await processOutboundDelivery(d.id as string);
    expect(enqueueOutboundDelivery).toHaveBeenLastCalledWith(d.id, 120_000, 1);
  });

  it("a non-retryable 4xx goes DEAD at once without disabling the subscription", async () => {
    const hook = seedWebhook();
    const sub = seedSubscription(hook.id as string);
    const d = seedDelivery({ integrationId: hook.id as string, subscriptionId: sub.id as string });
    stubFetch(() => ({ status: 400, body: "bad" }));
    expect((await processOutboundDelivery(d.id as string)).outcome).toBe("dead");
    expect(delivery(d.id as string)).toMatchObject({ status: "DEAD", attempts: 1 });
    expect(rows("integrationSubscription")[0].active).toBe(true);
  });

  it("410 Gone disables the subscription", async () => {
    const hook = seedWebhook();
    const sub = seedSubscription(hook.id as string);
    const d = seedDelivery({ integrationId: hook.id as string, subscriptionId: sub.id as string });
    stubFetch(() => ({ status: 410 }));
    await processOutboundDelivery(d.id as string);
    expect(delivery(d.id as string).status).toBe("DEAD");
    expect(rows("integrationSubscription")[0].active).toBe(false);
    expect(rows("operationalEvent").some((e) => String(e.message).includes("obunasi o'chirildi"))).toBe(true);
  });

  it("five consecutive DEAD deliveries disable the subscription", async () => {
    const hook = seedWebhook();
    const sub = seedSubscription(hook.id as string);
    stubFetch(() => ({ status: 400 }));
    for (let i = 0; i < 4; i++) {
      const d = seedDelivery({ integrationId: hook.id as string, subscriptionId: sub.id as string });
      await processOutboundDelivery(d.id as string);
      expect(rows("integrationSubscription")[0].active).toBe(true);
    }
    const last = seedDelivery({ integrationId: hook.id as string, subscriptionId: sub.id as string });
    await processOutboundDelivery(last.id as string);
    expect(rows("integrationSubscription")[0].active).toBe(false);
  });

  it("a SENT delivery in between resets the DEAD streak", async () => {
    const hook = seedWebhook();
    const sub = seedSubscription(hook.id as string);
    let status = 400;
    stubFetch(() => ({ status }));
    for (let i = 0; i < 4; i++) await processOutboundDelivery(seedDelivery({ integrationId: hook.id as string, subscriptionId: sub.id as string }).id as string);
    status = 200;
    await processOutboundDelivery(seedDelivery({ integrationId: hook.id as string, subscriptionId: sub.id as string }).id as string);
    status = 400;
    await processOutboundDelivery(seedDelivery({ integrationId: hook.id as string, subscriptionId: sub.id as string }).id as string);
    expect(rows("integrationSubscription")[0].active).toBe(true);
  });

  it("the stored signature verifies with the shared secret and the exact body that was sent", async () => {
    const hook = seedWebhook();
    const d = seedDelivery({ integrationId: hook.id as string });
    const fake = stubFetch(() => ({ status: 200 }));
    await processOutboundDelivery(d.id as string);

    const call = fake.calls[0];
    expect(call.url).toBe("https://hooks.example.com/socialauto");
    expect(call.headers["x-socialauto-delivery-id"]).toBe(d.id);
    const result = verifySignature({
      secret: SECRET,
      timestamp: call.headers[HEADER_TIMESTAMP.toLowerCase()],
      rawBody: call.body,
      header: call.headers[HEADER_SIGNATURE.toLowerCase()],
    });
    expect(result).toEqual({ ok: true, usedPrevious: false });
    expect(delivery(d.id as string).signature).toBe(call.headers[HEADER_SIGNATURE.toLowerCase()]);
  });

  it("during a rotation both secrets sign", async () => {
    const hook = seedWebhook();
    hook.credentialsEncrypted = encryptCredentials({
      secret: SECRET,
      previousSecret: "whsec_old_" + "b".repeat(40),
      previousSecretExpiresAt: new Date(Date.now() + 3_600_000).toISOString(),
    });
    const d = seedDelivery({ integrationId: hook.id as string });
    const fake = stubFetch(() => ({ status: 200 }));
    await processOutboundDelivery(d.id as string);
    const header = fake.calls[0].headers[HEADER_SIGNATURE.toLowerCase()];
    expect(header.split(",")).toHaveLength(2);
    const base = { timestamp: fake.calls[0].headers[HEADER_TIMESTAMP.toLowerCase()], rawBody: fake.calls[0].body, header };
    expect(verifySignature({ ...base, secret: SECRET }).ok).toBe(true);
    expect(verifySignature({ ...base, secret: "x", previousSecret: "whsec_old_" + "b".repeat(40) }).ok).toBe(true);
  });

  it("an expired previous secret no longer signs", async () => {
    const hook = seedWebhook();
    hook.credentialsEncrypted = encryptCredentials({
      secret: SECRET,
      previousSecret: "whsec_old_" + "b".repeat(40),
      previousSecretExpiresAt: new Date(Date.now() - 1000).toISOString(),
    });
    const d = seedDelivery({ integrationId: hook.id as string });
    const fake = stubFetch(() => ({ status: 200 }));
    await processOutboundDelivery(d.id as string);
    expect(fake.calls[0].headers[HEADER_SIGNATURE.toLowerCase()].split(",")).toHaveLength(1);
  });

  it("refuses a private address at send time (DNS changed after the URL was saved)", async () => {
    setWebhookPolicyOptionsForTests({ resolve: async () => ["10.0.0.7"], allowHosts: [], denyHosts: [] });
    const hook = seedWebhook();
    const d = seedDelivery({ integrationId: hook.id as string });
    const fake = stubFetch(() => ({ status: 200 }));
    expect((await processOutboundDelivery(d.id as string)).outcome).toBe("dead");
    expect(fake.calls).toHaveLength(0);
    expect(String(delivery(d.id as string).lastError)).toContain("URL siyosati");
  });

  it("an unresolvable host is retried, not killed", async () => {
    setWebhookPolicyOptionsForTests({ resolve: async () => { throw new Error("ENOTFOUND"); }, allowHosts: [], denyHosts: [] });
    const hook = seedWebhook();
    const d = seedDelivery({ integrationId: hook.id as string });
    stubFetch(() => ({ status: 200 }));
    expect((await processOutboundDelivery(d.id as string)).outcome).toBe("retry");
  });

  it("never follows redirects (3xx is DEAD)", async () => {
    const hook = seedWebhook();
    const d = seedDelivery({ integrationId: hook.id as string });
    const fake = stubFetch(() => ({ status: 302, headers: { Location: "https://evil.example" } }));
    await processOutboundDelivery(d.id as string);
    expect(delivery(d.id as string).status).toBe("DEAD");
    expect(fake.calls).toHaveLength(1);
  });

  it("masks phone numbers in the stored response snippet", async () => {
    const hook = seedWebhook();
    const d = seedDelivery({ integrationId: hook.id as string });
    stubFetch(() => ({ status: 200, body: "saved +998901234567 ok" }));
    await processOutboundDelivery(d.id as string);
    expect(delivery(d.id as string).responseSnippet).toBe("saved +99890***4567 ok");
  });
});

describe("rate limit and leases", () => {
  it("reschedules over the per-minute limit without counting an attempt", async () => {
    const hook = seedWebhook({ rate: 2 });
    const ids = [1, 2, 3].map(() => seedDelivery({ integrationId: hook.id as string }).id as string);
    const fake = stubFetch(() => ({ status: 200 }));
    const outcomes = [];
    for (const id of ids) outcomes.push((await processOutboundDelivery(id)).outcome);
    expect(outcomes).toEqual(["sent", "sent", "rescheduled"]);
    expect(fake.calls).toHaveLength(2);
    const third = delivery(ids[2]);
    expect(third).toMatchObject({ status: "PENDING", attempts: 0 });
    expect((third.nextAttemptAt as Date).getTime() - Date.now()).toBeGreaterThan(55_000);
    expect(enqueueOutboundDelivery).toHaveBeenLastCalledWith(ids[2], 60_000, expect.stringMatching(/^rl/));
  });

  it("only one of two concurrent workers sends", async () => {
    const hook = seedWebhook();
    const d = seedDelivery({ integrationId: hook.id as string });
    const fake = stubFetch(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return { status: 200 };
    });
    await Promise.all([processOutboundDelivery(d.id as string), processOutboundDelivery(d.id as string)]);
    expect(fake.calls).toHaveLength(1);
  });

  it("does not send before nextAttemptAt", async () => {
    const hook = seedWebhook();
    const d = seedDelivery({ integrationId: hook.id as string, status: "FAILED", attempts: 1, nextAttemptAt: new Date(Date.now() + 60_000) });
    const fake = stubFetch(() => ({ status: 200 }));
    expect((await processOutboundDelivery(d.id as string)).outcome).toBe("noop");
    expect(fake.calls).toHaveLength(0);
  });

  it("sweeps due deliveries whose queue job is lost (including expired leases)", async () => {
    const hook = seedWebhook();
    const lost = seedDelivery({ integrationId: hook.id as string, nextAttemptAt: new Date(Date.now() - 5 * 60_000) });
    seedDelivery({ integrationId: hook.id as string, nextAttemptAt: new Date(Date.now() - 5_000) }); // not yet stale
    seedDelivery({ integrationId: hook.id as string, nextAttemptAt: null });
    expect(await sweepDueOutbound()).toBe(1);
    expect(enqueueOutboundDelivery).toHaveBeenCalledWith(lost.id, 0, expect.stringMatching(/^s/));
  });
});

describe("kill switch and held integrations", () => {
  it("INTEGRATIONS_BUS_DISABLED=1 sends nothing", async () => {
    vi.stubEnv("INTEGRATIONS_BUS_DISABLED", "1");
    const hook = seedWebhook();
    const d = seedDelivery({ integrationId: hook.id as string });
    const fake = stubFetch(() => ({ status: 200 }));
    expect((await processOutboundDelivery(d.id as string)).outcome).toBe("noop");
    expect(fake.calls).toHaveLength(0);
    expect(delivery(d.id as string).status).toBe("PENDING");
  });

  it("holds the deliveries of a BROKEN integration and releases them on resume", async () => {
    const hook = seedWebhook({ status: "BROKEN" });
    const d = seedDelivery({ integrationId: hook.id as string });
    const fake = stubFetch(() => ({ status: 200 }));
    expect((await processOutboundDelivery(d.id as string)).outcome).toBe("held");
    expect(delivery(d.id as string).nextAttemptAt).toBeNull();
    expect(fake.calls).toHaveLength(0);

    hook.status = "ACTIVE";
    expect(await resumeOutboundIntegration(hook.id as string)).toBe(1);
    expect((await processOutboundDelivery(d.id as string)).outcome).toBe("sent");
  });

  it("redeliver refuses an integration that is not ACTIVE", async () => {
    const hook = seedWebhook({ status: "DISABLED" });
    const d = seedDelivery({ integrationId: hook.id as string, status: "DEAD" });
    expect(await redeliver(d.id as string)).toEqual({ queued: false, reason: "integration_inactive" });
  });

  it("redeliverAllDead only touches the workspace's DEAD deliveries", async () => {
    seedWorkspace("w2");
    const mine = seedWebhook({ id: "int_a" });
    const theirs = seedWebhook({ id: "int_b", workspaceId: "w2" });
    const d1 = seedDelivery({ integrationId: mine.id as string, status: "DEAD" });
    const d2 = seedDelivery({ integrationId: mine.id as string, status: "SENT" });
    const d3 = seedDelivery({ integrationId: theirs.id as string, status: "DEAD", workspaceId: "w2" });
    expect(await redeliverAllDead("w1")).toBe(1);
    expect(delivery(d1.id as string).status).toBe("PENDING");
    expect(delivery(d2.id as string).status).toBe("SENT");
    expect(delivery(d3.id as string).status).toBe("DEAD");
  });
});

describe("auth errors hold the integration (Google Sheets)", () => {
  it("a rejected key marks the integration BROKEN and keeps the delivery pending; a repaired key resumes it", async () => {
    const sheet = seedSheets();
    const d = seedDelivery({ integrationId: sheet.id as string });
    let tokenOk = false;
    const fake = stubFetch((call) => {
      if (call.url.includes("oauth2.googleapis.com")) {
        return tokenOk ? { status: 200, body: { access_token: "tok", expires_in: 3600 } } : { status: 400, body: { error: "invalid_grant" } };
      }
      if (call.method === "GET") return { status: 200, body: { values: [] } };
      return { status: 200, body: { updates: { updatedRange: "SocialAuto!A2:T2" } } };
    });
    void privateKeyPem();

    expect((await processOutboundDelivery(d.id as string)).outcome).toBe("held");
    expect(rows("integration").find((i) => i.id === sheet.id)).toMatchObject({ status: "BROKEN" });
    expect(delivery(d.id as string)).toMatchObject({ status: "PENDING", attempts: 0, nextAttemptAt: null });
    expect(alertWorkspace).toHaveBeenCalled();
    expect(rows("operationalEvent").some((e) => String(e.message).includes("to'xtadi"))).toBe(true);
    // while BROKEN nothing more is sent
    const before = fake.calls.length;
    await processOutboundDelivery(d.id as string);
    expect(fake.calls.length).toBe(before);

    // the owner repairs it
    tokenOk = true;
    sheet.status = "ACTIVE";
    await resumeOutboundIntegration(sheet.id as string);
    expect((await processOutboundDelivery(d.id as string)).outcome).toBe("sent");
    expect(delivery(d.id as string).externalUrl).toContain("docs.google.com/spreadsheets");
  });
});

describe("enrichment waits for the lead push", () => {
  function seedAmo() {
    return db.seed("integration", {
      id: "int_amo", workspaceId: "w1", type: "AMOCRM", name: "amoCRM",
      credentialsEncrypted: encryptCredentials({ token: "t".repeat(40) }),
      config: { subdomain: "demo", zone: "amocrm.ru", enrich: { enabled: true, temperatureTag: true, stageMap: {}, scoreFieldId: 777 } },
    });
  }

  it("waits without burning an attempt, then enriches once the LeadDelivery is SENT", async () => {
    seedAmo();
    const sub = seedSubscription("int_amo", "lead.hot");
    db.seed("lead", { id: "l1", workspaceId: "w1", instagramAccountId: "w1_a1", idempotencyKey: "k", igUserId: "u" });
    const push = db.seed("leadDelivery", { leadId: "l1", integrationId: "int_amo", kind: "new", status: "PENDING" });
    const payload = { ...sampleEvent("lead.hot"), is_test: false, lead: { ...sampleEvent("lead.hot").lead!, id: "l1" } };
    const d = seedDelivery({ integrationId: "int_amo", subscriptionId: sub.id as string, type: "lead.hot", payload });
    const fake = stubFetch((call) => {
      if (call.method === "GET") return { status: 200, body: { id: 555, _embedded: { tags: [{ name: "instagram" }] } } };
      return { status: 200, body: [{ id: 555 }] };
    });

    expect((await processOutboundDelivery(d.id as string)).outcome).toBe("waiting");
    expect(delivery(d.id as string)).toMatchObject({ status: "PENDING", attempts: 0 });
    expect((delivery(d.id as string).nextAttemptAt as Date).getTime() - Date.now()).toBeGreaterThan(50_000);
    expect(fake.calls).toHaveLength(0);
    expect(enqueueOutboundDelivery).toHaveBeenLastCalledWith(d.id, 60_000, expect.stringMatching(/^w/));

    push.status = "SENT";
    push.externalId = "555";
    makeDue(d.id as string);
    expect((await processOutboundDelivery(d.id as string)).outcome).toBe("sent");
    const patch = fake.calls.find((c) => c.method === "PATCH")!;
    expect(patch.url).toContain("/api/v4/leads/555");
    const body = JSON.parse(patch.body);
    expect(body._embedded.tags.map((t: { name: string }) => t.name)).toEqual(["instagram", "hot"]);
    expect(body.custom_fields_values[0]).toEqual({ field_id: 777, values: [{ value: 72 }] });
    expect(fake.calls.some((c) => c.url.endsWith("/leads/555/notes"))).toBe(true);
    expect(delivery(d.id as string).externalId).toBe("555");
  });

  it("gives up as DEAD when the lead push itself died", async () => {
    seedAmo();
    const sub = seedSubscription("int_amo", "lead.created");
    db.seed("leadDelivery", { leadId: "l1", integrationId: "int_amo", kind: "new", status: "DEAD" });
    const payload = { ...sampleEvent("lead.created"), lead: { ...sampleEvent("lead.created").lead!, id: "l1" } };
    const d = seedDelivery({ integrationId: "int_amo", subscriptionId: sub.id as string, payload });
    stubFetch(() => ({ status: 200 }));
    expect((await processOutboundDelivery(d.id as string)).outcome).toBe("dead");
  });

  it("is SKIPPED when enrichment is switched off", async () => {
    const amo = seedAmo();
    (amo.config as Row).enrich = { enabled: false };
    const sub = seedSubscription("int_amo", "lead.created");
    const d = seedDelivery({ integrationId: "int_amo", subscriptionId: sub.id as string });
    stubFetch(() => ({ status: 200 }));
    expect((await processOutboundDelivery(d.id as string)).outcome).toBe("skipped");
    expect(delivery(d.id as string).status).toBe("SKIPPED");
  });
});

describe("Telegram HOT card", () => {
  function seedTelegram() {
    db.seed("integration", { id: "int_tg", workspaceId: "w1", type: "TELEGRAM", name: "Telegram" });
    db.seed("telegramChat", { integrationId: "int_tg", chatId: "-100", title: "Sotuv" });
  }

  it("sends the TZ 41.1 card for a HOT payload that passes the filter", async () => {
    seedTelegram();
    const sub = seedSubscription("int_tg", "lead.hot", { v: 1, temperatures: ["HOT"], include_test: true });
    const d = seedDelivery({ integrationId: "int_tg", subscriptionId: sub.id as string, type: "lead.hot" });
    expect((await processOutboundDelivery(d.id as string)).outcome).toBe("sent");
    const [chatId, text] = vi.mocked(sendWithRetry).mock.calls[0];
    expect(chatId).toBe("-100");
    expect(text).toContain("HOT LEAD");
    expect(text).toContain("Score: <b>72</b>");
    expect(delivery(d.id as string).externalId).toContain("-100");
  });

  it("skips a payload that is not HOT even if the filter let it through", async () => {
    seedTelegram();
    const sub = seedSubscription("int_tg", "lead.created", { v: 1, include_test: true });
    const cold = sampleEvent("lead.created");
    const d = seedDelivery({
      integrationId: "int_tg", subscriptionId: sub.id as string,
      payload: { ...cold, score: { ...cold.score!, temperature: "COLD", value: 5, band: "cold" } },
    });
    expect((await processOutboundDelivery(d.id as string)).outcome).toBe("skipped");
    expect(sendWithRetry).not.toHaveBeenCalled();
  });
});

describe("retention", () => {
  it("purges events (and their deliveries) older than 30 days", async () => {
    const hook = seedWebhook();
    const old = seedDelivery({ integrationId: hook.id as string });
    const fresh = seedDelivery({ integrationId: hook.id as string });
    const oldEvent = rows("outboundEvent").find((e) => e.id === old.eventId)!;
    oldEvent.createdAt = new Date(Date.now() - 31 * 24 * 3_600_000);
    expect(await purgeOldOutbound()).toBe(1);
    expect(rows("outboundEvent").map((e) => e.id)).toEqual([fresh.eventId]);
    expect(rows("outboundDelivery").map((x) => x.id)).toEqual([fresh.id]);
  });
});
