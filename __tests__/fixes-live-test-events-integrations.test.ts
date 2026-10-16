/**
 * Live-test fixes: B-28 (every webhook event logged), B-04/B-32 (CRM auth
 * error, one undelivered count), B-23 (queue depths admin-only), B-27
 * (Telegram not connected), B-34 (legacy automations listed read-only).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/triggers/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/triggers/queue")>()),
  enqueueEvent: vi.fn().mockResolvedValue(undefined),
}));

import { forgetAccountGate, ingestWebhookPayload } from "@/lib/triggers/ingest";
import { explainError } from "@/lib/foundation/error-catalog";
import { IntegrationAuthError } from "@/lib/integrations/errors";
import { summarizeDeliveries, type DeliveryRow } from "@/lib/leads/undelivered";
import { redactKpiForViewer } from "@/lib/analytics/kpi-access";
import { buildTelegramCheck } from "@/lib/foundation/diagnostics";
import { listLegacyAutomations } from "@/lib/triggers/comment-service";

const IG = "17841400000000001";

function payload(entry: Record<string, unknown>) {
  return { object: "instagram", entry: [{ id: IG, time: 1760000000000, ...entry }] };
}

beforeEach(() => {
  resetDb();
  forgetAccountGate();
  vi.unstubAllEnvs();
  db.seed("workspace", { id: "ws1", name: "T" });
  db.seed("instagramAccount", { id: "acc1", workspaceId: "ws1", instagramId: IG, username: "shop", accessToken: "x" });
});

describe("B-28: every webhook item is logged, IGNORED when no automation answers", () => {
  const items: Array<[string, Record<string, unknown>]> = [
    ["DIRECT_MESSAGE", { messaging: [{ sender: { id: "u1" }, timestamp: 1760000001000, message: { mid: "m1", text: "salom" } }] }],
    ["ECHO", { messaging: [{ sender: { id: IG }, recipient: { id: "u1" }, timestamp: 1760000001000, message: { mid: "m2", is_echo: true, text: "javob" } }] }],
    ["POSTBACK", { messaging: [{ sender: { id: "u1" }, timestamp: 1760000001000, postback: { mid: "m3", payload: "reveal:a1", title: "Ok" } }] }],
    ["STORY_REPLY", { messaging: [{ sender: { id: "u1" }, timestamp: 1760000001000, message: { mid: "m4", text: "x", reply_to: { story: { id: "s1" } } } }] }],
    ["COMMENT", { changes: [{ field: "comments", value: { id: "c1", text: "narx", from: { id: "u1" }, media: { id: "p1" } } }] }],
    ["OTHER", { changes: [{ field: "mentions", value: { media_id: "p9" } }] }],
  ];

  it.each(items)("%s on an account without automations is stored as IGNORED, never claimed", async (type, entry) => {
    const result = await ingestWebhookPayload(payload(entry));
    expect(result).toMatchObject({ stored: [], logged: 1 });
    const rows = db.rows("instagramEvent");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ eventType: type, processingStatus: "IGNORED", claimedCampaignId: null });
    expect(String(rows[0].error)).toContain("Avtomatika yo'q");
    expect(result.claimed.size).toBe(0);
  });

  it("a redelivery is not logged twice", async () => {
    await ingestWebhookPayload(payload(items[0][1]));
    const again = await ingestWebhookPayload(payload(items[0][1]));
    expect(again.duplicates).toBe(1);
    expect(db.rows("instagramEvent")).toHaveLength(1);
  });

  it("the kill switch still stops everything", async () => {
    vi.stubEnv("TRIGGER_ENGINE_DISABLED", "1");
    await ingestWebhookPayload(payload(items[0][1]));
    expect(db.rows("instagramEvent")).toHaveLength(0);
  });

  it("an echo on an engaged account is logged but never queued or claimed", async () => {
    db.seed("triggerCampaign", { id: "c", workspaceId: "ws1", instagramAccountId: "acc1", kind: "CAMPAIGN", triggerType: "STORY_REPLY", active: true });
    const result = await ingestWebhookPayload(payload(items[1][1]));
    expect(result.stored).toEqual([]);
    expect(db.rows("instagramEvent")[0]).toMatchObject({ eventType: "ECHO", processingStatus: "IGNORED" });
  });
});

describe("B-04: CRM 401/403 is a typed INTEGRATION_AUTH_EXPIRED error", () => {
  it("maps IntegrationAuthError and stored strings, with a reconnect action", () => {
    const inputs = [new IntegrationAuthError("amocrm", "amoCRM responded 401"), "amoCRM responded 403", "amoCRM integratsiyasi uzildi: amoCRM responded 401"];
    for (const input of inputs) {
      const e = explainError(input);
      expect(e.code).toBe("INTEGRATION_AUTH_EXPIRED");
      expect(e.action).toMatchObject({ kind: "reconnect", label: "Qayta ulash", href: "/integrations" });
      expect(e.problem).toBeTruthy();
      expect(e.cause).toBeTruthy();
      expect(e.solution).toBeTruthy();
    }
  });
});

describe("B-32: one undelivered count", () => {
  const row = (over: Partial<DeliveryRow>): DeliveryRow => ({
    id: "d",
    leadId: "l1",
    integrationId: "i1",
    status: "PENDING",
    attempts: 0,
    lastError: null,
    updatedAt: new Date(),
    integration: { name: "amoCRM", type: "AMOCRM", status: "ACTIVE" },
    lead: { name: null, phoneE164: null },
    ...over,
  });

  it("a lead waiting on a broken CRM counts once and shows in the waiting badge", () => {
    const s = summarizeDeliveries([
      row({ id: "a", integration: { name: "amoCRM", type: "AMOCRM", status: "BROKEN" } }),
      row({ id: "b", status: "SENT" }),
      row({ id: "c", leadId: "l2", status: "PENDING" }),
    ]);
    expect(s.undeliveredLeads).toBe(1);
    expect(s.held).toBe(1);
    expect(s.waitingByIntegration.get("i1")).toBe(2);
    expect(s.rows.map((r) => r.id).sort()).toEqual(["a", "c"]);
  });

  it("dead + held on the same lead is one lead", () => {
    const s = summarizeDeliveries([
      row({ id: "a", status: "DEAD" }),
      row({ id: "b", integrationId: "i2", integration: { name: "x", type: "BITRIX24", status: "BROKEN" } }),
    ]);
    expect(s.undeliveredLeads).toBe(1);
  });
});

describe("B-23: platform queue depths are admin-only", () => {
  const kpi = { queueDepths: [{ queue: "q" }] as never, failed: ["queueDepths", "worker"] };
  it("hides them from tenants", () => {
    const r = redactKpiForViewer(kpi, false);
    expect(r.queueDepths).toBeNull();
    expect(r.queueDepthsRestricted).toBe(true);
    expect(r.failed).toEqual(["worker"]);
  });
  it("keeps them for platform admins", () => {
    expect(redactKpiForViewer(kpi, true).queueDepths).toHaveLength(1);
  });
});

describe("B-27: Telegram not connected", () => {
  it("a linked user without an active chat still warns", () => {
    const item = buildTelegramCheck({ botConfigured: true, linkedUsers: 1, activeChats: 0 }, new Date());
    expect(item.status).toBe("warning");
    expect(item.issue).toContain("ogohlantirishlar yetib bormaydi");
    expect(item.action?.href).toBe("/integrations");
  });
});

describe("B-34: legacy automations are listed read-only", () => {
  it("shows the production campaign with its DmLog counts, scoped to the workspace", async () => {
    db.seed("automation", { id: "au1", workspaceId: "ws1", instagramAccountId: "acc1", name: "Salom", isActive: true, keywords: ["salom"], matchAnyWord: false, postId: null, matchAnyPost: true });
    db.seed("automation", { id: "au2", workspaceId: "other", instagramAccountId: "acc9", name: "Boshqa", isActive: true, keywords: [] });
    db.seed("dmLog", { id: "l1", workspaceId: "ws1", automationId: "au1", status: "SENT" });
    db.seed("dmLog", { id: "l2", workspaceId: "ws1", automationId: "au1", status: "SKIPPED_DEDUP" });
    const rows = await listLegacyAutomations("ws1");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: "Salom", source: "production_legacy", stats: { total: 2, sent: 1, skipped: 1, failed: 0 } });
  });
});
