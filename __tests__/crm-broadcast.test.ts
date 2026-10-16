/**
 * ETAP 5.4 — broadcast engine against the in-memory database: the design's
 * three-recipient scenario (1h ago / 2 days ago / opted out → one DM, two
 * reasons), active handoff skipped, batch lease + rate-limit requeue + stale
 * SENDING → FAILED, pause, reply / conversion attribution, the opt-out
 * listener and the SYSTEM ConversationMessage that keeps handleEcho honest.
 */

import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  sendDirectMessage: vi.fn(),
  sendDirectMessageWithQuickReplies: vi.fn(),
  markTokenBroken: vi.fn(),
  reserveWorkspaceDMSend: vi.fn(),
  releaseWorkspaceDMReservation: vi.fn(),
  reserveDMSlot: vi.fn(),
  enqueueBroadcastStart: vi.fn(),
  enqueueBroadcastBatch: vi.fn(),
  removeBroadcastJobs: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  sendDirectMessage: mocks.sendDirectMessage,
  sendDirectMessageWithQuickReplies: mocks.sendDirectMessageWithQuickReplies,
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (value: string) => `plain:${value}` }));
vi.mock("@/lib/meta/token-health", () => ({ markTokenBroken: mocks.markTokenBroken }));
vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mocks.reserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mocks.releaseWorkspaceDMReservation,
}));
vi.mock("@/lib/utils/rate-limiter", () => ({ reserveDMSlot: mocks.reserveDMSlot }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: vi.fn() }));
vi.mock("@/lib/crm/broadcast-queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/crm/broadcast-queue")>()),
  enqueueBroadcastStart: mocks.enqueueBroadcastStart,
  enqueueBroadcastBatch: mocks.enqueueBroadcastBatch,
  removeBroadcastJobs: mocks.removeBroadcastJobs,
}));

import {
  attributeConversion,
  attributeReply,
  broadcastInputSchema,
  cancelBroadcast,
  createBroadcast,
  getBroadcast,
  listRecipients,
  onBroadcastInbound,
  onCrmEventForBroadcast,
  pauseBroadcast,
  previewAudience,
  renderBroadcastMessage,
  resumeBroadcast,
  runBroadcastBatch,
  runBroadcastMaintenance,
  scheduleBroadcast,
  setOptOut,
  STALE_SENDING_ERROR,
  startBroadcast,
} from "@/lib/crm/broadcast";
import { BROADCAST_BATCH_INTERVAL_MS } from "@/lib/crm/broadcast-queue";
import { TRIGGER_RATE_LIMIT_BACKOFF_MS } from "@/lib/triggers/queue";
import { INELIGIBILITY_LABELS } from "@/lib/crm/types";

type Row = Record<string, unknown>;
const rows = (model: string) => db.rows(model) as Row[];

const WS = "ws1";
const ACCOUNT = "acc1";
const IG_ID = "17841400000000001";
// Anchored to the current hour: attribution windows are measured from the real send time.
const NOW = new Date(Math.floor(Date.now() / 3600_000) * 3600_000);
const hoursAgo = (h: number) => new Date(NOW.getTime() - h * 3600_000);
const daysAgo = (d: number) => hoursAgo(d * 24);

let mid = 0;

function seedWorkspace() {
  db.seed("workspace", { id: WS, name: "Test", ownerId: "u1", isSuspended: false });
  db.seed("instagramAccount", { id: ACCOUNT, workspaceId: WS, instagramId: IG_ID, username: "shop", accessToken: "enc", tokenStatus: "ACTIVE" });
}

function seedContact(id: string, overrides: Row = {}) {
  return db.seed("crmContact", {
    id,
    workspaceId: WS,
    instagramAccountId: ACCOUNT,
    igUserId: `ig_${id}`,
    username: `user_${id}`,
    name: null,
    conversationId: null,
    lastInboundAt: hoursAgo(1),
    optedOutAt: null,
    mergedIntoId: null,
    status: "ACTIVE",
    score: 0,
    temperature: "COLD",
    customFields: {},
    ...overrides,
  });
}

async function makeBroadcast(input: Row = {}) {
  const created = await createBroadcast(
    WS,
    broadcastInputSchema.parse({ name: "Aksiya", instagramAccountId: ACCOUNT, message: "Salom {ism}! Bugun chegirma.", ...input }),
    "u1",
    NOW
  );
  if (!created.ok) throw new Error(created.error);
  return created.data;
}

async function scheduleAndStart(input: Row = {}) {
  const view = await makeBroadcast(input);
  const scheduled = await scheduleBroadcast(WS, view.id, {}, NOW);
  if (!scheduled.ok) throw new Error(scheduled.error);
  const started = await startBroadcast(view.id, NOW);
  return { id: view.id, started };
}

