/**
 * Scenario A (end to end, in-memory database): keyword comment "narx" ->
 * comment campaign matches -> private reply (with the opening button) ->
 * button tap -> main message -> lead -> CRM contact with the lead -> the
 * DM / lead numbers on the Panel, dev Analytics and Diagnostics agree.
 * Re-running the CRM sync / backfill never duplicates the contact.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  sendPrivateReplyWithButton: vi.fn(),
  sendCommentReply: vi.fn(),
  sendDirectMessage: vi.fn(),
  sendDirectMessageWithQuickReplies: vi.fn(),
  getMessagingProfile: vi.fn(),
  markTokenBroken: vi.fn(),
  reserveWorkspaceDMSend: vi.fn(),
  releaseWorkspaceDMReservation: vi.fn(),
  reserveDMSlot: vi.fn(),
  enqueueEvent: vi.fn(),
  alertWorkspace: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  sendPrivateReplyWithButton: mocks.sendPrivateReplyWithButton,
  sendCommentReply: mocks.sendCommentReply,
  sendDirectMessage: mocks.sendDirectMessage,
  sendDirectMessageWithQuickReplies: mocks.sendDirectMessageWithQuickReplies,
  getMessagingProfile: mocks.getMessagingProfile,
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (value: string) => `plain:${value}` }));
vi.mock("@/lib/meta/token-health", () => ({ markTokenBroken: mocks.markTokenBroken }));
vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mocks.reserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mocks.releaseWorkspaceDMReservation,
}));
vi.mock("@/lib/utils/rate-limiter", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/utils/rate-limiter")>()),
  reserveDMSlot: mocks.reserveDMSlot,
}));
vi.mock("@/lib/telegram/notify", () => ({ notifyWorkspaceChats: vi.fn(async () => 1), alertWorkspace: mocks.alertWorkspace }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/triggers/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/triggers/queue")>()),
  enqueueEvent: mocks.enqueueEvent,
}));
// Lead side effects that need Redis / outbound integrations.
vi.mock("@/lib/leads/delivery", () => ({ enqueueLeadDeliveries: vi.fn(async () => {}) }));
vi.mock("@/lib/integrations2/emit", () => ({ emitLeadCreated: vi.fn(async () => {}) }));
vi.mock("@/lib/queue/assistant-queue", () => ({ enqueueDelivery: vi.fn(async () => {}), enqueueNotify: vi.fn(async () => {}) }));

import { forgetAccountGate, ingestWebhookPayload } from "@/lib/triggers/ingest";
import { processInstagramEvent } from "@/lib/triggers/processor";
import { forgetCommentClaims } from "@/lib/triggers/claim";
import { createLeadForConversation } from "@/lib/leads/service";
import { runBackfill } from "@/lib/crm/backfill";
import { applyCrmTouch, runCrmReconcile, RECONCILE_SOURCES } from "@/lib/crm/sync";
import { clearCrmListeners } from "@/lib/crm/hooks";
import { readAnalytics } from "@/lib/analytics/read";
import { ensureInitialBackfill, resetInitialBackfillForTests } from "@/lib/analytics/rollup";
import { getDashboardStats, getLeadCards } from "@/lib/dashboard/stats";
import { loadDeliverySummary } from "@/lib/leads/undelivered";
import { runDiagnostics } from "@/lib/foundation/diagnostics";

const IG_ID = "17841400000000001";
const USER = "6000000000000001";
const POST = "18000000000000777";
const WS = "ws1";

const rows = (model: string) => db.rows(model);

function commentPayload(id: string, text: string) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_ID,
        time: Date.now(),
        changes: [
          {
            field: "comments",
            value: {
              id,
              text,
              from: { id: USER, username: "ali" },
              media: { id: POST },
              timestamp: Math.floor(Date.now() / 1000),
            },
          },
        ],
      },
    ],
  };
}

function postback(mid: string, payload: string) {
  return {
    object: "instagram",
    entry: [{ id: IG_ID, time: Date.now(), messaging: [{ sender: { id: USER }, recipient: { id: IG_ID }, timestamp: Date.now(), postback: { mid, title: "Ochish", payload } }] }],
  };
}

async function deliver(payload: unknown) {
  const result = await ingestWebhookPayload(payload);
  const outcomes: string[] = [];
  for (const id of result.stored) outcomes.push(await processInstagramEvent(id));
  return { ...result, outcomes };
}

/** Runs the whole chain up to the lead. */
async function runChain() {
  const comment = await deliver(commentPayload("cmt1", "narx qancha?"));
  const exec = rows("triggerExecution")[0];
  const tap = await deliver(postback("mid.tap.1", `c2:${exec.id}:open`));
  return { comment, tap, exec };
}

