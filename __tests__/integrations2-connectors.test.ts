/**
 * ETAP 8 — connectors: the Google Sheets flow (token → header → append, the
 * share hint on 403, missing tab), the production guard (a bus-only
 * integration never gets a LeadDelivery) and checkIntegration dispatching
 * the new types to the connector registry.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.stubEnv("ENCRYPTION_KEY", "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef");

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
vi.mock("../lib/integrations2/queue", async (original) => ({
  ...(await original<typeof import("../lib/integrations2/queue")>()),
  enqueueOutboundDelivery: vi.fn(async () => {}),
}));
vi.mock("../lib/telegram/notify", () => ({
  alertWorkspace: vi.fn(async () => {}),
  sendWithRetry: vi.fn(async () => ({ message_id: 1 })),
  notifyWorkspaceChats: vi.fn(async () => 1),
}));

import type { Integration } from "../app/generated/prisma/client";
import { enqueueLeadDeliveries } from "../lib/leads/delivery";
import { checkIntegration } from "../lib/integrations/service";
import { sheetsConnector } from "../lib/integrations2/connectors/sheets";
import { SHEET_HEADERS } from "../lib/integrations2/connectors/sheets-rows";
import { setWebhookPolicyOptionsForTests, webhookConnector } from "../lib/integrations2/connectors/webhook";
import { sampleEvent } from "../lib/integrations2/events";
import { resetKvForTests } from "../lib/integrations2/kv";
import { verifySignature } from "../lib/integrations2/signing";
import { db, resetDb } from "./helpers/db-instance";
import { PUBLIC_RESOLVER, SECRET, SPREADSHEET_ID, fakeFetch, seedSheets, seedWebhook, seedWorkspace, type FakeReply, type FetchCall } from "./helpers/integrations2";

type Row = Record<string, unknown>;
const rows = (model: string) => db.rows(model) as Row[];

function stubFetch(handler: (call: FetchCall) => FakeReply | Promise<FakeReply>) {
  const fake = fakeFetch(handler);
  vi.stubGlobal("fetch", fake.impl);
  return fake;
}

const context = (integration: Row, payload = sampleEvent("lead.created")) => ({
  integration: integration as unknown as Integration,
  delivery: { id: "dl1", attempts: 0, createdAt: new Date() },
  event: { id: payload.id, type: payload.type, workspaceId: "w1" },
  payload,
  filter: { v: 1 as const },
});

beforeEach(() => {
  resetDb();
  resetKvForTests();
  vi.clearAllMocks();
  setWebhookPolicyOptionsForTests({ resolve: PUBLIC_RESOLVER, allowHosts: [], denyHosts: [] });
  seedWorkspace();
});

describe("webhook connector", () => {
  it("posts the frozen payload signed so verifySignature accepts it", async () => {
    const hook = seedWebhook();
    const fake = stubFetch(() => ({ status: 200, body: "ok" }));
    const payload = sampleEvent("lead.created");
    const result = await webhookConnector.send(context(hook, payload));
    expect(result).toMatchObject({ outcome: "sent", responseCode: 200 });
    const call = fake.calls[0];
    expect(call.method).toBe("POST");
    expect(JSON.parse(call.body)).toEqual(payload);
    expect(call.headers["x-socialauto-event"]).toBe("lead.created");
    expect(call.headers["content-type"]).toContain("application/json");
    expect(
      verifySignature({ secret: SECRET, timestamp: call.headers["x-socialauto-timestamp"], rawBody: call.body, header: call.headers["x-socialauto-signature"] })
    ).toEqual({ ok: true, usedPrevious: false });
    // a tampered body does not verify
    expect(
      verifySignature({ secret: SECRET, timestamp: call.headers["x-socialauto-timestamp"], rawBody: call.body + " ", header: call.headers["x-socialauto-signature"] }).ok
    ).toBe(false);
  });

  it("a network error is a retry, never a throw", async () => {
    const hook = seedWebhook();
    vi.stubGlobal("fetch", async () => {
      throw new Error("ECONNRESET");
    });
    const result = await webhookConnector.send(context(hook));
    expect(result.outcome).toBe("retry");
  });

  it("check() refuses a URL the policy forbids", async () => {
    const hook = seedWebhook({ url: "http://insecure.example.com/x" });
    const check = await webhookConnector.check(hook as unknown as Integration);
    expect(check.ok).toBe(false);
    expect(check.message).toContain("https");
  });
});

describe("Google Sheets connector", () => {
  function sheetsServer(options: { header?: unknown[][] | "missing" | 403; appendStatus?: number } = {}) {
    return stubFetch((call) => {
      if (call.url.includes("oauth2.googleapis.com")) return { status: 200, body: { access_token: "tok_1", expires_in: 3600 } };
      if (call.method === "GET") {
        if (options.header === 403) return { status: 403, body: { error: { status: "PERMISSION_DENIED", message: "caller lacks access" } } };
        if (options.header === "missing") return { status: 400, body: { error: { message: "Unable to parse range: 'SocialAuto'!1:1" } } };
        return { status: 200, body: { values: options.header ?? [] } };
      }
      if (call.url.includes(":batchUpdate")) return { status: 200, body: {} };
      if (call.method === "PUT") return { status: 200, body: {} };
      return { status: options.appendStatus ?? 200, body: { updates: { updatedRange: "SocialAuto!A2:T2" } } };
    });
  }

  it("token → header write → append, then only append (token and header check are cached)", async () => {
    const sheet = seedSheets();
    const fake = sheetsServer();
    const payload = sampleEvent("lead.created");

    const first = await sheetsConnector.send(context(sheet, payload));
    expect(first).toMatchObject({ outcome: "sent", externalId: "SocialAuto!A2:T2" });
    expect(fake.calls.map((c) => `${c.method} ${new URL(c.url).hostname}`)).toEqual([
      "POST oauth2.googleapis.com",
      "GET sheets.googleapis.com",
      "PUT sheets.googleapis.com",
      "POST sheets.googleapis.com",
    ]);
    const token = new URLSearchParams(fake.calls[0].body);
    expect(token.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    expect(token.get("assertion")!.split(".")).toHaveLength(3);
    expect(fake.calls[1].headers.authorization).toBe("Bearer tok_1");
    expect(JSON.parse(fake.calls[2].body).values[0]).toEqual([...SHEET_HEADERS]);
    expect(fake.calls[3].url).toContain(`${SPREADSHEET_ID}/values/`);
    expect(fake.calls[3].url).toContain(":append");
    const row = JSON.parse(fake.calls[3].body).values[0];
    expect(row).toHaveLength(SHEET_HEADERS.length);
    expect(row[SHEET_HEADERS.indexOf("phone")]).toBe("+998901234567");
    expect(row[SHEET_HEADERS.indexOf("event")]).toBe("lead.created");

    fake.calls.length = 0;
    await sheetsConnector.send(context(sheet, payload));
    expect(fake.calls.map((c) => c.method)).toEqual(["POST"]);
    expect(fake.calls[0].url).toContain(":append");
  });

  it("leaves a matching header row alone", async () => {
    const sheet = seedSheets();
    const fake = sheetsServer({ header: [[...SHEET_HEADERS]] });
    await sheetsConnector.send(context(sheet));
    expect(fake.calls.some((c) => c.method === "PUT")).toBe(false);
  });

  it("adds the missing tab, writes the headers, then appends", async () => {
    const sheet = seedSheets();
    const fake = sheetsServer({ header: "missing" });
    const result = await sheetsConnector.send(context(sheet));
    expect(result.outcome).toBe("sent");
    const steps = fake.calls.slice(1).map((c) => (c.url.includes(":batchUpdate") ? "addSheet" : c.method === "PUT" ? "headers" : c.method === "GET" ? "read" : "append"));
    expect(steps).toEqual(["read", "addSheet", "headers", "append"]);
    expect(JSON.parse(fake.calls[2].body).requests[0].addSheet.properties.title).toBe("SocialAuto");
  });

  it("403 tells the owner to share the sheet with the service account", async () => {
    const sheet = seedSheets();
    sheetsServer({ header: 403 });
    const result = await sheetsConnector.send(context(sheet));
    expect(result.outcome).toBe("auth");
    expect(result).toMatchObject({ note: expect.stringContaining("bot@proj.iam.gserviceaccount.com") });
    expect((result as { note: string }).note).toContain("Share");
  });

  it("refuses to overwrite a tab whose first row holds other data", async () => {
    const sheet = seedSheets();
    const fake = sheetsServer({ header: [["Ism", "Telefon"]] });
    const result = await sheetsConnector.send(context(sheet));
    expect(result.outcome).toBe("auth");
    expect(fake.calls.some((c) => c.method === "PUT" || c.url.includes(":append"))).toBe(false);
  });

  it("429 and 5xx on append are retried", async () => {
    const sheet = seedSheets();
    sheetsServer({ header: [[...SHEET_HEADERS]], appendStatus: 503 });
    expect((await sheetsConnector.send(context(sheet))).outcome).toBe("retry");
  });

  it("check() reports a rejected key as auth", async () => {
    const sheet = seedSheets();
    stubFetch(() => ({ status: 400, body: { error: "invalid_grant" } }));
    const check = await sheetsConnector.check(sheet as unknown as Integration);
    expect(check).toMatchObject({ ok: false, reason: "auth" });
  });
});

describe("production guard: bus-only integrations never get a LeadDelivery", () => {
  it("enqueueLeadDeliveries only serves TELEGRAM / AMOCRM / BITRIX24", async () => {
    db.seed("lead", { id: "l1", workspaceId: "w1", instagramAccountId: "w1_a1", idempotencyKey: "k", igUserId: "u" });
    const types = ["TELEGRAM", "AMOCRM", "BITRIX24", "WEBHOOK", "GOOGLE_SHEETS", "MAKE", "ZAPIER"] as const;
    for (const type of types) db.seed("integration", { id: `int_${type}`, workspaceId: "w1", type, name: type });

    await enqueueLeadDeliveries({ id: "l1", workspaceId: "w1", instagramAccountId: "w1_a1" }, "new");

    expect(rows("leadDelivery").map((d) => d.integrationId).sort()).toEqual(["int_AMOCRM", "int_BITRIX24", "int_TELEGRAM"]);
  });
});

describe("checkIntegration dispatch", () => {
  it("sends bus-only types to their connector instead of the Telegram branch", async () => {
    const hook = seedWebhook();
    expect(await checkIntegration(hook as unknown as Integration)).toEqual({ ok: true });
    const bad = seedWebhook({ id: "int_bad", url: "https://localhost/x" });
    const result = await checkIntegration(bad as unknown as Integration);
    expect(result.ok).toBe(false);
    expect(result.message).not.toBe("no_active_chats");
  });

  it("keeps the Telegram check for TELEGRAM", async () => {
    const tg = db.seed("integration", { id: "int_tg", workspaceId: "w1", type: "TELEGRAM", name: "Telegram" });
    expect(await checkIntegration(tg as unknown as Integration)).toMatchObject({ ok: false, message: "no_active_chats" });
  });
});