beforeEach(() => {
  resetDb();
  // The CRM is opt-in: broadcast maintenance only runs with CRM_ENABLED=1.
  process.env.CRM_ENABLED = "1";
  vi.clearAllMocks();
  seedWorkspace();
  mocks.sendDirectMessage.mockImplementation(async () => ({ recipient_id: "r", message_id: `m_${++mid}` }));
  mocks.sendDirectMessageWithQuickReplies.mockImplementation(async () => ({ recipient_id: "r", message_id: `m_${++mid}` }));
  mocks.reserveWorkspaceDMSend.mockResolvedValue({ allowed: true, periodStart: NOW });
  mocks.reserveDMSlot.mockResolvedValue({ allowed: true, currentCount: 1 });
  mocks.releaseWorkspaceDMReservation.mockResolvedValue(undefined);
  mocks.removeBroadcastJobs.mockResolvedValue(0);
});

describe("createBroadcast / schema", () => {
  it("rejects a message over 1000 chars, more than 13 quick replies, a 21-char chip, a 0 throttle", () => {
    const base = { name: "A", instagramAccountId: ACCOUNT, message: "hi" };
    expect(broadcastInputSchema.safeParse({ ...base, message: "x".repeat(1001) }).success).toBe(false);
    expect(broadcastInputSchema.safeParse({ ...base, quickReplies: Array.from({ length: 14 }, (_, i) => `q${i}`) }).success).toBe(false);
    expect(broadcastInputSchema.safeParse({ ...base, quickReplies: ["x".repeat(21)] }).success).toBe(false);
    expect(broadcastInputSchema.safeParse({ ...base, throttlePerHour: 0 }).success).toBe(false);
    expect(broadcastInputSchema.safeParse({ ...base, throttlePerHour: 501 }).success).toBe(false);
    expect(broadcastInputSchema.safeParse({ ...base, quickReplies: ["Ha", "Yo'q"], throttlePerHour: 50 }).success).toBe(true);
  });

  it("creates a DRAFT with defaults, 404 on a foreign account or segment, 422 on a past schedule", async () => {
    const view = await makeBroadcast();
    expect(view.status).toBe("DRAFT");
    expect(view.throttlePerHour).toBe(100);
    expect(view.frequencyCapHours).toBe(24);
    expect(view.replyWindowHours).toBe(48);
    expect(view.conversionWindowDays).toBe(7);
    expect(view.accountUsername).toBe("shop");
    expect(view.counters).toEqual({ total: 0, eligible: 0, sent: 0, skipped: 0, failed: 0, replied: 0, converted: 0, pending: 0 });

    const foreign = await createBroadcast(WS, broadcastInputSchema.parse({ name: "A", instagramAccountId: "other", message: "hi" }), null, NOW);
    expect(foreign).toMatchObject({ ok: false, status: 404 });
    const noSegment = await createBroadcast(WS, broadcastInputSchema.parse({ name: "A", instagramAccountId: ACCOUNT, segmentId: "nope", message: "hi" }), null, NOW);
    expect(noSegment).toMatchObject({ ok: false, status: 404 });
    const past = await createBroadcast(
      WS,
      broadcastInputSchema.parse({ name: "A", instagramAccountId: ACCOUNT, message: "hi", scheduledAt: hoursAgo(2).toISOString() }),
      null,
      NOW
    );
    expect(past).toMatchObject({ ok: false, status: 422 });
  });

  it("takes the segment's filter as the audience snapshot", async () => {
    db.seed("crmSegment", { id: "seg1", workspaceId: WS, name: "Hot", filter: { v: 1, all: [{ field: "opted_out", op: "is_false" }] } });
    const view = await makeBroadcast({ segmentId: "seg1" });
    expect(view.segmentId).toBe("seg1");
    expect(view.segmentName).toBe("Hot");
    expect(view.audienceFilter).toEqual({ v: 1, all: [{ field: "opted_out", op: "is_false" }] });
  });

  it("renders {ism} with the name, then the username, then nothing", () => {
    expect(renderBroadcastMessage("Salom {ism}!", { name: "Ali", username: "ali" })).toBe("Salom Ali!");
    expect(renderBroadcastMessage("Salom {ism}!", { name: null, username: "ali" })).toBe("Salom @ali!");
    expect(renderBroadcastMessage("Salom {ism}!", { name: null, username: null })).toBe("Salom!");
  });
});

