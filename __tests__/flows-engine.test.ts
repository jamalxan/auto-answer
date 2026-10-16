/**
 * ETAP 6 — the flow engine end to end against the in-memory database:
 *
 *   Scenario A (comment "narx" → proxy campaign → private reply with button →
 *   tap → chips → phone → lead → tag) · no double sends on retried events /
 *   crashes · Delay past 24h · conditions · ai.ask · webhook SSRF · operator ·
 *   foreign taps · plain DMs claimed by a waiting run (claim + handler agree) ·
 *   FLOWS_DISABLED · hidden from campaign lists · version pinning · CAS ·
 *   send retry · maintenance sweeps.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  sendPrivateReply: vi.fn(),
  sendPrivateReplyWithButton: vi.fn(),
  sendCommentReply: vi.fn(),
  sendDirectMessage: vi.fn(),
  sendDirectMessageWithButton: vi.fn(),
  sendDirectMessageWithQuickReplies: vi.fn(),
  getMessagingProfile: vi.fn(),
  markTokenBroken: vi.fn(),
  reserveWorkspaceDMSend: vi.fn(),
  releaseWorkspaceDMReservation: vi.fn(),
  reserveDMSlot: vi.fn(),
  enqueueEvent: vi.fn(),
  alertWorkspace: vi.fn(),
  notifyWorkspaceChats: vi.fn(),
  captureTriggerLead: vi.fn(),
  getJavobAiMode: vi.fn(),
  handJavobAiThread: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  sendPrivateReply: mocks.sendPrivateReply,
  sendPrivateReplyWithButton: mocks.sendPrivateReplyWithButton,
  sendCommentReply: mocks.sendCommentReply,
  sendDirectMessage: mocks.sendDirectMessage,
  sendDirectMessageWithButton: mocks.sendDirectMessageWithButton,
  sendDirectMessageWithQuickReplies: mocks.sendDirectMessageWithQuickReplies,
  getMessagingProfile: mocks.getMessagingProfile,
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (value: string) => `plain:${value}` }));
vi.mock("@/lib/meta/token-health", () => ({ markTokenBroken: mocks.markTokenBroken }));
vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mocks.reserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mocks.releaseWorkspaceDMReservation,
}));
vi.mock("@/lib/utils/rate-limiter", () => ({ reserveDMSlot: mocks.reserveDMSlot }));
vi.mock("@/lib/telegram/notify", () => ({ alertWorkspace: mocks.alertWorkspace, notifyWorkspaceChats: mocks.notifyWorkspaceChats }));
vi.mock("@/lib/triggers/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/triggers/queue")>()),
  enqueueEvent: mocks.enqueueEvent,
}));
vi.mock("@/lib/javobai/leads", () => ({ captureTriggerLead: mocks.captureTriggerLead }));
vi.mock("@/lib/javobai/gate", () => ({ getJavobAiMode: mocks.getJavobAiMode }));
vi.mock("@/lib/javobai/runtime", () => ({ handJavobAiThread: mocks.handJavobAiThread }));
vi.mock("@/lib/javobai/state", () => ({
  loadAccountConfig: async () => ({ isTest: true }),
  loadScoringConfig: async () => ({ thresholds: { warm: 30, hot: 60, veryHot: 85 } }),
}));

import { forgetCommentClaims, findActiveConversations, isCommentClaimedByCommentEngine, isClaimedC2Payload } from "@/lib/triggers/claim";
import { CONVERSATION_EVENT_TYPES } from "@/lib/triggers/claim";
import { listCommentCampaigns } from "@/lib/triggers/comment-service";
import { TriggerRetryableError } from "@/lib/triggers/errors";
import { findClaimedFlowMessages, forgetAccountGate, ingestWebhookPayload, storyReplyKey } from "@/lib/triggers/ingest";
import { normalizeWebhookPayload } from "@/lib/triggers/normalize";
import { listDmCampaigns } from "@/lib/triggers/dm-trigger-service";
import { processInstagramEvent } from "@/lib/triggers/processor";
import { getEngineOverview } from "@/lib/triggers/service";
import { FLOW_OWNS_THREAD_REASON, FLOW_TAP_FOREIGN_REASON, findConsumingRun, flowOwnsThread } from "@/lib/flows/bridge";
import { FLOW_DELETED_REASON, resumeFlowRun, runDueFlowRuns, startFlowRun, sweepFlowRuns, STUCK_REASON } from "@/lib/flows/engine";
import { publishFlowVersion } from "@/lib/flows/publish";
import { flowGraphDraftSchema, triggerOf, type FlowGraphInput } from "@/lib/flows/schema";
import { findStarterTemplate } from "@/lib/flows/templates";

const IG_ID = "17841400000000001";
const IG_ID_2 = "17841400000000002";
const USER = "6000000000000001";
const OTHER_USER = "6000000000000002";
const POST = "post1";

type Row = Record<string, unknown>;
const rows = (model: string) => db.rows(model);

// ─── Webhook payload helpers ──────────────────────────────────────────────────

function commentPayload(id: string, text: string, opts: { from?: string; at?: Date; media?: string } = {}) {
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
              from: { id: opts.from ?? USER, username: "ali" },
              media: { id: opts.media ?? POST },
              timestamp: Math.floor((opts.at ?? new Date()).getTime() / 1000),
            },
          },
        ],
      },
    ],
  };
}

function postback(mid: string, payload: string, opts: { sender?: string; entry?: string } = {}) {
  return {
    object: "instagram",
    entry: [
      {
        id: opts.entry ?? IG_ID,
        time: Date.now(),
        messaging: [{ sender: { id: opts.sender ?? USER }, recipient: { id: opts.entry ?? IG_ID }, timestamp: Date.now(), postback: { mid, title: "Tugma", payload } }],
      },
    ],
  };
}

function dm(mid: string, text: string, opts: { sender?: string; quickReply?: string } = {}) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_ID,
        time: Date.now(),
        messaging: [
          {
            sender: { id: opts.sender ?? USER },
            recipient: { id: IG_ID },
            timestamp: Date.now(),
            message: { mid, text, ...(opts.quickReply ? { quick_reply: { payload: opts.quickReply } } : {}) },
          },
        ],
      },
    ],
  };
}

async function deliver(payload: unknown) {
  const result = await ingestWebhookPayload(payload);
  const outcomes: string[] = [];
  for (const id of result.stored) {
    try {
      outcomes.push(await processInstagramEvent(id));
    } catch (error) {
      if (error instanceof TriggerRetryableError) outcomes.push("retrying");
      else throw error;
    }
  }
  return { ...result, outcomes };
}

// ─── Seeding ──────────────────────────────────────────────────────────────────

function seedCampaign(overrides: Row): Row {
  return db.seed("triggerCampaign", {
    workspaceId: "ws1",
    instagramAccountId: "acc1",
    name: "Kampaniya",
    triggerType: "DIRECT_MESSAGE",
    keywords: [],
    matchingMode: "EVERY",
    intents: [],
    mediaScope: "ANY",
    mediaIds: [],
    priority: 0,
    replyMode: "RANDOM",
    sequenceCursor: 0,
    responseMessage: "Javob",
    publicReplyEnabled: false,
    openingButtonLabel: null,
    mainMessage: null,
    stopOnReply: true,
    stopOnLead: true,
    stopOnHandoff: true,
    audience: "ANY",
    reopenAfterHours: 72,
    cooldownHours: 24,
    sourceFilter: "ANY",
    adIds: [],
    refs: [],
    active: true,
    ...overrides,
  });
}

/** A published flow without going through publishFlowVersion (the audit is not the point of most tests). */
function seedFlow(input: FlowGraphInput, opts: { id?: string; name?: string; priority?: number; accountId?: string; workspaceId?: string } = {}) {
  const id = opts.id ?? "flow1";
  const graph = flowGraphDraftSchema.parse(input);
  const trigger = triggerOf(graph)!;
  const proxy = seedCampaign({
    id: `proxy_${id}`,
    workspaceId: opts.workspaceId ?? "ws1",
    instagramAccountId: opts.accountId ?? "acc1",
    name: `[Flow] ${opts.name ?? "Oqim"}`,
    kind: "FLOW",
    triggerType: trigger.triggerType,
    keywords: trigger.keywords,
    matchingMode: trigger.matchingMode,
    intents: trigger.intents,
    priority: opts.priority ?? trigger.priority,
    responseMessage: "(flow)",
    stopOnReply: false,
    stopOnLead: false,
    stopOnHandoff: false,
  });
  const version = db.seed("flowVersion", { id: `ver_${id}_1`, flowId: id, version: 1, graph, hash: "h1" });
  const flow = db.seed("flow", {
    id,
    workspaceId: opts.workspaceId ?? "ws1",
    instagramAccountId: opts.accountId ?? "acc1",
    name: opts.name ?? "Oqim",
    triggerType: trigger.triggerType,
    status: "PUBLISHED",
    publishedVersionId: version.id,
    proxyCampaignId: proxy.id,
  });
  return { flow, version, proxy };
}

