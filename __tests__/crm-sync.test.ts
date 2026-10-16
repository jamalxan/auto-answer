/**
 * ETAP 5.0 — backfill from the four stores, the cursor reconciler, the
 * hook → worker path (applyCrmTouch), hook safety with Redis down and the
 * CRM_DISABLED kill switch. In-memory database.
 */

import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const queueMock = vi.hoisted(() => ({
  enqueueCrmTouch: vi.fn(async () => {
    throw new Error("ECONNREFUSED 127.0.0.1:6379");
  }),
  enqueueCrmBackfill: vi.fn(async () => {}),
}));

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("../lib/telegram/notify", () => ({ notifyWorkspaceChats: vi.fn(async () => 1), alertWorkspace: vi.fn(async () => {}) }));
vi.mock("../lib/email", () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock("../lib/crm/queue", async (original) => {
  const actual = await original<typeof import("../lib/crm/queue")>();
  return {
    ...actual,
    enqueueCrmTouch: queueMock.enqueueCrmTouch,
    enqueueCrmBackfill: queueMock.enqueueCrmBackfill,
    // Pretend Redis is configured so the hook actually tries to enqueue.
    hasCrmQueueBackend: () => actual.isCrmEnabled(),
  };
});

import { runBackfill } from "../lib/crm/backfill";
import { clearCrmListeners, crmTouch, registerCrmListener, type CrmEvent } from "../lib/crm/hooks";
import { applyCrmTouch, RECONCILE_LAG_MS, RECONCILE_SOURCES, runCrmReconcile } from "../lib/crm/sync";
import { resetCrmMaintenanceForTests, runCrmMaintenance } from "../lib/crm/worker";
import { db, resetDb } from "./helpers/db-instance";

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 16, 12, minutes));
const now = () => at(60);

function seedWorld() {
  db.seed("workspace", { id: "w1", ownerId: "owner" });
  db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "shop", instagramId: "ig1" });
  db.seed("user", { id: "user1", email: "op@x.uz" });
  db.seed("workspaceMember", { id: "m1", workspaceId: "w1", userId: "user1", role: "OPERATOR" });
}