describe("design scenario: three recipients", () => {
  beforeEach(() => {
    seedContact("c_fresh", { lastInboundAt: hoursAgo(1), name: "Ali", conversationId: "conv1" });
    seedContact("c_old", { lastInboundAt: daysAgo(2) });
    seedContact("c_out", { lastInboundAt: hoursAgo(1), optedOutAt: daysAgo(1) });
    db.seed("conversation", { id: "conv1", workspaceId: WS, instagramAccountId: ACCOUNT, igUserId: "ig_c_fresh" });
  });

  it("preview shows one eligible and the two reasons with Uzbek labels", async () => {
    const preview = await previewAudience(WS, { instagramAccountId: ACCOUNT }, NOW);
    expect(preview.ok).toBe(true);
    if (!preview.ok) return;
    expect(preview.data.total).toBe(3);
    expect(preview.data.eligibleNow).toBe(1);
    expect(preview.data.byReason).toEqual([
      { reason: "WINDOW_CLOSED", label: INELIGIBILITY_LABELS.WINDOW_CLOSED, count: 1 },
      { reason: "OPTED_OUT", label: INELIGIBILITY_LABELS.OPTED_OUT, count: 1 },
    ]);
    expect(preview.data.sample.map((s) => [s.contactId, s.reason])).toEqual([
      ["c_fresh", null],
      ["c_old", "WINDOW_CLOSED"],
      ["c_out", "OPTED_OUT"],
    ]);
  });

  it("sends exactly one DM, skips two with reasons, stores the SYSTEM message with broadcastId", async () => {
    const { id, started } = await scheduleAndStart();
    expect(started).toEqual({ started: true, total: 3, eligible: 1, skipped: 2 });
    expect(mocks.enqueueBroadcastStart).toHaveBeenCalledWith(id, 0, NOW);
    // The first tick of the chain: tick number 1 on the row, job bcb_<id>_1.
    expect(mocks.enqueueBroadcastBatch).toHaveBeenCalledWith(id, 0, 1);
    expect(rows("crmBroadcast").find((r) => r.id === id)).toMatchObject({ tickSeq: 1, nextTickAt: NOW });

    const batch = await runBroadcastBatch(id, NOW);
    expect(batch).toMatchObject({ outcome: "completed", sent: 1, skipped: 0, failed: 0, remaining: 0 });
    expect(mocks.sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendDirectMessage).toHaveBeenCalledWith("plain:enc", IG_ID, "ig_c_fresh", "Salom Ali! Bugun chegirma.");

    const view = await getBroadcast(WS, id);
    expect(view.ok && view.data.status).toBe("COMPLETED");
    expect(view.ok && view.data.counters).toMatchObject({ total: 3, eligible: 1, sent: 1, skipped: 2, failed: 0 });

    const page = await listRecipients(WS, id);
    expect(page.ok).toBe(true);
    if (!page.ok) return;
    const byContact = Object.fromEntries(page.data.recipients.map((r) => [r.contactId, r]));
    expect(byContact.c_fresh).toMatchObject({ status: "SENT", eligible: true, reason: null, sentAt: expect.any(Date) });
    expect(byContact.c_old).toMatchObject({ status: "SKIPPED", reason: "WINDOW_CLOSED", reasonLabel: "24 soatlik oyna yopilgan" });
    expect(byContact.c_out).toMatchObject({ status: "SKIPPED", reason: "OPTED_OUT", reasonLabel: "Obunadan chiqqan" });
    expect(page.data.byReason).toEqual([
      { reason: "WINDOW_CLOSED", label: INELIGIBILITY_LABELS.WINDOW_CLOSED, count: 1 },
      { reason: "OPTED_OUT", label: INELIGIBILITY_LABELS.OPTED_OUT, count: 1 },
    ]);

    // handleEcho's known-mid check: our own send is stored as SYSTEM with the broadcast id.
    const stored = rows("conversationMessage");
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ conversationId: "conv1", author: "SYSTEM", mid: "m_1", llmMeta: { broadcastId: id } });

    const activities = rows("crmActivity").map((a) => [a.contactId, a.type]);
    expect(activities).toEqual(expect.arrayContaining([
      ["c_fresh", "BROADCAST_SENT"],
      ["c_old", "BROADCAST_SKIPPED"],
      ["c_out", "BROADCAST_SKIPPED"],
    ]));
    expect(rows("crmContact").find((c) => c.id === "c_fresh")?.lastOutboundAt).toBeInstanceOf(Date);
  });

  it("uses quick replies when configured (MESSAGE-only chips)", async () => {
    const { id } = await scheduleAndStart({ quickReplies: ["Ha", "Yo'q"] });
    await runBroadcastBatch(id, NOW);
    expect(mocks.sendDirectMessage).not.toHaveBeenCalled();
    expect(mocks.sendDirectMessageWithQuickReplies).toHaveBeenCalledTimes(1);
    const chips = mocks.sendDirectMessageWithQuickReplies.mock.calls[0][4];
    expect(chips).toEqual([
      { title: "Ha", payload: `crm_bc_${id}_0`, contentType: "text" },
      { title: "Yo'q", payload: `crm_bc_${id}_1`, contentType: "text" },
    ]);
  });
});