const dmFlow = (nodes: FlowGraphInput["nodes"], edges: FlowGraphInput["edges"], trigger: Record<string, unknown> = {}): FlowGraphInput => ({
  v: 1,
  variables: [],
  nodes: [{ id: "t", type: "trigger", triggerType: "DIRECT_MESSAGE", matchingMode: "EVERY", ...trigger } as FlowGraphInput["nodes"][number], ...nodes],
  edges: [{ from: "t", to: nodes[0].id, handle: "next" }, ...edges],
});

/** Greeting, chips, answer: a DM flow that parks at a Button node. */
const choiceFlow = (label = "V1"): FlowGraphInput =>
  dmFlow(
    [
      { id: "b", type: "button", text: "Tanlang", buttons: [{ id: "x", label: "Katalog" }, { id: "y", label: "Narx" }] },
      { id: "mx", type: "message", text: `${label} javob: katalog` },
      { id: "my", type: "message", text: `${label} javob: narx` },
      { id: "mo", type: "message", text: `${label} javob: boshqa` },
    ],
    [
      { from: "b", to: "mx", handle: "tap:x" },
      { from: "b", to: "my", handle: "tap:y" },
      { from: "b", to: "mo", handle: "other" },
    ]
  );

const runs = () => rows("flowRun");
const run0 = () => runs()[0] as Row & { id: string };
const steps = (runId: string) => rows("flowRunStep").filter((s) => s.runId === runId).sort((a, b) => (a.seq as number) - (b.seq as number));
const eventRow = (messageId: string) => rows("instagramEvent").find((e) => e.messageId === messageId)!;
const dmSends = () => mocks.sendDirectMessage.mock.calls.map((c) => c[3] as string);
const allSends = () =>
  mocks.sendDirectMessage.mock.calls.length +
  mocks.sendDirectMessageWithQuickReplies.mock.calls.length +
  mocks.sendDirectMessageWithButton.mock.calls.length +
  mocks.sendPrivateReply.mock.calls.length +
  mocks.sendPrivateReplyWithButton.mock.calls.length;