beforeEach(() => {
  resetDb();
  resetInitialBackfillForTests();
  clearCrmListeners();
  forgetAccountGate();
  forgetCommentClaims();
  vi.clearAllMocks();
  vi.unstubAllEnvs();
  vi.stubEnv("TRIGGER_ENGINE_DISABLED", "");
  vi.stubEnv("CRM_ENABLED", "1");

  db.seed("workspace", { id: WS, name: "Test", ownerId: "owner", isSuspended: false });
  db.seed("instagramAccount", { id: "acc1", workspaceId: WS, instagramId: IG_ID, username: "dokon", accessToken: "enc", tokenStatus: "ACTIVE" });
  db.seed("triggerCampaign", {
    id: "camp1",
    workspaceId: WS,
    instagramAccountId: "acc1",
    name: "Narx",
    triggerType: "COMMENT",
    keywords: ["narx"],
    matchingMode: "CONTAINS",
    intents: [],
    mediaScope: "ANY",
    mediaIds: [],
    priority: 0,
    replyMode: "SEQUENTIAL",
    sequenceCursor: 0,
    responseMessage: "Fallback javob",
    publicReplyEnabled: false,
    openingButtonLabel: "Narxni ko'rish",
    mainMessage: "Narxlar: 100 000 so'm.",
    stopOnReply: true,
    stopOnLead: true,
    stopOnHandoff: true,
    active: true,
  });
  db.seed("triggerReplyVariant", { id: "dm1", campaignId: "camp1", kind: "DM", text: "Salom! Narxni yuboraman", weight: 1, sort: 0, approvedAt: new Date() });

  let out = 0;
  const sent = async () => ({ recipient_id: USER, message_id: `mid.out.${++out}` });
  mocks.sendPrivateReplyWithButton.mockImplementation(sent);
  mocks.sendDirectMessage.mockImplementation(sent);
  mocks.sendDirectMessageWithQuickReplies.mockImplementation(sent);
  mocks.sendCommentReply.mockResolvedValue({ id: "reply1" });
  mocks.getMessagingProfile.mockResolvedValue({ username: "ali", name: "Ali Valiyev" });
  mocks.reserveWorkspaceDMSend.mockResolvedValue({ allowed: true, reserved: true, periodStart: new Date(), limit: 1, remaining: 1 });
  mocks.reserveDMSlot.mockResolvedValue({ allowed: true, currentCount: 1 });
  mocks.releaseWorkspaceDMReservation.mockResolvedValue({ count: 1 });
  mocks.enqueueEvent.mockResolvedValue(undefined);
  mocks.alertWorkspace.mockResolvedValue(undefined);
});