describe("eligibility at start and at send time", () => {
  it("skips a person in an active handoff (owner decision 2)", async () => {
    seedContact("c_handoff", { conversationId: "conv_h" });
    db.seed("conversation", { id: "conv_h", workspaceId: WS, instagramAccountId: ACCOUNT, igUserId: "ig_c_handoff" });
    db.seed("aiConversationState", { conversationId: "conv_h", handoffState: "OPERATOR_ACTIVE" });
    seedContact("c_pending", { conversationId: "conv_p" });
    db.seed("conversation", { id: "conv_p", workspaceId: WS, instagramAccountId: ACCOUNT, igUserId: "ig_c_pending" });
    db.seed("aiConversationState", { conversationId: "conv_p", handoffState: "HANDOFF_PENDING" });
    seedContact("c_ai", { conversationId: "conv_a" });
    db.seed("conversation", { id: "conv_a", workspaceId: WS, instagramAccountId: ACCOUNT, igUserId: "ig_c_ai" });
    db.seed("aiConversationState", { conversationId: "conv_a", handoffState: "AI_ACTIVE" });

    const { started } = await scheduleAndStart();
    expect(started).toMatchObject({ total: 3, eligible: 1, skipped: 2 });
    const reasons = rows("crmBroadcastRecipient").map((r) => [r.contactId, r.ineligibleReason]);
    expect(reasons).toEqual(expect.arrayContaining([
      ["c_handoff", "OPERATOR_ACTIVE"],
      ["c_pending", "OPERATOR_ACTIVE"],
      ["c_ai", null],
    ]));
    expect(rows("crmBroadcastRecipient").find((r) => r.contactId === "c_handoff")?.error).toBe("Operator bilan suhbatda");
  });

  it("applies the frequency cap against earlier broadcasts and re-evaluates at send time", async () => {
    seedContact("c1");
    seedContact("c2");
    // c2 got another broadcast 3 hours ago.
    db.seed("crmBroadcast", { id: "old", workspaceId: WS, instagramAccountId: ACCOUNT, name: "Old", status: "COMPLETED", audienceFilter: {}, message: "x" });
    db.seed("crmBroadcastRecipient", { broadcastId: "old", contactId: "c2", eligible: true, status: "SENT", sentAt: hoursAgo(3), eligibilitySnapshot: {} });

    const { id, started } = await scheduleAndStart();
    expect(started).toMatchObject({ eligible: 1, skipped: 1 });
    expect(rows("crmBroadcastRecipient").find((r) => r.broadcastId === id && r.contactId === "c2")?.ineligibleReason).toBe("FREQUENCY_CAP");

    // c1 opts out between start and the batch: skipped at send time, nothing sent.
    const c1 = rows("crmContact").find((c) => c.id === "c1")!;
    c1.optedOutAt = NOW;
    const batch = await runBroadcastBatch(id, NOW);
    expect(batch).toMatchObject({ outcome: "completed", sent: 0, skipped: 1 });
    expect(mocks.sendDirectMessage).not.toHaveBeenCalled();
    const view = await getBroadcast(WS, id);
    expect(view.ok && view.data.counters).toMatchObject({ sent: 0, skipped: 2, total: 2 });
  });

  it("a broken token marks everyone TOKEN_BROKEN and the schedule refuses", async () => {
    seedContact("c1");
    const account = rows("instagramAccount")[0];
    account.tokenStatus = "BROKEN";
    const view = await makeBroadcast();
    const scheduled = await scheduleBroadcast(WS, view.id, {}, NOW);
    expect(scheduled).toMatchObject({ ok: false, status: 422 });
    const preview = await previewAudience(WS, { broadcastId: view.id }, NOW);
    expect(preview.ok && preview.data.byReason).toEqual([{ reason: "TOKEN_BROKEN", label: INELIGIBILITY_LABELS.TOKEN_BROKEN, count: 1 }]);
  });

  it("completes immediately when nobody is eligible", async () => {
    seedContact("c_old", { lastInboundAt: daysAgo(3) });
    const { id, started } = await scheduleAndStart();
    expect(started).toMatchObject({ eligible: 0, skipped: 1 });
    const view = await getBroadcast(WS, id);
    expect(view.ok && view.data.status).toBe("COMPLETED");
    expect(mocks.enqueueBroadcastBatch).not.toHaveBeenCalled();
  });
});