beforeEach(() => {
  resetDb();
  forgetAccountGate();
  forgetCommentClaims();
  vi.clearAllMocks();
  vi.stubEnv("TRIGGER_ENGINE_DISABLED", "");
  vi.stubEnv("FLOWS_DISABLED", "");
  vi.stubGlobal("fetch", mocks.fetch);

  db.seed("workspace", { id: "ws1", name: "Test", isSuspended: false });
  db.seed("instagramAccount", { id: "acc1", workspaceId: "ws1", instagramId: IG_ID, username: "dokon", accessToken: "enc", tokenStatus: "ACTIVE" });

  let out = 0;
  const sent = async () => ({ recipient_id: USER, message_id: `mid.out.${++out}` });
  mocks.sendPrivateReply.mockImplementation(sent);
  mocks.sendPrivateReplyWithButton.mockImplementation(sent);
  mocks.sendDirectMessage.mockImplementation(sent);
  mocks.sendDirectMessageWithButton.mockImplementation(sent);
  mocks.sendDirectMessageWithQuickReplies.mockImplementation(sent);
  mocks.sendCommentReply.mockResolvedValue({ id: "reply1" });
  mocks.getMessagingProfile.mockResolvedValue({ username: "ali", name: "Ali" });
  mocks.reserveWorkspaceDMSend.mockResolvedValue({ allowed: true, reserved: true, periodStart: new Date(), limit: 1, remaining: 1 });
  mocks.reserveDMSlot.mockResolvedValue({ allowed: true, currentCount: 1 });
  mocks.releaseWorkspaceDMReservation.mockResolvedValue({ count: 1 });
  mocks.enqueueEvent.mockResolvedValue(undefined);
  mocks.alertWorkspace.mockResolvedValue(undefined);
  mocks.notifyWorkspaceChats.mockResolvedValue(1);
  mocks.captureTriggerLead.mockResolvedValue({ id: "lead1" });
  mocks.getJavobAiMode.mockResolvedValue("OFF");
  mocks.handJavobAiThread.mockResolvedValue(undefined);
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

// ─── Scenario A ───────────────────────────────────────────────────────────────

describe("Scenario A — comment narx → private reply with button → tap → chips → phone → lead → tag", () => {
  async function publishScenarioA() {
    const template = findStarterTemplate("comment_price_lead")!;
    db.seed("flow", { id: "flowA", workspaceId: "ws1", instagramAccountId: "acc1", name: "Narx oqimi", triggerType: "COMMENT", status: "DRAFT" });
    db.seed("flowVersion", { id: "verA1", flowId: "flowA", version: 1, graph: template.graph, hash: "hA", source: "TEMPLATE" });
    const published = await publishFlowVersion("ws1", "flowA", "verA1", { userId: "u1" });
    expect(published).toMatchObject({ ok: true });
  }

  it("runs end to end and never double-sends", async () => {
    await publishScenarioA();
    // The proxy campaign is what the webhook sees: the account is engaged by it alone.
    expect(rows("triggerCampaign")).toHaveLength(1);
    expect(rows("triggerCampaign")[0]).toMatchObject({ kind: "FLOW", active: true, triggerType: "COMMENT", name: "[Flow] Narx oqimi" });

    // 1. the comment
    const first = await deliver(commentPayload("c1", "Narxi qancha?"));
    expect(first.outcomes).toEqual(["processed"]);
    const run = run0();
    expect(run).toMatchObject({ flowId: "flowA", versionId: "verA1", status: "WAITING_TAP", waitNodeId: "m1", waitKind: "tap", igUserId: USER });
    expect(mocks.sendCommentReply).toHaveBeenCalledTimes(1);
    expect(mocks.sendCommentReply).toHaveBeenCalledWith("plain:enc", "c1", "Narxni Direct'ga yubordik 📩");
    expect(mocks.sendPrivateReplyWithButton).toHaveBeenCalledWith(
      "plain:enc",
      IG_ID,
      "c1",
      "Salom Ali! Narxlar bilan tanishish uchun tugmani bosing 👇",
      "Narxni ko'rish",
      `fl:${run.id}:m1:open`
    );
    expect(allSends()).toBe(1);
    // the proxy execution: SENT, so JavobAI / Direct triggers see the thread as taken
    expect(rows("triggerExecution")[0]).toMatchObject({ status: "SENT", campaignId: run.executionId ? rows("triggerCampaign")[0].id : "-" });
    expect(await flowOwnsThread("acc1", USER)).toBe(true);
    expect(await findConsumingRun("acc1", USER)).toBeNull(); // a message button does not take typed text

    // 2. the tap on the opening button → price + chips
    const tap = await deliver(postback("pb1", `fl:${run.id}:m1:open`));
    expect(tap.outcomes).toEqual(["processed"]);
    expect(dmSends()).toEqual(["Narx hozircha kiritilmagan — aniq narxni menejer aytadi. Katalogni ham yuboraymi?"]);
    expect(mocks.sendDirectMessageWithQuickReplies).toHaveBeenCalledWith("plain:enc", IG_ID, USER, "Tanlang:", [
      { title: "Katalog", payload: `fl:${run.id}:b1:cat`, contentType: "text" },
      { title: "Raqamimni qoldiraman", payload: `fl:${run.id}:b1:ph`, contentType: "user_phone_number" },
    ]);
    expect(run0()).toMatchObject({ status: "WAITING_TAP", waitNodeId: "b1", waitKind: "phone", sendsSinceInbound: 2 });
    // the tap opened the 24h window on the proxy execution
    expect(rows("triggerExecution")[0].openedAt).toBeInstanceOf(Date);

    // 3. the shared phone number (quick reply with our payload)
    const phone = await deliver(dm("m3", "+998 90 123 45 67", { quickReply: `fl:${run.id}:b1:ph` }));
    expect(phone.outcomes).toEqual(["processed"]);
    expect(mocks.captureTriggerLead).toHaveBeenCalledTimes(1);
    expect(mocks.captureTriggerLead.mock.calls[0][0]).toMatchObject({ igUserId: USER, phoneE164: "+998901234567", campaignName: "Narx oqimi", isTest: true });
    expect(dmSends()).toEqual(["Narx hozircha kiritilmagan — aniq narxni menejer aytadi. Katalogni ham yuboraymi?", "Rahmat! Tez orada bog'lanamiz."]);
    expect(rows("crmContactTag").length).toBe(2);
    expect(rows("crmTag").map((t) => t.slug).sort()).toEqual(["lead", "narx"]);
    expect(mocks.notifyWorkspaceChats).toHaveBeenCalledWith("ws1", "🔥 Yangi lead: @ali +998901234567 — Narxi qancha?");
    expect(rows("instagramContact")[0].phone).toBe("+998901234567");

    // finished
    expect(run0()).toMatchObject({ status: "DONE", endReason: "Oqim tugadi" });
    expect(run0().finishedAt).toBeInstanceOf(Date);
    expect(steps(run.id).map((s) => `${s.nodeId}:${s.status}`)).toEqual([
      "t:DONE", "m1:WAITING", "m1:DONE", "sp:DONE", "sc:DONE", "cp:DONE", "m2x:DONE", "b1:WAITING", "b1:DONE", "lead:DONE", "tag:DONE", "tg:DONE", "end:DONE",
    ]);
    expect(await flowOwnsThread("acc1", USER)).toBe(false);

    // 4. retries: redelivered webhooks, re-processed events, a repeated tap, a repeated start — nothing goes out twice
    const before = { sends: allSends(), steps: steps(run.id).length };
    const redelivered = await deliver(commentPayload("c1", "Narxi qancha?"));
    expect(redelivered.duplicates).toBe(1);
    expect(await processInstagramEvent(eventRow("c1").id as string)).toBe("already_done");
    expect(await processInstagramEvent(eventRow("pb1").id as string)).toBe("already_done");
    const again = await resumeFlowRun(run.id, { kind: "tap", nodeId: "m1", buttonId: "open", eventId: "other-event", at: new Date() });
    expect(again).toMatchObject({ status: "ignored" });
    const event = { ...(eventRow("c1") as object), instagramAccount: rows("instagramAccount")[0] } as never;
    const restarted = await startFlowRun({
      flow: { id: "flowA", name: "Narx oqimi", workspaceId: "ws1" },
      version: { id: "verA1", graph: rows("flowVersion")[0].graph },
      campaign: { id: rows("triggerCampaign")[0].id as string },
      event,
      interaction: { contact: rows("instagramContact")[0], conversation: rows("triggerConversation")[0], isNewMessage: false, isNewContact: false } as never,
      matchedKeyword: null,
    });
    expect(restarted.status).toBe("PROCESSED");
    expect(runs()).toHaveLength(1);
    expect({ sends: allSends(), steps: steps(run.id).length }).toEqual(before);
    expect(mocks.captureTriggerLead).toHaveBeenCalledTimes(1);
    expect(mocks.sendCommentReply).toHaveBeenCalledTimes(1);
  });

  it("a comment older than 7 days is skipped without a run", async () => {
    await publishScenarioA();
    const old = await deliver(commentPayload("cOld", "narx", { at: new Date(Date.now() - 8 * 24 * 3600_000) }));
    expect(old.outcomes).toEqual(["processed"]);
    expect(runs()).toHaveLength(0);
    expect(rows("triggerExecution")[0]).toMatchObject({ status: "SKIPPED" });
    expect(allSends()).toBe(0);
  });

  it("a second comment while the person has a live run does not start another", async () => {
    await publishScenarioA();
    await deliver(commentPayload("c1", "narx"));
    const second = await deliver(commentPayload("c2", "narx yana"));
    expect(second.outcomes).toEqual(["processed"]);
    expect(runs()).toHaveLength(1);
    expect(rows("triggerExecution").find((e) => e.status === "SKIPPED")).toBeTruthy();
    expect(mocks.sendPrivateReplyWithButton).toHaveBeenCalledTimes(1);
  });

  it("a crash after the private reply left the execution SENDING never re-sends it", async () => {
    await publishScenarioA();
    await deliver(commentPayload("c1", "narx"));
    // simulate: the worker died before the run was committed — execution SENDING, run back at the first node
    rows("triggerExecution")[0].status = "SENDING";
    Object.assign(run0(), { status: "ACTIVE", seq: 1, currentNodeId: "m1", waitNodeId: null, waitKind: null, variables: { ...(run0().variables as object), __firstSent: false } });
    const { continueFlowRun } = await import("@/lib/flows/engine");
    await continueFlowRun(run0().id);
    expect(mocks.sendPrivateReplyWithButton).toHaveBeenCalledTimes(1);
    expect(run0()).toMatchObject({ status: "FAILED" });
    expect(run0().endReason).toContain("ikki marta yubormaslik");
  });
});

// ─── DM-side flows ────────────────────────────────────────────────────────────

describe("send idempotency (run + seq marker)", () => {
  it("a crash after the send but before the commit never sends the message again", async () => {
    seedFlow(
      dmFlow(
        [
          { id: "m1", type: "message", text: "Salom" },
          { id: "m2", type: "message", text: "Yana" },
          { id: "end", type: "end" },
        ],
        [
          { from: "m1", to: "m2", handle: "next" },
          { from: "m2", to: "end", handle: "next" },
        ]
      )
    );
    await deliver(dm("mid.1", "salom"));
    expect(dmSends()).toEqual(["Salom", "Yana"]);
    const run = run0();
    expect(run.status).toBe("DONE");

    // Rewind to "m2 was sent (its marker holds Meta's mid) but the commit was lost".
    Object.assign(run, { status: "ACTIVE", currentNodeId: "m2", seq: 2, endReason: null, finishedAt: null, waitNodeId: null });
    rows("flowRunStep").splice(0, rows("flowRunStep").length);
    const { continueFlowRun } = await import("@/lib/flows/engine");
    await continueFlowRun(run.id);
    expect(dmSends()).toEqual(["Salom", "Yana"]);
    expect(run0().status).toBe("DONE");

    // An interrupted send (marker still `pending`) is not repeated either.
    Object.assign(run0(), { status: "ACTIVE", currentNodeId: "m2", seq: 2, endReason: null, finishedAt: null, variables: {} });
    const marker = rows("triggerMessage").find((m) => String(m.mid).startsWith(`flow:${run.id}:3:`))!;
    marker.mid = `flow:${run.id}:3:pending`;
    await continueFlowRun(run.id);
    expect(dmSends()).toEqual(["Salom", "Yana"]);
  });

  it("a retryable Meta failure waits, then sends once", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-02T10:00:00Z"));
    seedFlow(dmFlow([{ id: "m1", type: "message", text: "Salom" }, { id: "end", type: "end" }], [{ from: "m1", to: "end", handle: "next" }]));
    mocks.sendDirectMessage.mockRejectedValueOnce(new Error("network down"));
    await deliver(dm("mid.1", "salom"));
    expect(run0()).toMatchObject({ status: "WAITING_DELAY", waitKind: "retry", waitNodeId: "m1" });
    expect(rows("triggerMessage").filter((m) => String(m.mid).startsWith("flow:"))).toHaveLength(0); // the marker was removed
    vi.setSystemTime(new Date("2026-03-02T10:05:00Z"));
    expect(await runDueFlowRuns(new Date())).toMatchObject({ resumed: 1 });
    expect(run0().status).toBe("DONE");
    expect(dmSends()).toEqual(["Salom", "Salom"].slice(0, 2)); // the failed attempt + the real one: only one reached Meta
    expect(mocks.sendDirectMessage).toHaveBeenCalledTimes(2);
    expect(rows("triggerMessage").filter((m) => String(m.mid).startsWith("flow:") && !String(m.mid).endsWith("pending"))).toHaveLength(1);
  });
});

describe("Delay and the 24h window", () => {
  const delayFlow = (ifWindowClosed?: "end" | "skip_sends") =>
    dmFlow(
      [
        { id: "m1", type: "message", text: "Salom" },
        { id: "d", type: "delay", minutes: 1500, ...(ifWindowClosed ? { ifWindowClosed } : {}) },
        { id: "m2", type: "message", text: "Eslatma" },
        { id: "end", type: "end" },
      ],
      [
        { from: "m1", to: "d", handle: "next" },
        { from: "d", to: "m2", handle: "next" },
        { from: "m2", to: "end", handle: "next" },
      ]
    );

  it("a Delay past 24h never sends: the run ends with the reason", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-02T10:00:00Z"));
    seedFlow(delayFlow());
    await deliver(dm("mid.1", "salom"));
    expect(run0()).toMatchObject({ status: "WAITING_DELAY", waitKind: "delay" });
    expect(dmSends()).toEqual(["Salom"]);

    // not due yet: the sweep leaves it alone
    expect(await runDueFlowRuns(new Date())).toMatchObject({ resumed: 0 });

    vi.setSystemTime(new Date("2026-03-03T12:00:00Z")); // +26h
    expect(await runDueFlowRuns(new Date())).toMatchObject({ resumed: 1 });
    expect(dmSends()).toEqual(["Salom"]);
    expect(run0()).toMatchObject({ status: "DONE" });
    expect(run0().endReason).toContain("24 soatlik oyna yopilgan");
    expect(steps(run0().id).find((s) => s.nodeId === "m2")).toMatchObject({ status: "SKIPPED" });
  });

  it("a customer message during the wait keeps the window open; cancelOnReply ends the run", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-03-02T10:00:00Z"));
    seedFlow(
      dmFlow(
        [
          { id: "m1", type: "message", text: "Salom" },
          { id: "d", type: "delay", minutes: 60, cancelOnReply: true },
          { id: "m2", type: "message", text: "Eslatma" },
        ],
        [
          { from: "m1", to: "d", handle: "next" },
          { from: "d", to: "m2", handle: "next" },
        ]
      )
    );
    await deliver(dm("mid.1", "salom"));
    vi.setSystemTime(new Date("2026-03-02T10:20:00Z"));
    // the customer writes during the Delay: nobody consumes it for the flow (it is not waiting for text)...
    expect(await findConsumingRun("acc1", USER)).toBeNull();
    // ...but the proxy execution's window anchor moves (direct-handler bookkeeping), which cancelOnReply reads
    rows("triggerExecution")[0].lastInboundAt = new Date();
    vi.setSystemTime(new Date("2026-03-02T11:30:00Z"));
    await runDueFlowRuns(new Date());
    expect(run0()).toMatchObject({ status: "DONE", endReason: "Mijoz javob yozdi — keyingi xabarlar bekor qilindi." });
    expect(dmSends()).toEqual(["Salom"]);
  });
});