/** One person per store: u1 trigger contact, u2 conversation (+ AI state), u3 lead, u4 DmLog only. */
function seedStores() {
  db.seed("instagramContact", { id: "ic1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "u1", username: "one", phone: "+998900000001", source: "STORY_REPLY", firstInteractionAt: at(0), lastInteractionAt: at(5), interactionCount: 3 });
  db.seed("conversation", { id: "c2", workspaceId: "w1", instagramAccountId: "a1", igUserId: "u2", igUsername: "two", igName: "Two", collected: { phone_e164: "+998900000002", language: "uz" }, lastCustomerMessageAt: at(10), lastBotMessageAt: at(11), source: "CAMPAIGN", createdAt: at(9) });
  db.seed("aiConversationState", { id: "s2", conversationId: "c2", score: 65, temperature: "HOT" });
  db.seed("conversation", { id: "c3", workspaceId: "w1", instagramAccountId: "a1", igUserId: "u3", igUsername: "three" });
  db.seed("lead", { id: "l3", workspaceId: "w1", instagramAccountId: "a1", conversationId: "c3", igUserId: "u3", igUsername: "three", name: "Three", phoneE164: "+998900000003", idempotencyKey: "c3:0", createdAt: at(20) });
  db.seed("automation", { id: "auto1", workspaceId: "w1", instagramAccountId: "a1", name: "Eski" });
  db.seed("dmLog", { id: "dm4", workspaceId: "w1", automationId: "auto1", instagramAccountId: "a1", commenterId: "u4", commenterName: "Four", commentText: "info", commentId: "cmt4", status: "SENT", dmSentAt: at(31), createdAt: at(30) });
}

const contacts = () => db.rows("crmContact").sort((a, b) => String(a.igUserId).localeCompare(String(b.igUserId)));

/** Cursors as if the reconciler had been running since `since` (a fresh install seeds them at "now"). */
function seedCursors(since: Date) {
  for (const source of RECONCILE_SOURCES) db.seed("crmSyncCursor", { source, cursorAt: since, cursorId: null, createdAt: since });
}

beforeEach(() => {
  resetDb();
  clearCrmListeners();
  resetCrmMaintenanceForTests();
  vi.unstubAllEnvs();
  // The CRM is opt-in (CRM_ENABLED=1); every test here runs with it on.
  vi.stubEnv("CRM_ENABLED", "1");
  vi.clearAllMocks();
  seedWorld();
});

describe("runBackfill", () => {
  it("gives every person in the four stores one contact and every lead one deal", async () => {
    seedStores();
    const seen: CrmEvent[] = [];
    registerCrmListener((e) => void seen.push(e));
    db.rows("lead")[0].contactedAt = at(22);
    const counts = await runBackfill("w1", { log: false });
    // History is silent: no lead_created (ON_LEAD / Telegram), no stage / score events.
    expect(seen).toEqual([]);
    expect(db.rows("crmActivity").map((a) => a.type)).toContain("STAGE_CHANGED");
    expect(counts).toEqual({ instagramContacts: 1, conversations: 2, leads: 1, dmLogs: 1, contacts: 4, deals: 1 });
    const [u1, u2, u3, u4] = contacts();
    expect(u1).toMatchObject({ igUserId: "u1", username: "one", phoneE164: "+998900000001", source: "STORY", instagramContactId: "ic1", interactionCount: 3, firstInteractionAt: at(0), lastInteractionAt: at(5), lastInboundAt: null });
    expect(u2).toMatchObject({ igUserId: "u2", username: "two", name: "Two", phoneE164: "+998900000002", language: "uz", source: "COMMENT", conversationId: "c2", lastInboundAt: at(10), lastOutboundAt: at(11), score: 65, temperature: "HOT", hasAiState: true });
    expect(u3).toMatchObject({ igUserId: "u3", name: "Three", status: "ACTIVE", conversationId: "c3" });
    expect(u4).toMatchObject({ igUserId: "u4", name: "Four", source: "COMMENT", lastInteractionAt: at(31), lastOutboundAt: at(31), lastInboundAt: null });
    expect(db.rows("crmDeal")[0]).toMatchObject({ leadId: "l3" });

    // Re-running adds nothing.
    const again = await runBackfill(null, { log: false });
    expect(again.contacts).toBe(4);
    expect(db.rows("crmContact")).toHaveLength(4);
    expect(db.rows("crmDeal")).toHaveLength(1);
    expect(db.rows("crmActivity").filter((a) => a.type === "LEAD_CREATED")).toHaveLength(1);
  });
});

describe("requestBackfill (the Backfill button)", () => {
  it("queues the import for the worker (202 path), and refuses with 409 while the CRM is off", async () => {
    const { requestBackfill, CRM_DISABLED_MESSAGE } = await import("../lib/crm/service");
    seedStores();
    expect(await requestBackfill("w1", "user1")).toEqual({ ok: true, data: { queued: true } });
    expect(queueMock.enqueueCrmBackfill).toHaveBeenCalledWith({ workspaceId: "w1", requestedBy: "user1" });
    // Nothing ran inside the request.
    expect(db.rows("crmContact")).toHaveLength(0);

    vi.stubEnv("CRM_ENABLED", "");
    expect(await requestBackfill("w1", "user1")).toEqual({ ok: false, status: 409, error: CRM_DISABLED_MESSAGE });
    expect(queueMock.enqueueCrmBackfill).toHaveBeenCalledTimes(1);
  });
});

describe("runCrmReconcile", () => {
  it("advances a cursor per source, syncs every store and is idempotent on rerun", async () => {
    seedStores();
    db.seed("instagramEvent", { id: "ev1", workspaceId: "w1", instagramAccountId: "a1", eventType: "DIRECT_MESSAGE", senderId: "u5", senderUsername: "five", messageId: "m5", timestamp: at(40), rawPayload: {}, createdAt: at(40) });
    db.seed("triggerCampaign", { id: "camp1", workspaceId: "w1", instagramAccountId: "a1", name: "Post" });
    db.seed("triggerExecution", { id: "te1", workspaceId: "w1", eventId: "ev1", campaignId: "camp1", status: "SENT", responseText: "ok", sentAt: at(41), updatedAt: at(41) });
    db.seed("aiHandoff", { id: "h2", conversationId: "c2", reason: "score", status: "ACCEPTED", openedAt: at(12), acceptedAt: at(13), acceptedBy: "echo" });
    db.seed("integration", { id: "int1", workspaceId: "w1", type: "TELEGRAM", name: "Telegram" });
    db.seed("leadDelivery", { id: "ld3", leadId: "l3", integrationId: "int1", status: "SENT", sentAt: at(21) });
    db.rows("lead")[0].contactedAt = at(22);
    for (const c of db.rows("conversation")) c.updatedAt = at(9);
    db.rows("aiConversationState")[0].updatedAt = at(11);
    seedCursors(at(-1));

    const seen: CrmEvent[] = [];
    registerCrmListener((e) => void seen.push(e));

    const counts = await runCrmReconcile({ now: now() });
    expect(counts).toEqual({ instagramEvent: 1, conversation: 2, lead: 1, leadRescan: 1, triggerExecution: 1, aiHandoff: 1, aiState: 1, dmLog: 1 });
    expect(db.rows("crmSyncCursor").map((c) => c.source).sort()).toEqual([...RECONCILE_SOURCES].sort());
    expect(db.rows("crmSyncCursor").find((c) => c.source === "instagramEvent")).toMatchObject({ cursorAt: at(40), cursorId: "ev1" });

    const byUser = Object.fromEntries(contacts().map((c) => [c.igUserId as string, c]));
    expect(Object.keys(byUser).sort()).toEqual(["u2", "u3", "u4", "u5"]); // u1 has no event row: backfill's job
    expect(byUser.u5).toMatchObject({ username: "five", source: "DM", lastInboundAt: at(40), lastOutboundAt: at(41), interactionCount: 2 });
    expect(byUser.u2).toMatchObject({ score: 65, temperature: "HOT", hasAiState: true });
    const types = db.rows("crmActivity").map((a) => a.type).sort();
    expect(types).toEqual(["DEAL_CREATED", "HANDOFF_ACCEPTED", "HANDOFF_OPENED", "LEAD_CREATED", "LEAD_DELIVERED", "SCORE_CHANGED", "STAGE_CHANGED", "TEMPERATURE_CHANGED"]);
    expect(db.rows("crmDeal")[0].stageId).toBe(db.rows("crmStage").find((s) => s.name === "Bog'lanildi")!.id);
    // Deal / handoff / score writes are silent in the reconciler (listeners fire from the hooks); new interactions still reach them.
    expect(seen.map((e) => e.kind).sort()).toEqual(["interaction", "interaction", "interaction"]);

    // Rerun: cursors are past everything (the 30-day rescans re-read their window), nothing is written twice.
    const activities = db.rows("crmActivity").length;
    const events = seen.length;
    const second = await runCrmReconcile({ now: now() });
    expect(second).toMatchObject({ instagramEvent: 0, conversation: 0, lead: 0, triggerExecution: 0, aiState: 0, dmLog: 0 });
    expect(db.rows("crmActivity")).toHaveLength(activities);
    expect(db.rows("crmContact")).toHaveLength(4);
    expect(db.rows("crmDeal")).toHaveLength(1);
    expect(seen).toHaveLength(events);

    // A later event moves only its own cursor.
    db.seed("instagramEvent", { id: "ev2", workspaceId: "w1", instagramAccountId: "a1", eventType: "COMMENT", senderId: "u5", messageId: "cmt2", timestamp: at(50), rawPayload: {}, createdAt: at(50) });
    const third = await runCrmReconcile({ now: now(), sources: ["instagramEvent"] });
    expect(third.instagramEvent).toBe(1);
    expect(db.rows("crmSyncCursor").find((c) => c.source === "instagramEvent")).toMatchObject({ cursorId: "ev2" });
    const u5 = contacts().find((c) => c.igUserId === "u5")!;
    expect(u5.lastInteractionAt).toEqual(at(50));
    expect(u5.lastInboundAt).toEqual(at(40)); // a comment is not a window anchor
  });
});

describe("runCrmReconcile — first run, lag and history", () => {
  it("seeds every missing cursor at now − 60s and imports no history; later rows are picked up after the lag", async () => {
    seedStores();
    db.seed("instagramEvent", { id: "ev_old", workspaceId: "w1", instagramAccountId: "a1", eventType: "DIRECT_MESSAGE", senderId: "u5", messageId: "m_old", timestamp: at(40), rawPayload: {}, createdAt: at(40) });
    for (const c of db.rows("conversation")) c.updatedAt = at(9);
    db.rows("aiConversationState")[0].updatedAt = at(11);
    db.seed("aiHandoff", { id: "h_old", conversationId: "c2", reason: "score", status: "OPEN", openedAt: at(12) });
    db.rows("lead")[0].contactedAt = at(22);

    const first = await runCrmReconcile({ now: now() });
    expect(Object.values(first).every((n) => n === 0)).toBe(true);
    expect(db.rows("crmContact")).toHaveLength(0);
    expect(db.rows("crmDeal")).toHaveLength(0);
    const bound = new Date(now().getTime() - RECONCILE_LAG_MS);
    expect(db.rows("crmSyncCursor")).toHaveLength(RECONCILE_SOURCES.length);
    expect(db.rows("crmSyncCursor").every((c) => (c.cursorAt as Date).getTime() === bound.getTime() && (c.createdAt as Date).getTime() === bound.getTime())).toBe(true);

    // The 30-day rescans stay at the seed too (no history on the second run either).
    await runCrmReconcile({ now: new Date(now().getTime() + 5 * 60_000) });
    expect(db.rows("crmDeal")).toHaveLength(0);
    expect(db.rows("crmActivity")).toHaveLength(0);

    // A new event is picked up, but only once it is older than the lag.
    const t = new Date(now().getTime() + 6 * 60_000);
    db.seed("instagramEvent", { id: "ev_new", workspaceId: "w1", instagramAccountId: "a1", eventType: "DIRECT_MESSAGE", senderId: "u9", messageId: "m_new", timestamp: t, rawPayload: {}, createdAt: t });
    expect((await runCrmReconcile({ now: new Date(t.getTime() + 30_000), sources: ["instagramEvent"] })).instagramEvent).toBe(0);
    expect((await runCrmReconcile({ now: new Date(t.getTime() + RECONCILE_LAG_MS), sources: ["instagramEvent"] })).instagramEvent).toBe(1);
    expect(contacts().map((c) => c.igUserId)).toEqual(["u9"]);
  });

  it("stop -> manual opt-in -> operator reply -> reconcile: the contact stays opted in", async () => {
    const { onCrmEventForBroadcast, setOptOut } = await import("../lib/crm/broadcast");
    clearCrmListeners();
    registerCrmListener(onCrmEventForBroadcast);
    seedStores();
    seedCursors(at(-1));
    const c2 = db.rows("conversation").find((c) => c.id === "c2")!;
    db.seed("conversationMessage", { conversationId: "c2", author: "CUSTOMER", text: "stop", mid: "m_stop", createdAt: at(10) });
    c2.lastCustomerMessageAt = at(10);
    c2.updatedAt = at(10);

    await applyCrmTouch({ kind: "inbound", conversationId: "c2", at: at(10) });
    const contact = () => db.rows("crmContact").find((c) => c.conversationId === "c2")!;
    expect(contact().optedOutAt).toEqual(at(10));

    expect((await setOptOut("w1", contact().id as string, false)).ok).toBe(true);
    db.seed("conversationMessage", { conversationId: "c2", author: "OPERATOR", text: "Yaxshi, yozib qo'ydim", mid: "m_op", createdAt: at(12) });
    c2.lastBotMessageAt = at(12);
    c2.updatedAt = at(12);
    await applyCrmTouch({ kind: "operator_reply", conversationId: "c2", userId: "user1", at: at(12) });

    await runCrmReconcile({ now: now() });
    await runCrmReconcile({ now: now() });
    expect(contact().optedOutAt).toBeNull();
    expect(db.rows("crmActivity").filter((a) => a.type === "OPT_OUT")).toHaveLength(1);
  });
});

describe("applyCrmTouch", () => {
  it("inbound / operator / AI replies update the contact; the operator's member id reaches listeners", async () => {
    seedStores();
    const seen: CrmEvent[] = [];
    registerCrmListener((e) => void seen.push(e));
    await applyCrmTouch({ kind: "inbound", conversationId: "c2", at: at(15) });
    await applyCrmTouch({ kind: "operator_reply", conversationId: "c2", userId: "user1", at: at(16) });
    await applyCrmTouch({ kind: "ai_reply", conversationId: "c2", at: at(17) });
    await applyCrmTouch({ kind: "inbound", workspaceId: "w1", instagramAccountId: "a1", igUserId: "u7", at: at(18) });
    const u2 = contacts().find((c) => c.igUserId === "u2")!;
    expect(u2).toMatchObject({ lastInboundAt: at(15), lastOutboundAt: at(17), interactionCount: 3, score: 65, hasAiState: true });
    expect(contacts().find((c) => c.igUserId === "u7")).toMatchObject({ workspaceId: "w1", lastInboundAt: at(18) });
    const operator = seen.find((e) => e.kind === "interaction" && e.via === "operator_reply");
    expect(operator).toMatchObject({ direction: "outbound", memberId: "m1" });
    await expect(applyCrmTouch({ kind: "inbound", conversationId: "missing" })).resolves.toBeUndefined();
  });

  it("trigger interactions, leads, contacted, handoffs and scores", async () => {
    seedStores();
    db.seed("aiHandoff", { id: "h2", conversationId: "c2", reason: "keyword", status: "OPEN", openedAt: at(12) });
    await applyCrmTouch({ kind: "trigger_interaction", instagramContactId: "ic1", at: at(6), payload: { eventType: "COMMENT" } });
    await applyCrmTouch({ kind: "trigger_interaction", instagramContactId: "ic1", at: at(7), payload: { eventType: "STORY_REPLY" } });
    await applyCrmTouch({ kind: "lead_created", leadId: "l3" });
    await applyCrmTouch({ kind: "lead_contacted", leadId: "l3", userId: "user1" });
    await applyCrmTouch({ kind: "handoff", conversationId: "c2" });
    await applyCrmTouch({ kind: "score", aiStateId: "s2" });
    const u1 = contacts().find((c) => c.igUserId === "u1")!;
    expect(u1).toMatchObject({ instagramContactId: "ic1", phoneE164: "+998900000001", lastInteractionAt: at(7), lastInboundAt: at(7), interactionCount: 2 });
    expect(db.rows("crmDeal")[0]).toMatchObject({ leadId: "l3" });
    expect(db.rows("crmActivity").find((a) => a.type === "STAGE_CHANGED")).toMatchObject({ actorMemberId: "m1" });
    expect(db.rows("crmActivity").find((a) => a.type === "HANDOFF_OPENED")).toMatchObject({ sourceId: "h2:opened", body: "keyword" });
    expect(contacts().find((c) => c.igUserId === "u2")).toMatchObject({ score: 65, temperature: "HOT", hasAiState: true });
  });
});

describe("crmTouch (the hook)", () => {
  it("never throws when Redis is down", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(crmTouch({ kind: "inbound", conversationId: "c1" })).resolves.toBeUndefined();
    expect(queueMock.enqueueCrmTouch).toHaveBeenCalledTimes(1);
    expect((queueMock.enqueueCrmTouch.mock.calls[0] as unknown[])[0]).toMatchObject({ kind: "inbound", conversationId: "c1", at: expect.any(Date) });
    expect(error).toHaveBeenCalled();
    error.mockRestore();
  });

  it("CRM_DISABLED=1: hooks and the worker's maintenance are no-ops", async () => {
    vi.stubEnv("CRM_DISABLED", "1");
    seedStores();
    await crmTouch({ kind: "inbound", conversationId: "c2" });
    expect(queueMock.enqueueCrmTouch).not.toHaveBeenCalled();
    await runCrmMaintenance({ force: true, now: now() });
    expect(db.rows("crmSyncCursor")).toHaveLength(0);
    expect(db.rows("crmContact")).toHaveLength(0);
  });

  it("without CRM_ENABLED the CRM is off by default (opt-in)", async () => {
    vi.stubEnv("CRM_ENABLED", "");
    seedStores();
    await crmTouch({ kind: "inbound", conversationId: "c2" });
    expect(queueMock.enqueueCrmTouch).not.toHaveBeenCalled();
    await runCrmMaintenance({ force: true, now: now() });
    expect(db.rows("crmSyncCursor")).toHaveLength(0);
    expect(db.rows("crmContact")).toHaveLength(0);
  });

  it("CRM_DISABLED=1 wins over CRM_ENABLED=1", async () => {
    vi.stubEnv("CRM_DISABLED", "1");
    const { isCrmEnabled } = await import("../lib/crm/queue");
    expect(isCrmEnabled()).toBe(false);
    vi.stubEnv("CRM_DISABLED", "");
    expect(isCrmEnabled()).toBe(true);
  });

  it("runCrmMaintenance reconciles every 5 minutes, not on every tick", async () => {
    seedStores();
    await runCrmMaintenance({ now: at(0) });
    expect(db.rows("crmSyncCursor").length).toBeGreaterThan(0);
    db.seed("dmLog", { id: "dm5", workspaceId: "w1", automationId: "auto1", instagramAccountId: "a1", commenterId: "u8", commentText: "x", commentId: "cmt8", createdAt: at(2) });
    await runCrmMaintenance({ now: at(1) });
    expect(db.rows("crmContact").some((c) => c.igUserId === "u8")).toBe(false);
    await runCrmMaintenance({ now: at(6) });
    expect(db.rows("crmContact").some((c) => c.igUserId === "u8")).toBe(true);
  });
});

describe("engine hook sites", () => {
  const count = (file: string) => (readFileSync(new URL(`../${file}`, import.meta.url), "utf8").match(/crmTouch\(/g) ?? []).length;

  it("are present where the design puts them", () => {
    expect(count("lib/assistant/engine.ts")).toBe(4); // inbound stored, echo, inbox reply, AI reply delivered
    expect(count("lib/leads/service.ts")).toBe(1);
    expect(count("lib/telegram/bot.ts")).toBeGreaterThanOrEqual(1);
    expect(count("lib/javobai/handoff.ts")).toBe(3);
    expect(count("lib/javobai/state.ts")).toBe(1);
    expect(count("lib/javobai/leads.ts")).toBe(1);
    expect(count("lib/triggers/contacts.ts")).toBe(1);
  });
});