describe("batches, leases and failures", () => {
  it("sends batchSize(throttle) per tick and schedules the next tick 5 minutes later", async () => {
    for (let i = 0; i < 5; i++) seedContact(`c${i}`);
    // 24/h → 2 per 5-minute tick.
    const { id } = await scheduleAndStart({ throttlePerHour: 24 });
    mocks.enqueueBroadcastBatch.mockClear();

    const first = await runBroadcastBatch(id, NOW);
    expect(first).toMatchObject({ outcome: "continue", sent: 2, remaining: 3 });
    expect(mocks.enqueueBroadcastBatch).toHaveBeenCalledWith(id, BROADCAST_BATCH_INTERVAL_MS, 2);
    const second = await runBroadcastBatch(id, NOW);
    expect(second).toMatchObject({ outcome: "continue", sent: 2, remaining: 1 });
    const third = await runBroadcastBatch(id, NOW);
    expect(third).toMatchObject({ outcome: "completed", sent: 1, remaining: 0 });
    expect(mocks.sendDirectMessage).toHaveBeenCalledTimes(5);
    expect(rows("crmBroadcastRecipient").every((r) => r.attempts === 1)).toBe(true);
  });

  it("rate limit: the recipient goes back to PENDING and the batch waits past the hour", async () => {
    seedContact("c1");
    seedContact("c2");
    const { id } = await scheduleAndStart();
    mocks.enqueueBroadcastBatch.mockClear();
    mocks.reserveDMSlot.mockResolvedValueOnce({ allowed: false, currentCount: 750 });

    const batch = await runBroadcastBatch(id, NOW);
    expect(batch).toMatchObject({ outcome: "rate_limited", sent: 0, requeued: 2, remaining: 2 });
    expect(mocks.sendDirectMessage).not.toHaveBeenCalled();
    expect(mocks.releaseWorkspaceDMReservation).toHaveBeenCalled();
    expect(mocks.enqueueBroadcastBatch).toHaveBeenCalledWith(id, TRIGGER_RATE_LIMIT_BACKOFF_MS, 2);
    expect(rows("crmBroadcast").find((r) => r.id === id)!.nextTickAt).toEqual(new Date(NOW.getTime() + TRIGGER_RATE_LIMIT_BACKOFF_MS));
    const recipients = rows("crmBroadcastRecipient").filter((r) => r.broadcastId === id);
    expect(recipients.every((r) => r.status === "PENDING" && r.attempts === 0)).toBe(true);
    const view = await getBroadcast(WS, id);
    expect(view.ok && view.data.status).toBe("RUNNING");
    expect(view.ok && view.data.lastError).toContain("Soatlik DM limiti");

    // Next tick sends both.
    const next = await runBroadcastBatch(id, NOW);
    expect(next).toMatchObject({ outcome: "completed", sent: 2 });
  });

  it("a monthly-quota denial is a FAILED recipient with the reason", async () => {
    seedContact("c1");
    const { id } = await scheduleAndStart();
    mocks.reserveWorkspaceDMSend.mockResolvedValueOnce({ allowed: false, reason: "limit" });
    const batch = await runBroadcastBatch(id, NOW);
    expect(batch).toMatchObject({ outcome: "completed", failed: 1 });
    const recipient = rows("crmBroadcastRecipient").find((r) => r.broadcastId === id)!;
    expect(recipient).toMatchObject({ status: "FAILED", error: "Oylik DM limiti tugagan." });
  });

  it("a retryable network error is retried on later ticks, then fails after 3 attempts", async () => {
    seedContact("c1");
    const { id } = await scheduleAndStart();
    mocks.sendDirectMessage.mockRejectedValue(new Error("fetch failed"));
    expect(await runBroadcastBatch(id, NOW)).toMatchObject({ outcome: "continue", requeued: 1 });
    expect(await runBroadcastBatch(id, NOW)).toMatchObject({ outcome: "continue", requeued: 1 });
    expect(await runBroadcastBatch(id, NOW)).toMatchObject({ outcome: "completed", failed: 1 });
    const recipient = rows("crmBroadcastRecipient").find((r) => r.broadcastId === id)!;
    expect(recipient.status).toBe("FAILED");
    expect(recipient.attempts).toBe(3);
  });

  it("a SENDING row older than 10 minutes becomes FAILED and is never resent", async () => {
    seedContact("c1");
    seedContact("c2");
    const { id } = await scheduleAndStart();
    const stuck = rows("crmBroadcastRecipient").find((r) => r.broadcastId === id && r.contactId === "c1")!;
    stuck.status = "SENDING";
    stuck.attempts = 1;
    stuck.updatedAt = new Date(NOW.getTime() - 11 * 60_000);

    const batch = await runBroadcastBatch(id, NOW);
    expect(batch).toMatchObject({ outcome: "completed", sent: 1, failed: 1 });
    expect(stuck).toMatchObject({ status: "FAILED", error: STALE_SENDING_ERROR });
    expect(mocks.sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendDirectMessage.mock.calls[0][2]).toBe("ig_c2");
  });

  it("a recent SENDING row (another worker) is left alone", async () => {
    seedContact("c1");
    const { id } = await scheduleAndStart();
    const busy = rows("crmBroadcastRecipient").find((r) => r.broadcastId === id)!;
    busy.status = "SENDING";
    busy.updatedAt = NOW;
    const batch = await runBroadcastBatch(id, NOW);
    expect(batch).toMatchObject({ outcome: "continue", sent: 0, failed: 0, remaining: 1 });
    expect(busy.status).toBe("SENDING");
  });
});