describe("Condition branches", () => {
  const branching = dmFlow(
    [
      {
        id: "c",
        type: "condition",
        branches: [{ id: "price", label: "Narx", when: { v: 1, all: [{ field: "trigger.text", op: "keyword", value: ["narx", "narxi"] }] } }],
      },
      { id: "mp", type: "message", text: "Narx: 100 000" },
      { id: "me", type: "message", text: "Savolingizni yozing" },
    ],
    [
      { from: "c", to: "mp", handle: "branch:price" },
      { from: "c", to: "me", handle: "else" },
    ]
  );

  it("answers by the matched branch", async () => {
    seedFlow(branching);
    await deliver(dm("mid.1", "narxi qancha"));
    await deliver(dm("mid.2", "salom", { sender: OTHER_USER }));
    expect(dmSends()).toEqual(["Narx: 100 000", "Savolingizni yozing"]);
    expect(steps(runs()[0].id as string).find((s) => s.nodeId === "c")?.output).toMatchObject({ branch: "price" });
  });
});

// ─── Typed answers: claim and handler agree ───────────────────────────────────

describe("a plain DM from someone whose run waits for an answer", () => {
  const askFlow = dmFlow(
    [
      { id: "a", type: "ai", mode: "ask", question: "Telefon raqamingiz?", extract: "phone", saveAs: "phone", retries: 1, retryText: "Raqamni to'g'ri yozing" },
      { id: "ok", type: "message", text: "Rahmat, {{vars.phone}}" },
      { id: "no", type: "message", text: "Raqam kerak bo'ladi" },
    ],
    [
      { from: "a", to: "ok", handle: "next" },
      { from: "a", to: "no", handle: "missing" },
    ],
    { priority: 5 }
  );

  it("is claimed in the webhook AND handled by the run — not answered by production or a Direct trigger", async () => {
    seedCampaign({ id: "directAll", name: "Direct (hamma)", responseMessage: "Direct javobi" });
    seedFlow(askFlow);

    await deliver(dm("mid.1", "salom"));
    expect(dmSends()).toEqual(["Telefon raqamingiz?"]);
    expect(run0()).toMatchObject({ status: "WAITING_INBOUND", waitKind: "inbound" });
    expect(eventRow("mid.1").claimedCampaignId).toBe("proxy_flow1");

    // second message: the webhook claims it for the run (the key the route keeps away from production)...
    const payload = dm("mid.2", "90 123 45 67");
    expect([...(await findClaimedFlowMessages(payload))]).toEqual([storyReplyKey(IG_ID, "mid.2")]);
    const result = await deliver(payload);
    // ...no Direct campaign claimed it (claim and handler agree)...
    expect(eventRow("mid.2").claimedCampaignId).toBeNull();
    expect(rows("triggerExecution").filter((e) => e.campaignId === "directAll")).toHaveLength(0);
    expect(result.outcomes).toEqual(["processed"]);
    // ...and the run took it.
    expect(dmSends()).toEqual(["Telefon raqamingiz?", "Rahmat, +998901234567"]);
    expect(run0()).toMatchObject({ status: "DONE" });
    expect((run0().variables as Row).phone).toBe("+998901234567");

    // after the run ended, the next DM is free for the other triggers again
    expect([...(await findClaimedFlowMessages(dm("mid.3", "yana")))]).toEqual([]);
  });

  it("retries once, then takes the `missing` edge", async () => {
    seedFlow(askFlow);
    await deliver(dm("mid.1", "salom"));
    await deliver(dm("mid.2", "bilmayman"));
    expect(dmSends()).toEqual(["Telefon raqamingiz?", "Raqamni to'g'ri yozing"]);
    expect(run0().status).toBe("WAITING_INBOUND");
    await deliver(dm("mid.3", "yo'q"));
    expect(dmSends()).toEqual(["Telefon raqamingiz?", "Raqamni to'g'ri yozing", "Raqam kerak bo'ladi"]);
    expect(run0().status).toBe("DONE");
  });

  it("a live run blocks the Direct trigger's claim for a DM from the same person", async () => {
    seedCampaign({ id: "directAll", name: "Direct (hamma)", priority: 10 });
    seedFlow(choiceFlow());
    // the Direct campaign wins the first DM here (priority 10), so start the flow by hand for the person
    db.seed("flowRun", { id: "runX", workspaceId: "ws1", flowId: "flow1", versionId: "ver_flow1_1", instagramAccountId: "acc1", igUserId: USER, eventId: "e0", status: "WAITING_DELAY", currentNodeId: "b" });
    const { decideDmTrigger } = await import("@/lib/triggers/claim");
    const decision = await decideDmTrigger({ accountId: "acc1", senderId: USER, type: "DIRECT_MESSAGE", text: "salom", at: new Date() });
    expect(decision.campaign).toBeNull();
    expect(decision.reason).toBe(FLOW_OWNS_THREAD_REASON);
  });

  it("button chips: a tap goes to its edge, typed text goes to `other`, a phone chip takes a typed number", async () => {
    seedFlow(choiceFlow());
    await deliver(dm("mid.1", "salom"));
    const id = run0().id;
    expect(mocks.sendDirectMessageWithQuickReplies).toHaveBeenCalledWith("plain:enc", IG_ID, USER, "Tanlang", [
      { title: "Katalog", payload: `fl:${id}:b:x`, contentType: "text" },
      { title: "Narx", payload: `fl:${id}:b:y`, contentType: "text" },
    ]);
    // a stale tap of another node is ignored
    await deliver(postback("pb0", `fl:${id}:zzz:x`));
    expect(run0().status).toBe("WAITING_TAP");
    await deliver(dm("mid.2", "Narx", { quickReply: `fl:${id}:b:y` }));
    expect(dmSends()).toEqual(["V1 javob: narx"]);
    expect(run0().status).toBe("DONE");

    // a second person: typed text instead of a tap → the `other` edge
    await deliver(dm("mid.3", "salom", { sender: OTHER_USER }));
    await deliver(dm("mid.4", "tushunmadim", { sender: OTHER_USER }));
    expect(dmSends()).toEqual(["V1 javob: narx", "V1 javob: boshqa"]);
  });
});