describe("Scenario A: comment -> DM -> tap -> main message -> lead -> CRM", () => {
  it("a keyword comment is matched, answered privately, and the tap sends the main message", async () => {
    const { comment, tap, exec } = await runChain();

    expect(comment.outcomes).toEqual(["processed"]);
    expect(exec).toMatchObject({ status: "SENT", campaignId: "camp1", variantId: "dm1", matchedKeyword: "narx" });
    expect(mocks.sendPrivateReplyWithButton).toHaveBeenCalledTimes(1);
    expect(mocks.sendPrivateReplyWithButton).toHaveBeenCalledWith(
      "plain:enc", IG_ID, "cmt1", "Salom! Narxni yuboraman", "Narxni ko'rish", `c2:${exec.id}:open`
    );

    expect(tap.outcomes).toEqual(["processed"]);
    expect(exec.openedAt).toBeInstanceOf(Date);
    // main message goes out as a plain DM (no quick replies configured) or with chips
    const mainCalls = mocks.sendDirectMessage.mock.calls.length + mocks.sendDirectMessageWithQuickReplies.mock.calls.length;
    expect(mainCalls).toBe(1);
    const mainText = (mocks.sendDirectMessage.mock.calls[0] ?? mocks.sendDirectMessageWithQuickReplies.mock.calls[0])[3];
    expect(mainText).toBe("Narxlar: 100 000 so'm.");
  });

  it("the lead creates one CRM contact (with the lead and a deal); sync and backfill re-runs never duplicate it", async () => {
    await runChain();
    // The customer shares a phone: the conversation exists and the lead is created.
    db.seed("conversation", {
      id: "conv1", workspaceId: WS, instagramAccountId: "acc1", igUserId: USER, igUsername: "ali", igName: "Ali Valiyev",
      collected: { phone_e164: "+998901234567", name: "Ali Valiyev" }, source: "CAMPAIGN", leadCycle: 0, createdAt: new Date(),
    });
    const lead = await createLeadForConversation("conv1");
    expect(lead).not.toBeNull();
    expect(rows("lead")).toHaveLength(1);
    expect(await createLeadForConversation("conv1")).toMatchObject({ id: lead!.id }); // idempotent
    expect(rows("lead")).toHaveLength(1);

    await applyCrmTouch({ kind: "lead_created", leadId: lead!.id, conversationId: "conv1" });
    const forUser = () => rows("crmContact").filter((c) => c.igUserId === USER);
    expect(forUser()).toHaveLength(1);
    expect(rows("crmDeal").filter((d) => d.leadId === lead!.id)).toHaveLength(1);
    expect(rows("crmActivity").filter((a) => a.type === "LEAD_CREATED")).toHaveLength(1);
    const contactId = forUser()[0].id;

    // Backfill (twice) and reconcile (twice) over the same stores.
    await runBackfill(WS, { log: false });
    await runBackfill(null, { log: false });
    const since = new Date(Date.now() - 3600_000);
    for (const source of RECONCILE_SOURCES) db.seed("crmSyncCursor", { source, cursorAt: since, cursorId: null, createdAt: since });
    await runCrmReconcile({ now: new Date(Date.now() + 10 * 60_000) });
    await runCrmReconcile({ now: new Date(Date.now() + 10 * 60_000) });

    expect(forUser()).toHaveLength(1);
    expect(forUser()[0].id).toBe(contactId);
    expect(rows("crmDeal").filter((d) => d.leadId === lead!.id)).toHaveLength(1);
    expect(rows("crmActivity").filter((a) => a.type === "LEAD_CREATED")).toHaveLength(1);
  });

  it("DM and lead counts are +1 on the Panel, dev Analytics and Diagnostics", async () => {
    const now = new Date();
    await runChain();
    db.seed("conversation", {
      id: "conv1", workspaceId: WS, instagramAccountId: "acc1", igUserId: USER, igUsername: "ali",
      collected: { phone_e164: "+998901234567", name: "Ali Valiyev" }, source: "CAMPAIGN", leadCycle: 0, createdAt: new Date(),
    });
    await createLeadForConversation("conv1");

    const realLeads = rows("lead").filter((l) => !l.isTest).length;
    const sentExecutions = rows("triggerExecution").filter((e) => e.status === "SENT").length;
    expect(realLeads).toBe(1);
    expect(sentExecutions).toBe(1);

    // dev Analytics
    await ensureInitialBackfill(WS, now);
    const campaign = await readAnalytics(WS, { tab: "campaign", preset: "30d", compare: "none", mode: "period" }, now);
    const sales = await readAnalytics(WS, { tab: "sales", preset: "30d", compare: "none", mode: "period" }, now);
    if (!campaign.ok || !sales.ok) throw new Error("analytics read failed");
    expect(campaign.data.metrics["campaign.sent"]?.value ?? 0).toBe(sentExecutions);
    expect(sales.data.metrics["sales.leads"]?.value ?? 0).toBe(realLeads);

    // Panel: the lead card and the DM counters (same definition as Analytics)
    const cards = await getLeadCards(WS);
    expect(cards.leads30).toBe(realLeads);
    const stats = await getDashboardStats({ workspaceId: WS, userId: null, locale: "en", selectedAccountId: null });
    expect(stats.dmsSentMonth).toBe(campaign.data.metrics["campaign.sent"]?.value ?? 0);

    // Diagnostics: same undelivered number as the card, and the new activity is "last event"
    const summary = await loadDeliverySummary(WS);
    expect(cards.undelivered).toBe(summary.undeliveredLeads);
    const items = await runDiagnostics(WS, { connections: [], queue: undefined, worker: null }, new Date());
    expect(items.find((i) => i.key === "last_event")).toBeDefined();
  });
});