describe("pause / resume / cancel", () => {
  it("pause stops the next batch; resume sends", async () => {
    seedContact("c1");
    const { id } = await scheduleAndStart();
    const paused = await pauseBroadcast(WS, id);
    expect(paused.ok && paused.data.status).toBe("PAUSED");
    expect(mocks.removeBroadcastJobs).toHaveBeenCalledWith(id);

    const batch = await runBroadcastBatch(id, NOW);
    expect(batch).toMatchObject({ outcome: "stopped", sent: 0 });
    expect(mocks.sendDirectMessage).not.toHaveBeenCalled();

    mocks.enqueueBroadcastBatch.mockClear();
    const resumed = await resumeBroadcast(WS, id, NOW);
    expect(resumed.ok && resumed.data.status).toBe("RUNNING");
    expect(mocks.enqueueBroadcastBatch).toHaveBeenCalledWith(id, 0, 2);
    expect(await runBroadcastBatch(id, NOW)).toMatchObject({ outcome: "completed", sent: 1 });
  });

  it("pause -> resume while a tick is running leaves exactly one chain", async () => {
    for (let i = 0; i < 4; i++) seedContact(`c${i}`);
    const { id } = await scheduleAndStart({ throttlePerHour: 36 }); // 3 per tick
    const firstSeq = rows("crmBroadcast").find((r) => r.id === id)!.tickSeq as number;
    mocks.enqueueBroadcastBatch.mockClear();
    // During the first send the operator pauses and resumes: resume schedules tick firstSeq + 1.
    mocks.sendDirectMessage.mockImplementationOnce(async () => {
      await pauseBroadcast(WS, id);
      await resumeBroadcast(WS, id, NOW);
      return { recipient_id: "r", message_id: "m_x" };
    });
    const old = await runBroadcastBatch(id, NOW, firstSeq);
    // The old tick sees the newer number, hands its other leases back and schedules nothing.
    expect(old).toMatchObject({ outcome: "stopped", sent: 1, requeued: 2 });
    expect(mocks.enqueueBroadcastBatch).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueBroadcastBatch).toHaveBeenCalledWith(id, 0, firstSeq + 1);

    // A duplicate job of the old chain is a no-op; the new chain delivers the rest.
    expect(await runBroadcastBatch(id, NOW, firstSeq)).toMatchObject({ outcome: "stopped", sent: 0 });
    expect(await runBroadcastBatch(id, NOW, firstSeq + 1)).toMatchObject({ outcome: "completed", sent: 3 });
    expect(mocks.sendDirectMessage).toHaveBeenCalledTimes(4);
    expect(mocks.enqueueBroadcastBatch).toHaveBeenCalledTimes(1);
  });

  it("cancel during a running tick skips the leased rows instead of releasing them", async () => {
    seedContact("c1");
    seedContact("c2");
    seedContact("c3");
    const { id } = await scheduleAndStart();
    mocks.enqueueBroadcastBatch.mockClear();
    mocks.sendDirectMessage.mockImplementationOnce(async () => {
      await cancelBroadcast(WS, id, NOW);
      return { recipient_id: "r", message_id: "m_x" };
    });
    const batch = await runBroadcastBatch(id, NOW);
    expect(batch).toMatchObject({ outcome: "stopped", sent: 1, skipped: 2, requeued: 0 });
    const recipients = rows("crmBroadcastRecipient").filter((r) => r.broadcastId === id);
    expect(recipients.filter((r) => r.status === "SENT")).toHaveLength(1);
    const skipped = recipients.filter((r) => r.status === "SKIPPED");
    expect(skipped).toHaveLength(2);
    expect(skipped.every((r) => r.error === "Broadcast bekor qilindi.")).toBe(true);
    expect(recipients.some((r) => r.status === "PENDING" || r.status === "SENDING")).toBe(false);
    const view = await getBroadcast(WS, id);
    expect(view.ok && view.data).toMatchObject({ status: "CANCELLED", counters: { sent: 1, skipped: 2, pending: 0 } });
    expect(mocks.enqueueBroadcastBatch).not.toHaveBeenCalled();
  });

  it("a pause during a batch stops before the next send", async () => {
    seedContact("c1");
    seedContact("c2");
    const { id } = await scheduleAndStart();
    mocks.sendDirectMessage.mockImplementationOnce(async () => {
      await pauseBroadcast(WS, id);
      return { recipient_id: "r", message_id: "m_x" };
    });
    const batch = await runBroadcastBatch(id, NOW);
    expect(batch).toMatchObject({ outcome: "stopped", sent: 1, requeued: 1 });
    expect(mocks.sendDirectMessage).toHaveBeenCalledTimes(1);
    const left = rows("crmBroadcastRecipient").find((r) => r.broadcastId === id && r.contactId === "c2")!;
    expect(left).toMatchObject({ status: "PENDING", attempts: 0 });
  });

  it("a paused-before-start broadcast resumes to SCHEDULED", async () => {
    const view = await makeBroadcast();
    await scheduleBroadcast(WS, view.id, {}, NOW);
    await pauseBroadcast(WS, view.id);
    mocks.enqueueBroadcastStart.mockClear();
    const resumed = await resumeBroadcast(WS, view.id, NOW);
    expect(resumed.ok && resumed.data.status).toBe("SCHEDULED");
    expect(mocks.enqueueBroadcastStart).toHaveBeenCalledWith(view.id, 0, NOW);
  });

  it("cancel skips what is still pending and refuses to run", async () => {
    seedContact("c1");
    seedContact("c2");
    const { id } = await scheduleAndStart();
    const cancelled = await cancelBroadcast(WS, id, NOW);
    expect(cancelled.ok && cancelled.data.status).toBe("CANCELLED");
    expect(cancelled.ok && cancelled.data.counters).toMatchObject({ skipped: 2, pending: 0 });
    expect(await runBroadcastBatch(id, NOW)).toMatchObject({ outcome: "stopped" });
    expect(await cancelBroadcast(WS, id, NOW)).toMatchObject({ ok: false, status: 422 });
    expect(await getBroadcast("other-ws", id)).toMatchObject({ ok: false, status: 404 });
  });
});