// ─── Taps from other people / workspaces ──────────────────────────────────────

describe("fl: taps are checked against the run", () => {
  it("a tap from another person or another workspace changes nothing", async () => {
    seedFlow(choiceFlow());
    seedCampaign({ id: "ws2camp", workspaceId: "ws2", instagramAccountId: "acc2", name: "Boshqa" });
    db.seed("workspace", { id: "ws2", name: "Boshqa", isSuspended: false });
    db.seed("instagramAccount", { id: "acc2", workspaceId: "ws2", instagramId: IG_ID_2, username: "boshqa", accessToken: "enc", tokenStatus: "ACTIVE" });
    forgetAccountGate();

    await deliver(dm("mid.1", "salom"));
    const id = run0().id;
    const sends = allSends();

    const stranger = await deliver(postback("pbA", `fl:${id}:b:x`, { sender: OTHER_USER }));
    expect(stranger.outcomes).toEqual(["ignored"]);
    expect(eventRow("pbA")).toMatchObject({ processingStatus: "IGNORED", error: FLOW_TAP_FOREIGN_REASON });

    const foreign = await deliver(postback("pbB", `fl:${id}:b:x`, { entry: IG_ID_2 }));
    expect(foreign.outcomes).toEqual(["ignored"]);
    expect(rows("instagramEvent").find((e) => e.messageId === "pbB")).toMatchObject({ processingStatus: "IGNORED", error: FLOW_TAP_FOREIGN_REASON });

    const missing = await deliver(postback("pbC", `fl:nope:b:x`));
    expect(missing.outcomes).toEqual(["ignored"]);

    expect(run0()).toMatchObject({ status: "WAITING_TAP", waitNodeId: "b" });
    expect(allSends()).toBe(sends);
  });

  it("two taps racing for one run advance it once (compare-and-swap)", async () => {
    seedFlow(choiceFlow());
    await deliver(dm("mid.1", "salom"));
    const id = run0().id;
    const tap = (eventId: string) => resumeFlowRun(id, { kind: "tap", nodeId: "b", buttonId: "x", eventId, at: new Date() });
    const [a, b] = await Promise.all([tap("evA"), tap("evB")]);
    expect([a.status, b.status].sort()).toEqual(["advanced", "busy"]);
    expect(dmSends()).toEqual(["V1 javob: katalog"]);
    expect(run0().status).toBe("DONE");
  });
});

