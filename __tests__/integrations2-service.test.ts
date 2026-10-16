/**
 * ETAP 8 — the developer API's rules: secrets shown once and masked ever
 * after, foreign ids 404, Uzbek 400 / 422 messages, the permission mapping
 * of the guard, the test button going through the real pipeline.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");

const mocks = vi.hoisted(() => ({
  developerSession: vi.fn(),
  workspaceContext: vi.fn(),
}));

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
  sendWithRetry: vi.fn(async () => ({ message_id: 1 })),
  notifyWorkspaceChats: vi.fn(async () => 1),
}));
vi.mock("@/lib/developer/auth", () => ({ getDeveloperSession: mocks.developerSession }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mocks.workspaceContext,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
  canManageBilling: (role: string) => role === "OWNER",
  hasWorkspaceRole: () => true,
}));

import { requireIntegrations } from "../lib/developer/integrations-guard";
import { setWebhookPolicyOptionsForTests } from "../lib/integrations2/connectors/webhook";
import { resetKvForTests } from "../lib/integrations2/kv";
import {
  checkConnection,
  createSheetsIntegration,
  createWebhookIntegration,
  deleteIntegration,
  emitTestEvent,
  getDelivery,
  getMeta,
  listDeliveries,
  listEvents,
  listIntegrations,
  patchEnrichment,
  patchIntegration,
  previewEventPayload,
  putSubscriptions,
  redeliverDead,
  redeliverOne,
  rotateSecret,
  setServicePolicyOptionsForTests,
  testIntegration,
} from "../lib/integrations2/service";
import { verifySignature } from "../lib/integrations2/signing";
import { db, resetDb } from "./helpers/db-instance";
import {
  HOOK_URL,
  PUBLIC_RESOLVER,
  SPREADSHEET_ID,
  fakeFetch,
  seedDelivery,
  seedLead,
  seedSubscription,
  seedWebhook,
  seedWorkspace,
  serviceAccountJson,
  type FakeReply,
  type FetchCall,
} from "./helpers/integrations2";

type Row = Record<string, unknown>;
const rows = (model: string) => db.rows(model) as Row[];
const WS = "w1";

function stubFetch(handler: (call: FetchCall) => FakeReply | Promise<FakeReply>) {
  const fake = fakeFetch(handler);
  vi.stubGlobal("fetch", fake.impl);
  return fake;
}

function expectFail<T>(result: { ok: boolean } & Partial<{ status: number; error: string; data: T }>, status: number) {
  expect(result.ok).toBe(false);
  expect(result.status).toBe(status);
  expect(typeof result.error).toBe("string");
}

function data<T>(result: { ok: boolean; data?: T }): T {
  expect(result.ok).toBe(true);
  return result.data as T;
}

const webhookBody = { name: "CRM serverim", url: HOOK_URL, events: ["lead.created"] };

beforeEach(() => {
  resetDb();
  resetKvForTests();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");
  setWebhookPolicyOptionsForTests({ resolve: PUBLIC_RESOLVER, allowHosts: [], denyHosts: [] });
  setServicePolicyOptionsForTests({ resolve: PUBLIC_RESOLVER, allowHosts: [], denyHosts: [] });
  seedWorkspace(WS);
  seedWorkspace("w2");
});

describe("webhook creation", () => {
  it("returns the secret once; every later read only has a masked hint", async () => {
    const created = data(await createWebhookIntegration(WS, webhookBody));
    expect(created.secret).toMatch(/^whsec_[A-Za-z0-9_-]{43}$/);
    expect(created.integration.secretHint).toBe(`••••${created.secret.slice(-4)}`);
    expect(JSON.stringify(created.integration)).not.toContain(created.secret);

    const list = await listIntegrations(WS);
    expect(list.integrations).toHaveLength(1);
    expect(JSON.stringify(list)).not.toContain(created.secret);
    expect(JSON.stringify(list)).not.toContain("credentialsEncrypted");
    expect(list.integrations[0].subscriptions).toMatchObject([{ eventType: "lead.created", active: true }]);
    // stored encrypted, not as plain text
    expect(String(rows("integration")[0].credentialsEncrypted)).not.toContain(created.secret);
  });

  it("MAKE and ZAPIER are their own types with the same code", async () => {
    const make = data(await createWebhookIntegration(WS, { ...webhookBody, url: "https://hook.eu1.make.com/abcdefghijk", preset: "MAKE" }));
    expect(make.integration.type).toBe("MAKE");
    const zap = data(await createWebhookIntegration(WS, { ...webhookBody, url: "https://hooks.zapier.com/hooks/catch/1/abc/", preset: "ZAPIER" }));
    expect(zap.integration.type).toBe("ZAPIER");
    // a Zapier dashboard link is saved but flagged
    const wrong = data(await createWebhookIntegration(WS, { ...webhookBody, name: "x", url: "https://zapier.com/app/zaps", preset: "ZAPIER" }));
    expect(wrong.hint).toContain("Catch Hook");
  });

  it.each([
    ["http://example.com/x", "https://"],
    ["https://localhost/x", "Ichki"],
    ["https://user:pw@example.com/x", "login"],
    ["not a url", "URL"],
  ])("refuses %s with an Uzbek 422", async (url, fragment) => {
    const result = await createWebhookIntegration(WS, { ...webhookBody, url });
    expectFail(result, 422);
    expect((result as { error: string }).error).toContain(fragment);
    expect(rows("integration")).toHaveLength(0);
  });

  it("refuses an address that resolves to a private IP", async () => {
    setServicePolicyOptionsForTests({ resolve: async () => ["192.168.1.5"], allowHosts: [], denyHosts: [] });
    expectFail(await createWebhookIntegration(WS, webhookBody), 422);
  });

  it("400 on a bad body (zod), first issue in Uzbek", async () => {
    expectFail(await createWebhookIntegration(WS, { url: HOOK_URL, events: ["lead.created"] }), 400);
    expectFail(await createWebhookIntegration(WS, { ...webhookBody, events: [] }), 400);
    expectFail(await createWebhookIntegration(WS, { ...webhookBody, events: ["nope.event"] }), 400);
    expectFail(await createWebhookIntegration(WS, { ...webhookBody, rateLimitPerMinute: 0 }), 400);
    expectFail(await createWebhookIntegration(WS, { ...webhookBody, filter: { v: 1, min_score: 500 } }), 400);
  });

  it("accepts a filter without the version marker", async () => {
    const created = data(await createWebhookIntegration(WS, { ...webhookBody, filter: { temperatures: ["HOT"], min_score: 60 } }));
    expect(created.integration.subscriptions[0].filter).toEqual({ v: 1, temperatures: ["HOT"], min_score: 60 });
  });

  it("a foreign Instagram account in the filter is a 404", async () => {
    expectFail(await createWebhookIntegration(WS, { ...webhookBody, igAccountFilter: ["w2_a1"] }), 404);
  });
});

describe("Google Sheets creation", () => {
  const body = { name: "Jadval", serviceAccountJson: serviceAccountJson(), spreadsheet: `https://docs.google.com/spreadsheets/d/${SPREADSHEET_ID}/edit#gid=0`, events: ["lead.created"] };

  it("stores the key encrypted, returns only the client_email", async () => {
    const created = data(await createSheetsIntegration(WS, body));
    expect(created.clientEmail).toBe("bot@proj.iam.gserviceaccount.com");
    expect(created.integration.config).toMatchObject({ spreadsheetId: SPREADSHEET_ID, sheetName: "SocialAuto", clientEmail: created.clientEmail });
    expect(JSON.stringify(created)).not.toContain("PRIVATE KEY");
    expect(String(rows("integration")[0].credentialsEncrypted)).not.toContain("PRIVATE KEY");
  });

  it("422 for a file that is not a service account key, a bad sheet id and a duplicate", async () => {
    expectFail(await createSheetsIntegration(WS, { ...body, serviceAccountJson: JSON.stringify({ type: "authorized_user", client_id: "x" }) }), 422);
    expectFail(await createSheetsIntegration(WS, { ...body, serviceAccountJson: "{ this is definitely not json ........" }), 422);
    expectFail(await createSheetsIntegration(WS, { ...body, spreadsheet: "https://example.com/nothing" }), 422);
    data(await createSheetsIntegration(WS, body));
    const dup = await createSheetsIntegration(WS, { ...body, name: "Yana" });
    expectFail(dup, 422);
    expect((dup as { error: string }).error).toContain("allaqachon");
  });
});

describe("tenant isolation (foreign ids are 404)", () => {
  it("every id-taking function refuses another workspace's integration and delivery", async () => {
    const theirs = seedWebhook({ id: "int_theirs", workspaceId: "w2" });
    seedSubscription(theirs.id as string);
    const delivery = seedDelivery({ integrationId: theirs.id as string, workspaceId: "w2" });

    expectFail(await patchIntegration(WS, "int_theirs", { name: "x" }), 404);
    expectFail(await deleteIntegration(WS, "int_theirs"), 404);
    expectFail(await rotateSecret(WS, "int_theirs"), 404);
    expectFail(await testIntegration(WS, "int_theirs", {}), 404);
    expectFail(await putSubscriptions(WS, "int_theirs", { subscriptions: [] }), 404);
    expectFail(await checkConnection(WS, "int_theirs"), 404);
    expectFail(await patchEnrichment(WS, "int_theirs", { enabled: true }), 404);
    expectFail(await getDelivery(WS, delivery.id as string, true), 404);
    expectFail(await redeliverOne(WS, delivery.id as string), 404);
    expectFail(await listDeliveries(WS, { integrationId: "int_theirs" }), 404);
    expectFail(await redeliverDead(WS, { integrationId: "int_theirs" }), 404);
    expect(rows("integration")).toHaveLength(1);

    expect((await listIntegrations(WS)).integrations).toHaveLength(0);
    expect(data(await listDeliveries(WS, {})).deliveries).toHaveLength(0);
  });
});

describe("editing", () => {
  it("PATCH renames, re-validates the URL, toggles and releases held deliveries", async () => {
    const hook = seedWebhook({ status: "BROKEN" });
    const delivery = seedDelivery({ integrationId: hook.id as string, nextAttemptAt: null });
    expectFail(await patchIntegration(WS, hook.id as string, { url: "http://insecure.example.com" }), 422);
    expectFail(await patchIntegration(WS, hook.id as string, { surprise: true }), 400);
    expectFail(await patchIntegration(WS, hook.id as string, { sheetName: "x" }), 422);

    const view = data(await patchIntegration(WS, hook.id as string, { name: "Yangi nom", rateLimitPerMinute: 10, status: "ACTIVE" }));
    expect(view).toMatchObject({ name: "Yangi nom", status: "ACTIVE" });
    expect(view.config).toMatchObject({ rateLimitPerMinute: 10 });
    expect(rows("outboundDelivery").find((d) => d.id === delivery.id)!.nextAttemptAt).toBeInstanceOf(Date);
  });

  it("legacy integrations are not editable or deletable here (422)", async () => {
    const tg = db.seed("integration", { id: "int_tg", workspaceId: WS, type: "TELEGRAM", name: "Telegram" });
    expectFail(await patchIntegration(WS, tg.id as string, { name: "x" }), 422);
    expectFail(await deleteIntegration(WS, tg.id as string), 422);
    expectFail(await rotateSecret(WS, tg.id as string), 422);
  });

  it("DELETE removes the integration with its subscriptions and deliveries", async () => {
    const hook = seedWebhook();
    seedSubscription(hook.id as string);
    seedDelivery({ integrationId: hook.id as string });
    expect(data(await deleteIntegration(WS, hook.id as string))).toEqual({ deleted: true });
    expect(rows("integration")).toHaveLength(0);
    expect(rows("integrationSubscription")).toHaveLength(0);
    expect(rows("outboundDelivery")).toHaveLength(0);
  });

  it("rotate-secret returns a new secret once and keeps the old one signing for 24h", async () => {
    const created = data(await createWebhookIntegration(WS, webhookBody));
    const id = created.integration.id;
    const rotated = data(await rotateSecret(WS, id));
    expect(rotated.secret).toMatch(/^whsec_/);
    expect(rotated.secret).not.toBe(created.secret);
    const hours = (rotated.previousSecretExpiresAt.getTime() - Date.now()) / 3_600_000;
    expect(hours).toBeGreaterThan(23.9);
    expect(hours).toBeLessThanOrEqual(24);

    const view = (await listIntegrations(WS)).integrations[0];
    expect(view.previousSecretExpiresAt).toBeTruthy();
    expect(JSON.stringify(view)).not.toContain(rotated.secret);

    // both signatures reach the receiver
    const fake = stubFetch(() => ({ status: 200 }));
    const delivery = seedDelivery({ integrationId: id });
    const { processOutboundDelivery } = await import("../lib/integrations2/deliver");
    await processOutboundDelivery(delivery.id as string);
    const header = fake.calls[0].headers["x-socialauto-signature"];
    const base = { timestamp: fake.calls[0].headers["x-socialauto-timestamp"], rawBody: fake.calls[0].body, header };
    expect(verifySignature({ ...base, secret: rotated.secret }).ok).toBe(true);
    expect(verifySignature({ ...base, secret: "nope", previousSecret: created.secret })).toEqual({ ok: true, usedPrevious: true });
  });
});

describe("subscriptions and enrichment", () => {
  it("PUT replaces the set; unsupported events for a connector are 422", async () => {
    const created = data(await createWebhookIntegration(WS, { ...webhookBody, events: ["lead.created", "lead.hot"] }));
    const id = created.integration.id;
    const view = data(
      await putSubscriptions(WS, id, { subscriptions: [{ eventType: "lead.hot", filter: { temperatures: ["HOT"] } }, { eventType: "handoff.opened" }] })
    );
    expect(view.subscriptions.map((s) => s.eventType).sort()).toEqual(["handoff.opened", "lead.hot"]);
    expectFail(await putSubscriptions(WS, id, { subscriptions: [{ eventType: "lead.hot" }, { eventType: "lead.hot" }] }), 400);

    const tg = db.seed("integration", { id: "int_tg", workspaceId: WS, type: "TELEGRAM", name: "Telegram" });
    expectFail(await putSubscriptions(WS, tg.id as string, { subscriptions: [{ eventType: "broadcast.completed" }] }), 422);
    data(await putSubscriptions(WS, tg.id as string, { subscriptions: [{ eventType: "lead.hot", filter: { temperatures: ["HOT"] } }] }));
  });

  it("enrichment on an amoCRM integration creates the CRM subscriptions and validates the field type", async () => {
    const amo = db.seed("integration", { id: "int_amo", workspaceId: WS, type: "AMOCRM", name: "amoCRM", config: { subdomain: "demo", zone: "amocrm.ru" } });
    expectFail(await patchEnrichment(WS, amo.id as string, { enabled: true, scoreFieldId: "UF_CRM_X" }), 422);
    const view = data(await patchEnrichment(WS, amo.id as string, { enabled: true, scoreFieldId: 123, stageMap: { Yutildi: 142 } }));
    expect(view.enrichment).toMatchObject({ enabled: true, scoreFieldId: 123, stageMap: { Yutildi: 142 } });
    expect(rows("integrationSubscription").map((s) => s.eventType).sort()).toEqual(["deal.stage_changed", "lead.created", "lead.hot"]);

    const off = data(await patchEnrichment(WS, amo.id as string, { enabled: false }));
    expect(off.enrichment?.enabled).toBe(false);
    expect(rows("integrationSubscription").every((s) => s.active === false)).toBe(true);

    const hook = seedWebhook();
    expectFail(await patchEnrichment(WS, hook.id as string, { enabled: true }), 422);
  });
});

describe("test button and test events", () => {
  it("sends a synthetic is_test event through the real pipeline and returns the delivery", async () => {
    const created = data(await createWebhookIntegration(WS, webhookBody));
    const fake = stubFetch(() => ({ status: 200, body: "ok" }));
    const result = data(await testIntegration(WS, created.integration.id, {}));
    expect(result.delivery).toMatchObject({ status: "SENT", responseCode: 200, eventType: "lead.created", isTest: true });
    expect(fake.calls).toHaveLength(1);
    expect(JSON.parse(fake.calls[0].body)).toMatchObject({ is_test: true, type: "lead.created", workspace: { id: WS } });
    expect(JSON.parse(fake.calls[0].body).account.id).toBe("w1_a1");
    expect(rows("outboundEvent")[0]).toMatchObject({ isTest: true, subjectType: "test" });
  });

  it("reports a failing receiver in the returned delivery", async () => {
    const created = data(await createWebhookIntegration(WS, webhookBody));
    stubFetch(() => ({ status: 500, body: "oops" }));
    const result = data(await testIntegration(WS, created.integration.id, {}));
    expect(result.delivery).toMatchObject({ status: "FAILED", responseCode: 500, attempts: 1 });
  });

  it("422 when the integration is not active, the bus is off, or the CRM has no synthetic test", async () => {
    const created = data(await createWebhookIntegration(WS, webhookBody));
    await patchIntegration(WS, created.integration.id, { status: "DISABLED" });
    expectFail(await testIntegration(WS, created.integration.id, {}), 422);
    await patchIntegration(WS, created.integration.id, { status: "ACTIVE" });
    const amo = db.seed("integration", { id: "int_amo", workspaceId: WS, type: "AMOCRM", name: "amoCRM" });
    expectFail(await testIntegration(WS, amo.id as string, {}), 422);
    vi.stubEnv("INTEGRATIONS_BUS_DISABLED", "1");
    expectFail(await testIntegration(WS, created.integration.id, {}), 422);
    expectFail(await emitTestEvent(WS, { type: "lead.created" }), 422);
  });

  it("emit-test reaches only subscriptions that accept test events", async () => {
    const plain = data(await createWebhookIntegration(WS, webhookBody));
    data(await createWebhookIntegration(WS, { ...webhookBody, name: "Test bilan", filter: { include_test: true } }));
    const result = data(await emitTestEvent(WS, { type: "lead.created" }));
    expect(result).toMatchObject({ matched: 1, deliveries: 1 });
    expect(rows("outboundDelivery").every((d) => d.integrationId !== plain.integration.id)).toBe(true);
    expectFail(await emitTestEvent(WS, { type: "nope" }), 400);
  });
});

describe("events, preview, deliveries", () => {
  it("the catalogue has a sample per event type", async () => {
    const events = await listEvents(WS);
    expect(events.catalogue.map((e) => e.type)).toHaveLength(7);
    for (const e of events.catalogue) expect(JSON.parse(e.sample).type).toBe(e.type);
  });

  it("payload-preview: sample without a lead, the real payload with one, foreign lead 404", async () => {
    expect(data(await previewEventPayload(WS, { type: "lead.hot" })).source).toBe("sample");
    seedLead({ temperature: "HOT" });
    const real = data(await previewEventPayload(WS, { type: "lead.created", leadId: "l1" }));
    expect(real.source).toBe("lead");
    expect(real.payload).toMatchObject({ id: "evt_preview", lead: { name: "Aziz", phone: "+998901234567" }, score: { temperature: "HOT" } });
    seedLead({ id: "lx", workspaceId: "w2" });
    expectFail(await previewEventPayload(WS, { type: "lead.created", leadId: "lx" }), 404);
    expectFail(await previewEventPayload(WS, { type: "broadcast.completed", leadId: "l1" }), 422);
    expectFail(await previewEventPayload(WS, { type: "bogus" }), 400);
  });

  it("lists deliveries with filters and pages without gaps or repeats", async () => {
    const hook = seedWebhook();
    const ids: string[] = [];
    for (let i = 0; i < 5; i++) ids.push(seedDelivery({ integrationId: hook.id as string, status: i % 2 ? "DEAD" : "SENT" }).id as string);

    const first = data(await listDeliveries(WS, { limit: "2" }));
    expect(first.deliveries).toHaveLength(2);
    expect(first.nextCursor).toBeTruthy();
    const second = data(await listDeliveries(WS, { limit: "2", cursor: first.nextCursor! }));
    const third = data(await listDeliveries(WS, { limit: "2", cursor: second.nextCursor! }));
    const seen = [...first.deliveries, ...second.deliveries, ...third.deliveries].map((d) => d.id);
    expect(new Set(seen).size).toBe(5);
    expect(third.nextCursor).toBeNull();

    expect(data(await listDeliveries(WS, { status: "DEAD" })).deliveries).toHaveLength(2);
    expect(data(await listDeliveries(WS, { type: "lead.hot" })).deliveries).toHaveLength(0);
    expectFail(await listDeliveries(WS, { status: "WEIRD" }), 400);
  });

  it("the payload is only included for manage roles", async () => {
    const hook = seedWebhook();
    const d = seedDelivery({ integrationId: hook.id as string });
    const shown = data(await getDelivery(WS, d.id as string, true));
    expect(shown.payloadHidden).toBe(false);
    expect((shown.payload as Row).type).toBe("lead.created");
    const hidden = data(await getDelivery(WS, d.id as string, false));
    expect(hidden).toMatchObject({ payload: null, payloadHidden: true });
  });

  it("redeliver / redeliver-dead queue DEAD deliveries; an inactive integration is a 422", async () => {
    const hook = seedWebhook();
    const dead = seedDelivery({ integrationId: hook.id as string, status: "DEAD", attempts: 6 });
    expect(data(await redeliverOne(WS, dead.id as string))).toEqual({ queued: true });
    expect(rows("outboundDelivery")[0]).toMatchObject({ status: "PENDING", attempts: 0 });

    const dead2 = seedDelivery({ integrationId: hook.id as string, status: "DEAD" });
    expect(data(await redeliverDead(WS, {}))).toEqual({ queued: 1 });
    expect(rows("outboundDelivery").find((d) => d.id === dead2.id)!.status).toBe("PENDING");

    hook.status = "DISABLED";
    expectFail(await redeliverOne(WS, dead.id as string), 422);
  });

  it("meta exposes the catalogue, limits and this workspace's accounts only", async () => {
    const meta = await getMeta(WS);
    expect(meta.events).toHaveLength(7);
    expect(meta.limits).toMatchObject({ maxAttempts: 6, deadAutoDisable: 5, retentionDays: 30 });
    expect(meta.accounts.map((a) => a.id)).toEqual(["w1_a1"]);
    expect(meta.connectorTypes.map((c) => c.type)).toEqual(["WEBHOOK", "GOOGLE_SHEETS", "MAKE", "ZAPIER"]);
  });
});

describe("permission mapping", () => {
  const ctx = (role: string) => ({ userId: "u1", workspaceId: WS, workspace: { id: WS }, role });

  async function status(access: "read" | "payload" | "write", role: string) {
    mocks.developerSession.mockResolvedValue({ ok: true });
    mocks.workspaceContext.mockResolvedValue(ctx(role));
    const auth = await requireIntegrations(access);
    return auth.ok ? 200 : auth.response.status;
  }

  it("is a plain 404 without a developer session and 401 without a workspace", async () => {
    mocks.developerSession.mockResolvedValue(null);
    expect((await requireIntegrations("read") as { response: Response }).response.status).toBe(404);
    mocks.developerSession.mockResolvedValue({ ok: true });
    mocks.workspaceContext.mockResolvedValue(null);
    expect((await requireIntegrations("read") as { response: Response }).response.status).toBe(401);
  });

  it.each([
    ["OWNER", 200, 200, 200],
    ["ADMIN", 200, 200, 200],
    ["MANAGER", 200, 200, 200],
    ["OPERATOR", 200, 403, 403],
    ["MEMBER", 200, 403, 403],
    ["VIEWER", 200, 403, 403],
  ])("%s: read %i, payload %i, write %i", async (role, read, payload, write) => {
    expect(await status("read", role)).toBe(read);
    expect(await status("payload", role)).toBe(payload);
    expect(await status("write", role)).toBe(write);
  });
});