describe("attribution and opt-out", () => {
  async function sentTo(contactId: string) {
    seedContact(contactId);
    const { id } = await scheduleAndStart({ replyWindowHours: 48, conversionWindowDays: 7 });
    await runBroadcastBatch(id, NOW);
    return id;
  }

  it("a reply inside replyWindowHours is attributed once; outside it is not", async () => {
    const id = await sentTo("c1");
    expect(await attributeReply("c1", new Date(NOW.getTime() + 49 * 3600_000), "late")).toBeNull();
    const recipientId = await attributeReply("c1", new Date(NOW.getTime() + 2 * 3600_000), "mid_reply");
    expect(recipientId).toBeTruthy();
    expect(await attributeReply("c1", new Date(NOW.getTime() + 3 * 3600_000), "again")).toBeNull();

    const view = await getBroadcast(WS, id);
    expect(view.ok && view.data.counters.replied).toBe(1);
    const recipient = rows("crmBroadcastRecipient").find((r) => r.id === recipientId)!;
    expect(recipient).toMatchObject({ status: "SENT", replyMessageId: "mid_reply", repliedAt: expect.any(Date) });
    expect(rows("crmActivity").some((a) => a.type === "BROADCAST_REPLIED" && a.contactId === "c1")).toBe(true);
    const page = await listRecipients(WS, id, { replied: true });
    expect(page.ok && page.data.recipients.map((r) => r.contactId)).toEqual(["c1"]);
  });

  it("a deal inside conversionWindowDays is a conversion", async () => {
    const id = await sentTo("c1");
    expect(await attributeConversion("c1", "deal_late", new Date(NOW.getTime() + 8 * 24 * 3600_000))).toBeNull();
    const recipientId = await attributeConversion("c1", "deal1", new Date(NOW.getTime() + 2 * 24 * 3600_000));
    expect(recipientId).toBeTruthy();
    const recipient = rows("crmBroadcastRecipient").find((r) => r.id === recipientId)!;
    expect(recipient.conversionDealId).toBe("deal1");
    const view = await getBroadcast(WS, id);
    expect(view.ok && view.data.counters.converted).toBe(1);
    expect(rows("crmActivity").find((a) => a.type === "BROADCAST_CONVERTED")).toMatchObject({ contactId: "c1", dealId: "deal1" });
  });

  it("an inbound 'STOP' opts the contact out, records OPT_OUT and still counts as the reply", async () => {
    await sentTo("c1");
    const outcome = await onBroadcastInbound({ contactId: "c1", text: "STOP", mid: "m_stop", at: new Date(NOW.getTime() + 3600_000) });
    expect(outcome.optedOut).toBe(true);
    expect(outcome.repliedRecipientId).toBeTruthy();
    const contact = rows("crmContact").find((c) => c.id === "c1")!;
    expect(contact.optedOutAt).toBeInstanceOf(Date);
    expect(contact.optOutReason).toBe("stop_word");
    expect(rows("crmActivity").some((a) => a.type === "OPT_OUT" && a.contactId === "c1")).toBe(true);

    // Idempotent and language-aware.
    expect((await onBroadcastInbound({ contactId: "c1", text: "to'xtating", at: NOW })).optedOut).toBe(false);
    seedContact("c2");
    expect((await onBroadcastInbound({ contactId: "c2", text: "Отпишите меня", at: NOW })).optedOut).toBe(true);
    seedContact("c3");
    expect((await onBroadcastInbound({ contactId: "c3", text: "Narxi qancha?", at: NOW })).optedOut).toBe(false);

    // The next broadcast skips c1 with OPTED_OUT.
    const { started } = await scheduleAndStart({ name: "Ikkinchi", frequencyCapHours: 0 });
    const skipped = rows("crmBroadcastRecipient").filter((r) => r.contactId === "c1" && r.status === "SKIPPED");
    expect(started.total).toBe(3);
    expect(skipped.map((r) => r.ineligibleReason)).toContain("OPTED_OUT");
  });

  it("the same 'stop' message is applied once: a replay after a manual opt-in keeps the contact opted in", async () => {
    seedContact("c1");
    const at = new Date(NOW.getTime() + 3600_000);
    expect((await onBroadcastInbound({ contactId: "c1", text: "stop", mid: "m_stop", at })).optedOut).toBe(true);
    const optOut = rows("crmActivity").find((a) => a.type === "OPT_OUT" && a.contactId === "c1")!;
    expect(optOut.sourceId).toBe("c1_mid_m_stop");

    expect(await setOptOut(WS, "c1", false)).toMatchObject({ ok: true, data: { optedOutAt: null } });
    // Reconciler / retried job replays the same message (with or without a later timestamp).
    expect((await onBroadcastInbound({ contactId: "c1", text: "stop", mid: "m_stop", at: new Date(at.getTime() + 60_000) })).optedOut).toBe(false);
    expect(rows("crmContact").find((c) => c.id === "c1")!.optedOutAt).toBeNull();
    expect(rows("crmActivity").filter((a) => a.type === "OPT_OUT" && a.contactId === "c1")).toHaveLength(1);

    // A new 'stop' message opts out again.
    expect((await onBroadcastInbound({ contactId: "c1", text: "stop", mid: "m_stop2", at: new Date(at.getTime() + 120_000) })).optedOut).toBe(true);
  });

  it("conversion only for a new deal or a forward move (later stage or WON), never back / sideways / LOST", async () => {
    const pipeline = db.seed("crmPipeline", { workspaceId: WS, name: "Asosiy", isDefault: true });
    const stage = (name: string, sort: number, kind = "OPEN") => db.seed("crmStage", { pipelineId: pipeline.id, name, sort, kind }).id as string;
    const s1 = stage("Yangi lead", 0);
    const s2 = stage("Bog'lanildi", 1);
    const lost = stage("Yo'qotildi", 5, "LOST");
    const won = stage("Yutildi", 6, "WON");
    const converted = (contactId: string) => rows("crmBroadcastRecipient").find((r) => r.contactId === contactId && r.status === "SENT")!.convertedAt;
    const contact = (id: string) => rows("crmContact").find((c) => c.id === id) as never;
    const move = (contactId: string, fromStageId: string | null, toStageId: string, stageKind: "OPEN" | "WON" | "LOST") =>
      onCrmEventForBroadcast({ kind: "stage_changed", workspaceId: WS, contactId, contact: contact(contactId), dealId: `d_${contactId}`, fromStageId, toStageId, stageKind, actor: { kind: "OPERATOR" } });

    await sentTo("c1");
    await move("c1", s2, s1, "OPEN"); // back
    await move("c1", s1, s1, "OPEN"); // sideways
    await move("c1", s2, lost, "LOST"); // lost (sorts later, still not a conversion)
    expect(converted("c1")).toBeNull();
    await move("c1", s1, s2, "OPEN"); // forward
    expect(converted("c1")).toBeInstanceOf(Date);

    seedContact("c2");
    const second = await scheduleAndStart({ name: "Ikkinchi", frequencyCapHours: 0 });
    await runBroadcastBatch(second.id, NOW);
    await move("c2", s2, won, "WON");
    expect(rows("crmBroadcastRecipient").find((r) => r.contactId === "c2")!.convertedAt).toBeInstanceOf(Date);

    seedContact("c3");
    const third = await scheduleAndStart({ name: "Uchinchi", frequencyCapHours: 0 });
    await runBroadcastBatch(third.id, NOW);
    await onCrmEventForBroadcast({ kind: "lead_created", workspaceId: WS, contactId: "c3", contact: contact("c3"), leadId: "l3", dealId: "d_c3", productInterest: null });
    expect(rows("crmBroadcastRecipient").find((r) => r.contactId === "c3")!.convertedAt).toBeInstanceOf(Date);
  });
});