// ─── Nodes ────────────────────────────────────────────────────────────────────

describe("webhook node", () => {
  const webhookFlow = (url: string) =>
    dmFlow(
      [
        { id: "w", type: "webhook", url, body: { phone: "{{phone}}", text: "{{trigger.text}}" }, saveAs: "price", savePath: "data.price" },
        { id: "ok", type: "message", text: "Narx: {{vars.price}}" },
        { id: "bad", type: "message", text: "Hozir narxni ayta olmayman" },
      ],
      [
        { from: "w", to: "ok", handle: "next" },
        { from: "w", to: "bad", handle: "error" },
      ]
    );

  it("a private host is refused: no request leaves, the error edge is taken", async () => {
    seedFlow(webhookFlow("https://10.0.0.5/hook"));
    await deliver(dm("mid.1", "narx"));
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(dmSends()).toEqual(["Hozir narxni ayta olmayman"]);
    const step = steps(run0().id).find((s) => s.nodeId === "w")!;
    expect(step).toMatchObject({ status: "FAILED" });
    expect(String(step.reason)).toContain("rad etildi");
  });

  it("http and userinfo URLs are refused too", async () => {
    seedFlow(webhookFlow("http://api.example.com/hook"));
    await deliver(dm("mid.1", "narx"));
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(dmSends()).toEqual(["Hozir narxni ayta olmayman"]);
  });

  it("a public host is called with a POST (no redirects) and its JSON is saved", async () => {
    seedFlow(webhookFlow("https://93.184.216.34/hook"));
    mocks.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ data: { price: "150 000" } }), { status: 200 }));
    await deliver(dm("mid.1", "narx"));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    const [url, init] = mocks.fetch.mock.calls[0];
    expect(url).toBe("https://93.184.216.34/hook");
    expect(init).toMatchObject({ method: "POST", redirect: "manual" });
    expect(JSON.parse(init.body).data).toEqual({ phone: "", text: "narx" });
    expect(dmSends()).toEqual(["Narx: 150 000"]);
  });

  it("a redirect response is treated as a failure", async () => {
    seedFlow(webhookFlow("https://93.184.216.34/hook"));
    mocks.fetch.mockResolvedValueOnce(new Response("", { status: 302, headers: { location: "http://169.254.169.254/" } }));
    await deliver(dm("mid.1", "narx"));
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(dmSends()).toEqual(["Hozir narxni ayta olmayman"]);
  });
});

describe("operator, tag, crm and ai nodes", () => {
  it("the operator node hands the thread to a human: JavobAI and the Direct triggers stay silent, Telegram is alerted", async () => {
    seedFlow(
      dmFlow(
        [{ id: "op", type: "operator", reply: "Operator ulandi", note: "Mijoz: {{trigger.text}}", reason: "wants_human" }],
        []
      )
    );
    await deliver(dm("mid.1", "operator kerak"));
    expect(dmSends()).toEqual(["Operator ulandi"]);
    expect(run0()).toMatchObject({ status: "DONE", endReason: "Operatorga o'tkazildi" });
    expect(rows("triggerExecution")[0].handedOffAt).toBeInstanceOf(Date);
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.alertWorkspace.mock.calls[0][2]).toContain("Mijoz: operator kerak");
    // the very rule JavobAI's runtime reads (runtime.ts: owners.find((o) => o.handedOffAt))
    const owners = await findActiveConversations({ accountId: "acc1", senderId: USER, at: new Date(), eventTypes: CONVERSATION_EVENT_TYPES });
    expect(owners.find((o) => o.handedOffAt)).toBeTruthy();
  });

  it("tag add / remove and the CRM contact", async () => {
    seedFlow(
      dmFlow(
        [
          { id: "ta", type: "tag", action: "add", tagSlugs: ["vip", "narx"] },
          { id: "tr", type: "tag", action: "remove", tagSlugs: ["narx"] },
          { id: "m", type: "message", text: "Teg qo'yildi" },
        ],
        [
          { from: "ta", to: "tr", handle: "next" },
          { from: "tr", to: "m", handle: "next" },
        ]
      )
    );
    await deliver(dm("mid.1", "salom"));
    const tags = rows("crmContactTag").map((t) => rows("crmTag").find((tag) => tag.id === t.tagId)!.slug);
    expect(tags).toEqual(["vip"]);
    expect(rows("crmContact")[0]).toMatchObject({ igUserId: USER, instagramAccountId: "acc1" });
    expect(dmSends()).toEqual(["Teg qo'yildi"]);
  });

  it("ai takeover hands the thread to JavobAI on a LIVE account and falls back otherwise", async () => {
    const takeover = dmFlow(
      [
        { id: "ai", type: "ai", mode: "takeover", intro: "Hozir javob beraman" },
        { id: "fb", type: "message", text: "Operator javob beradi" },
      ],
      [{ from: "ai", to: "fb", handle: "fallback" }]
    );
    seedFlow(takeover);
    mocks.getJavobAiMode.mockResolvedValue("LIVE");
    await deliver(dm("mid.1", "savolim bor"));
    expect(mocks.handJavobAiThread).toHaveBeenCalledTimes(1);
    expect(mocks.handJavobAiThread.mock.calls[0][0]).toMatchObject({ igUserId: USER, context: { campaignName: "Oqim", quickReplyLabel: "flow" } });
    expect(dmSends()).toEqual(["Hozir javob beraman"]);
    expect(run0()).toMatchObject({ status: "DONE", endReason: "JavobAI'ga o'tkazildi" });

    mocks.getJavobAiMode.mockResolvedValue("OFF");
    mocks.handJavobAiThread.mockClear();
    await deliver(dm("mid.2", "savolim bor", { sender: OTHER_USER }));
    expect(mocks.handJavobAiThread).not.toHaveBeenCalled();
    expect(dmSends().at(-1)).toBe("Operator javob beradi");
  });

  it("action nodes: variables, increment and the Telegram notification", async () => {
    seedFlow(
      dmFlow(
        [
          { id: "a1", type: "action", action: "set_variable", key: "city", value: "Toshkent" },
          { id: "a2", type: "action", action: "increment", key: "n" },
          { id: "a3", type: "action", action: "notify_telegram", text: "{{vars.city}} {{vars.n}} <b>" },
          { id: "m", type: "message", text: "{{vars.city}}" },
        ],
        [
          { from: "a1", to: "a2", handle: "next" },
          { from: "a2", to: "a3", handle: "next" },
          { from: "a3", to: "m", handle: "next" },
        ]
      )
    );
    await deliver(dm("mid.1", "salom"));
    expect(mocks.notifyWorkspaceChats).toHaveBeenCalledWith("ws1", "Toshkent 1 &lt;b&gt;");
    expect(dmSends()).toEqual(["Toshkent"]);
    expect((run0().variables as Row).city).toBe("Toshkent");
  });
});

// ─── Kill switch, lists, versions ─────────────────────────────────────────────

describe("FLOWS_DISABLED=1 leaves production untouched", () => {
  const publishedComment = () => {
    const template = findStarterTemplate("comment_price_lead")!;
    seedFlow(template.graph as unknown as FlowGraphInput, { id: "flowA", name: "Narx oqimi" });
  };

  it("proxy campaigns do not engage the account, claim comments or accept fl: payloads", async () => {
    publishedComment();
    expect(await isCommentClaimedByCommentEngine("acc1", POST, "narx")).toBe(true);
    expect(isClaimedC2Payload("fl:r:n:b")).toBe(true);
    expect(normalizeWebhookPayload(postback("pb", "fl:r:n:b") as never)).toHaveLength(1);

    vi.stubEnv("FLOWS_DISABLED", "1");
    forgetCommentClaims();
    forgetAccountGate();
    expect(await isCommentClaimedByCommentEngine("acc1", POST, "narx")).toBe(false);
    expect(isClaimedC2Payload("fl:r:n:b")).toBe(false);
    expect(isClaimedC2Payload("c2:e:open")).toBe(true);
    expect(normalizeWebhookPayload(postback("pb", "fl:r:n:b") as never)).toHaveLength(0);

    const result = await deliver(commentPayload("c1", "narx"));
    expect(result.stored).toHaveLength(0); // the account has no ordinary campaign: not engaged
    expect(runs()).toHaveLength(0);
    expect(allSends()).toBe(0);
  });

  it("an ordinary campaign on the same account still answers, the flow stays out", async () => {
    publishedComment();
    seedCampaign({
      id: "ordinary",
      name: "Oddiy komment",
      triggerType: "COMMENT",
      matchingMode: "CONTAINS",
      keywords: ["narx"],
      responseMessage: "Oddiy javob",
    });
    vi.stubEnv("FLOWS_DISABLED", "1");
    forgetCommentClaims();
    forgetAccountGate();
    const result = await deliver(commentPayload("c1", "narx"));
    expect(result.outcomes).toEqual(["processed"]);
    expect(mocks.sendPrivateReply).toHaveBeenCalledWith("plain:enc", IG_ID, "c1", "Oddiy javob");
    expect(runs()).toHaveLength(0);
    expect(rows("triggerExecution")).toHaveLength(1);
    expect(rows("triggerExecution")[0].campaignId).toBe("ordinary");
    expect(mocks.sendCommentReply).not.toHaveBeenCalled();
  });

  it("with flows off nothing resumes or starts", async () => {
    seedFlow(choiceFlow());
    await deliver(dm("mid.1", "salom"));
    const id = run0().id;
    vi.stubEnv("FLOWS_DISABLED", "1");
    expect(await resumeFlowRun(id, { kind: "tap", nodeId: "b", buttonId: "x", eventId: "e", at: new Date() })).toEqual({ status: "disabled" });
    expect(await runDueFlowRuns(new Date())).toEqual({ resumed: 0, failed: 0 });
    expect(await findConsumingRun("acc1", USER)).toBeNull();
    expect(await flowOwnsThread("acc1", USER)).toBe(false);
  });
});