describe("maintenance", () => {
  it("starts a past-due SCHEDULED broadcast and re-queues a RUNNING one whose next tick is overdue (row state, no queue scan)", async () => {
    seedContact("c1");
    const a = await makeBroadcast({ name: "A" });
    await scheduleBroadcast(WS, a.id, { scheduledAt: new Date(NOW.getTime() + 60_000).toISOString() }, NOW);
    const b = await makeBroadcast({ name: "B" });
    await scheduleBroadcast(WS, b.id, {}, NOW);
    await startBroadcast(b.id, NOW);
    mocks.enqueueBroadcastStart.mockClear();
    mocks.enqueueBroadcastBatch.mockClear();

    // Inside the interval after the due tick: nothing to do for B.
    expect((await runBroadcastMaintenance(new Date(NOW.getTime() + 4 * 60_000))).requeued).toBe(0);

    const later = new Date(NOW.getTime() + 10 * 60_000);
    const out = await runBroadcastMaintenance(later);
    expect(out).toEqual({ started: 1, requeued: 1 });
    const scheduledA = rows("crmBroadcast").find((r) => r.id === a.id)!.scheduledAt;
    // Same schedule time = same start job id: a late-but-alive start job is not doubled.
    expect(mocks.enqueueBroadcastStart).toHaveBeenCalledWith(a.id, 0, scheduledA);
    expect(mocks.enqueueBroadcastBatch).toHaveBeenCalledWith(b.id, 0, 2);

    // The re-queued tick set nextTickAt = later: the next sweep leaves B alone.
    mocks.enqueueBroadcastBatch.mockClear();
    expect((await runBroadcastMaintenance(later)).requeued).toBe(0);
    expect(mocks.enqueueBroadcastBatch).not.toHaveBeenCalled();
  });

  it("without CRM_ENABLED maintenance is off (opt-in)", async () => {
    delete process.env.CRM_ENABLED;
    expect(await runBroadcastMaintenance(NOW)).toEqual({ started: 0, requeued: 0 });
  });

  it("CRM_DISABLED=1 turns maintenance off", async () => {
    process.env.CRM_DISABLED = "1";
    try {
      expect(await runBroadcastMaintenance(NOW)).toEqual({ started: 0, requeued: 0 });
    } finally {
      delete process.env.CRM_DISABLED;
    }
  });
});

afterAll(() => {
  delete process.env.CRM_ENABLED;
});