describe("flows are hidden from the campaign lists", () => {
  it("listCommentCampaigns, listDmCampaigns and the overview do not show proxy rows", async () => {
    seedCampaign({ id: "cc", name: "Komment", triggerType: "COMMENT", matchingMode: "CONTAINS", keywords: ["narx"] });
    seedCampaign({ id: "dd", name: "Direct", triggerType: "DIRECT_MESSAGE" });
    seedFlow(dmFlow([{ id: "m", type: "message", text: "Salom" }], []), { id: "fDm", name: "Direct oqim" });
    seedFlow(
      { v: 1, variables: [], nodes: [{ id: "t", type: "trigger", triggerType: "COMMENT", matchingMode: "CONTAINS", keywords: ["narx"] }, { id: "m", type: "message", text: "Salom" }], edges: [{ from: "t", to: "m", handle: "next" }] },
      { id: "fCm", name: "Komment oqim" }
    );
    expect((await listCommentCampaigns("ws1")).map((c) => c.id)).toEqual(["cc"]);
    expect((await listDmCampaigns("ws1")).map((c) => c.id)).toEqual(["dd"]);
    expect((await getEngineOverview("ws1")).activeCampaigns).toBe(2);
  });
});

describe("version pinning", () => {
  it("a new publish does not change a running conversation; new people get the new version", async () => {
    seedFlow(choiceFlow("V1"));
    await deliver(dm("mid.1", "salom"));
    const first = run0();
    expect(first.versionId).toBe("ver_flow1_1");

    // v2 goes live (a real publish: retires v1, keeps its runs)
    db.seed("flowVersion", { id: "ver_flow1_2", flowId: "flow1", version: 2, graph: flowGraphDraftSchema.parse(choiceFlow("V2")), hash: "h2" });
    const flow = rows("flow")[0];
    flow.publishedVersionId = "ver_flow1_2";
    (rows("flowVersion")[0] as Row).retiredAt = new Date();

    await deliver(dm("mid.2", "Katalog", { quickReply: `fl:${first.id}:b:x` }));
    expect(dmSends()).toEqual(["V1 javob: katalog"]);

    await deliver(dm("mid.3", "salom", { sender: OTHER_USER }));
    const second = runs().find((r) => r.igUserId === OTHER_USER)!;
    expect(second.versionId).toBe("ver_flow1_2");
    await deliver(dm("mid.4", "Katalog", { sender: OTHER_USER, quickReply: `fl:${second.id}:b:x` }));
    expect(dmSends()).toEqual(["V1 javob: katalog", "V2 javob: katalog"]);
  });
});

// ─── Maintenance ──────────────────────────────────────────────────────────────

describe("maintenance sweep", () => {
  it("cancels WAITING runs of an unpublished flow and runs older than 7 days", async () => {
    seedFlow(choiceFlow());
    await deliver(dm("mid.1", "salom"));
    await deliver(dm("mid.2", "salom", { sender: OTHER_USER }));
    expect(runs().map((r) => r.status)).toEqual(["WAITING_TAP", "WAITING_TAP"]);

    (runs()[1] as Row).startedAt = new Date(Date.now() - 8 * 24 * 3600_000);
    expect(await sweepFlowRuns()).toMatchObject({ cancelledAge: 1, cancelledFlow: 0 });
    expect(runs()[1].status).toBe("CANCELLED");

    rows("flow")[0].status = "DRAFT"; // unpublished
    expect(await sweepFlowRuns()).toMatchObject({ cancelledFlow: 1 });
    expect(runs()[0]).toMatchObject({ status: "CANCELLED", endReason: FLOW_DELETED_REASON });
    expect(await flowOwnsThread("acc1", USER)).toBe(false);
  });

  it("continues a stuck ACTIVE run once, then fails it; old finished runs are deleted", async () => {
    seedFlow(choiceFlow());
    db.seed("flowRun", {
      id: "stuck1", workspaceId: "ws1", flowId: "flow1", versionId: "ver_flow1_1", instagramAccountId: "acc1", igUserId: USER,
      eventId: "e1", status: "ACTIVE", currentNodeId: "b", variables: { __stuck: 1 },
    });
    (rows("flowRun")[0] as Row).updatedAt = new Date(Date.now() - 20 * 60_000);
    db.seed("flowRun", {
      id: "old1", workspaceId: "ws1", flowId: "flow1", versionId: "ver_flow1_1", instagramAccountId: "acc1", igUserId: OTHER_USER,
      eventId: "e2", status: "DONE", finishedAt: new Date(Date.now() - 100 * 24 * 3600_000),
    });
    const swept = await sweepFlowRuns();
    expect(swept).toMatchObject({ stuck: 1, deleted: 1 });
    expect(rows("flowRun")).toHaveLength(1);
    expect(rows("flowRun")[0]).toMatchObject({ id: "stuck1", status: "FAILED", endReason: STUCK_REASON });
  });
});
