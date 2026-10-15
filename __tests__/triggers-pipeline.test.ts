/**
 * Trigger Engine — the Story Reply vertical slice end to end, against the
 * in-memory database:
 *
 *   webhook payload → InstagramEvent → campaign match → contact →
 *   conversation → DM → log, plus duplicate protection and retries.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  sendDirectMessage: vi.fn(),
  getMessagingProfile: vi.fn(),
  markTokenBroken: vi.fn(),
  reserveWorkspaceDMSend: vi.fn(),
  releaseWorkspaceDMReservation: vi.fn(),
  reserveDMSlot: vi.fn(),
  enqueueEvent: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  sendDirectMessage: mocks.sendDirectMessage,
  getMessagingProfile: mocks.getMessagingProfile,
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (value: string) => `plain:${value}` }));
vi.mock("@/lib/meta/token-health", () => ({ markTokenBroken: mocks.markTokenBroken }));
vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mocks.reserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mocks.releaseWorkspaceDMReservation,
}));
vi.mock("@/lib/utils/rate-limiter", () => ({ reserveDMSlot: mocks.reserveDMSlot }));
vi.mock("@/lib/triggers/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/triggers/queue")>()),
  enqueueEvent: mocks.enqueueEvent,
}));

import { MetaApiError, RateLimitError, TokenExpiredError } from "@/lib/meta/client";
import {
  findClaimedStoryReplies,
  forgetAccountGate,
  ingestWebhookPayload,
  storyReplyKey,
} from "@/lib/triggers/ingest";
import { processInstagramEvent } from "@/lib/triggers/processor";
import { TriggerRetryableError } from "@/lib/triggers/errors";
import { backoffDelay, TRIGGER_MAX_ATTEMPTS } from "@/lib/triggers/queue";
import { retryEvent, simulateStoryReply } from "@/lib/triggers/service";
import { sweepTriggerEvents } from "@/lib/triggers/worker";

const IG_ID = "17841400000000001";
const OTHER_IG_ID = "17841400000000999";
const USER = "6000000000000001";
const STORY = "18000000000000042";

type Row = Record<string, unknown>;
let account: Row;
let campaign: Row;

function storyReply(mid: string, text: string, opts: { storyId?: string; sender?: string; igId?: string } = {}) {
  return {
    object: "instagram",
    entry: [
      {
        id: opts.igId ?? IG_ID,
        time: 1760000000000,
        messaging: [
          {
            sender: { id: opts.sender ?? USER },
            recipient: { id: opts.igId ?? IG_ID },
            timestamp: 1760000001000,
            message: { mid, text, reply_to: { story: { id: opts.storyId ?? STORY, url: "https://cdn/s.jpg" } } },
          },
        ],
      },
    ],
  };
}

async function ingestAndProcess(payload: unknown) {
  const result = await ingestWebhookPayload(payload);
  const outcomes = [];
  for (const id of result.stored) outcomes.push(await processInstagramEvent(id));
  return { ...result, outcomes };
}

const rows = (model: string) => db.rows(model);

beforeEach(() => {
  resetDb();
  forgetAccountGate();
  vi.clearAllMocks();
  vi.stubEnv("TRIGGER_ENGINE_DISABLED", "");

  db.seed("workspace", { id: "ws1", name: "Test", isSuspended: false });
  account = db.seed("instagramAccount", {
    id: "acc1",
    workspaceId: "ws1",
    instagramId: IG_ID,
    username: "kurslar",
    accessToken: "enc-token",
    tokenStatus: "ACTIVE",
  });
  db.seed("instagramAccount", { id: "acc2", workspaceId: "ws2", instagramId: OTHER_IG_ID, username: "other", accessToken: "x" });
  campaign = db.seed("triggerCampaign", {
    id: "camp1",
    workspaceId: "ws1",
    instagramAccountId: "acc1",
    name: "Narx so'raganlar",
    triggerType: "STORY_REPLY",
    storyScope: "ALL",
    storyIds: [],
    keywords: ["narx", "цена", "kurs"],
    matchingMode: "CONTAINS",
    responseMessage: "Assalomu alaykum! Kurs narxi 450 000 so'm.",
    active: true,
  });

  let outbound = 0;
  mocks.sendDirectMessage.mockImplementation(async () => ({ recipient_id: USER, message_id: `mid.out.${++outbound}` }));
  mocks.getMessagingProfile.mockResolvedValue({ username: "ali", name: "Ali Valiyev" });
  mocks.reserveWorkspaceDMSend.mockResolvedValue({ allowed: true, reserved: true, periodStart: new Date(), limit: 1, remaining: 1 });
  mocks.reserveDMSlot.mockResolvedValue({ allowed: true, currentCount: 1 });
  mocks.enqueueEvent.mockResolvedValue(undefined);
  mocks.releaseWorkspaceDMReservation.mockResolvedValue({ count: 1 });
  mocks.markTokenBroken.mockResolvedValue(undefined);
});

describe("Story Reply — happy path (A–G, J)", () => {
  it("receives, classifies, matches, creates the contact + conversation and sends the DM", async () => {
    const result = await ingestAndProcess(storyReply("mid.in.1", "Narxi qancha?"));

    // A + B: stored as a STORY_REPLY and queued
    expect(result.stored).toHaveLength(1);
    expect(mocks.enqueueEvent).toHaveBeenCalledWith(result.stored[0]);
    const [event] = rows("instagramEvent");
    expect(event).toMatchObject({ eventType: "STORY_REPLY", storyId: STORY, text: "Narxi qancha?", senderId: USER });
    expect(event.rawPayload).toMatchObject({ entryId: IG_ID, item: { message: { mid: "mid.in.1" } } });

    // C + D + G: the campaign answered via DM
    expect(result.outcomes).toEqual(["processed"]);
    expect(mocks.sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(mocks.sendDirectMessage).toHaveBeenCalledWith("plain:enc-token", IG_ID, USER, campaign.responseMessage);
    const [execution] = rows("triggerExecution");
    expect(execution).toMatchObject({ campaignId: "camp1", status: "SENT", matchedKeyword: "narx", sentMessageId: "mid.out.1" });
    expect(event.processingStatus).toBe("PROCESSED");

    // E: contact created with the source and both interaction times
    const [contact] = rows("instagramContact");
    expect(contact).toMatchObject({
      igUserId: USER,
      username: "ali",
      name: "Ali Valiyev",
      source: "STORY_REPLY",
      interactionCount: 1,
    });
    expect(contact.firstInteractionAt).toEqual(new Date(1760000001000));
    expect(event.contactId).toBe(contact.id);

    // F: conversation with the reply and our answer
    const [conversation] = rows("triggerConversation");
    expect(event.conversationId).toBe(conversation.id);
    expect(rows("triggerMessage").map((m) => [m.direction, m.text])).toEqual([
      ["INBOUND", "Narxi qancha?"],
      ["OUTBOUND", campaign.responseMessage],
    ]);
  });

  it("finds the existing contact and conversation on the next reply", async () => {
    await ingestAndProcess(storyReply("mid.in.1", "narx?"));
    await ingestAndProcess(storyReply("mid.in.2", "kurs qachon boshlanadi?"));

    expect(rows("instagramContact")).toHaveLength(1);
    expect(rows("instagramContact")[0].interactionCount).toBe(2);
    expect(rows("triggerConversation")).toHaveLength(1);
    expect(rows("triggerMessage")).toHaveLength(4);
    expect(mocks.sendDirectMessage).toHaveBeenCalledTimes(2);
    // Profile looked up once; the stored username is reused afterwards.
    expect(mocks.getMessagingProfile).toHaveBeenCalledTimes(1);
  });

  it("logs a non-matching reply as IGNORED with the reason, still recording the contact", async () => {
    const result = await ingestAndProcess(storyReply("mid.in.3", "salom"));
    expect(result.outcomes).toEqual(["ignored"]);
    expect(mocks.sendDirectMessage).not.toHaveBeenCalled();
    expect(rows("instagramEvent")[0]).toMatchObject({ processingStatus: "IGNORED", error: "Kalit so'z mos kelmadi" });
    expect(rows("triggerExecution")).toHaveLength(0);
    expect(rows("instagramContact")).toHaveLength(1);
    expect(rows("instagramContact")[0].username).toBe("ali");
  });

  it("honours a specific-story campaign over the all-stories one", async () => {
    db.seed("triggerCampaign", {
      id: "camp2",
      workspaceId: "ws1",
      instagramAccountId: "acc1",
      name: "Chegirma story",
      triggerType: "STORY_REPLY",
      storyScope: "SPECIFIC",
      storyIds: [STORY],
      matchingMode: "EVERY",
      keywords: [],
      responseMessage: "-20% chegirma bugun!",
      active: true,
    });
    await ingestAndProcess(storyReply("mid.in.4", "narxi?"));
    expect(mocks.sendDirectMessage).toHaveBeenCalledWith(expect.any(String), IG_ID, USER, "-20% chegirma bugun!");

    await ingestAndProcess(storyReply("mid.in.5", "narxi?", { storyId: "another-story" }));
    expect(mocks.sendDirectMessage).toHaveBeenLastCalledWith(expect.any(String), IG_ID, USER, campaign.responseMessage);
  });

  it("does not answer for an inactive campaign", async () => {
    campaign.active = false;
    const result = await ingestAndProcess(storyReply("mid.in.6", "narx"));
    expect(result.outcomes).toEqual(["ignored"]);
    expect(mocks.sendDirectMessage).not.toHaveBeenCalled();
  });

  it("leaves other event types stored but unhandled until their module ships", async () => {
    const result = await ingestAndProcess({
      object: "instagram",
      entry: [{ id: IG_ID, messaging: [{ sender: { id: USER }, message: { mid: "mid.dm", text: "narx" } }] }],
    });
    expect(rows("instagramEvent")[0]).toMatchObject({ eventType: "DIRECT_MESSAGE", processingStatus: "IGNORED" });
    expect(result.outcomes).toEqual(["ignored"]);
    expect(mocks.sendDirectMessage).not.toHaveBeenCalled();
  });
});

describe("Isolation — the engine stays out of accounts without trigger campaigns", () => {
  it("does not store anything for an account with no trigger campaign", async () => {
    const result = await ingestWebhookPayload(storyReply("mid.x", "narx", { igId: OTHER_IG_ID }));
    expect(result).toMatchObject({ stored: [], skipped: 1 });
    expect(rows("instagramEvent")).toHaveLength(0);
  });

  it("does nothing at all when the kill switch is on", async () => {
    vi.stubEnv("TRIGGER_ENGINE_DISABLED", "1");
    const result = await ingestWebhookPayload(storyReply("mid.y", "narx"));
    expect(result.stored).toEqual([]);
    expect(rows("instagramEvent")).toHaveLength(0);
  });
});

describe("Duplicate protection (H)", () => {
  it("a redelivered webhook is stored once and answered once", async () => {
    const first = await ingestAndProcess(storyReply("mid.dup", "narx"));
    const second = await ingestAndProcess(storyReply("mid.dup", "narx"));
    expect(first.stored).toHaveLength(1);
    expect(second).toMatchObject({ stored: [], duplicates: 1 });
    expect(rows("instagramEvent")).toHaveLength(1);
    expect(mocks.sendDirectMessage).toHaveBeenCalledTimes(1);
  });

  it("processing the same event again (stray job, sweep) never sends twice", async () => {
    const { stored } = await ingestAndProcess(storyReply("mid.dup2", "narx"));
    expect(await processInstagramEvent(stored[0])).toBe("already_done");

    // Even if the event were reopened, the SENT execution blocks a resend.
    rows("instagramEvent")[0].processingStatus = "PENDING";
    expect(await processInstagramEvent(stored[0])).toBe("processed");
    expect(mocks.sendDirectMessage).toHaveBeenCalledTimes(1);
  });

  it("a send interrupted mid-flight is not repeated automatically", async () => {
    const { stored } = await ingestWebhookPayload(storyReply("mid.crash", "narx"));
    db.seed("triggerExecution", {
      workspaceId: "ws1",
      eventId: stored[0],
      campaignId: "camp1",
      status: "SENDING",
      responseText: "x",
    });
    expect(await processInstagramEvent(stored[0])).toBe("failed");
    expect(mocks.sendDirectMessage).not.toHaveBeenCalled();
    expect(rows("triggerExecution")[0]).toMatchObject({ status: "FAILED" });
    expect(String(rows("triggerExecution")[0].error)).toMatch(/ikki marta yubormaslik/);
  });

  it("a claimed event is not run by a second job at the same time", async () => {
    const { stored } = await ingestWebhookPayload(storyReply("mid.busy", "narx"));
    Object.assign(rows("instagramEvent")[0], { processingStatus: "PROCESSING", processingStartedAt: new Date() });
    expect(await processInstagramEvent(stored[0])).toBe("busy");
    expect(mocks.sendDirectMessage).not.toHaveBeenCalled();
  });
});

describe("Errors, queue and retry (I)", () => {
  it("a temporary Instagram failure is queued for retry with a readable reason, then succeeds", async () => {
    mocks.sendDirectMessage.mockRejectedValueOnce(new MetaApiError(2, undefined, "trace", "Service temporarily unavailable"));
    const { stored } = await ingestWebhookPayload(storyReply("mid.retry", "narx"));

    await expect(processInstagramEvent(stored[0])).rejects.toBeInstanceOf(TriggerRetryableError);
    const event = rows("instagramEvent")[0];
    const execution = rows("triggerExecution")[0];
    expect(event.processingStatus).toBe("RETRYING");
    expect(execution).toMatchObject({ status: "RETRYING", error: "Instagram API vaqtincha javob bermadi." });
    expect(String(execution.errorDetail)).toMatch(/code=2.*Service temporarily unavailable/);
    expect(execution.nextRetryAt).toBeInstanceOf(Date);
    // The reserved usage slot is handed back after a failed send.
    expect(mocks.releaseWorkspaceDMReservation).toHaveBeenCalledTimes(1);

    // BullMQ runs the job again after the backoff:
    expect(await processInstagramEvent(stored[0])).toBe("processed");
    expect(rows("triggerExecution")[0]).toMatchObject({ status: "SENT", error: null, attempts: 2 });
    expect(mocks.sendDirectMessage).toHaveBeenCalledTimes(2);
  });

  it("gives up after the last attempt and records the failure", async () => {
    mocks.sendDirectMessage.mockRejectedValue(new RateLimitError("Too many calls"));
    const { stored } = await ingestWebhookPayload(storyReply("mid.limit", "narx"));

    for (let i = 1; i < TRIGGER_MAX_ATTEMPTS; i++) {
      await expect(processInstagramEvent(stored[0])).rejects.toBeInstanceOf(TriggerRetryableError);
    }
    expect(await processInstagramEvent(stored[0])).toBe("failed");
    expect(rows("instagramEvent")[0]).toMatchObject({ processingStatus: "FAILED", attempts: TRIGGER_MAX_ATTEMPTS });
    expect(rows("triggerExecution")[0]).toMatchObject({ status: "FAILED", nextRetryAt: null });
    expect(rows("operationalEvent").some((e) => String(e.message).includes("Trigger engine"))).toBe(true);
  });

  it("a permanent rejection fails at once without retries", async () => {
    mocks.sendDirectMessage.mockRejectedValue(
      new MetaApiError(10, 2534022, "t", "This message is sent outside of allowed window.")
    );
    const { stored } = await ingestWebhookPayload(storyReply("mid.window", "narx"));
    expect(await processInstagramEvent(stored[0])).toBe("failed");
    expect(rows("triggerExecution")[0].error).toMatch(/24 soatlik/);
    expect(mocks.sendDirectMessage).toHaveBeenCalledTimes(1);
  });

  it("an expired token fails the send and flags the account", async () => {
    mocks.sendDirectMessage.mockRejectedValue(new TokenExpiredError("Session has expired"));
    const { stored } = await ingestWebhookPayload(storyReply("mid.token", "narx"));
    expect(await processInstagramEvent(stored[0])).toBe("failed");
    expect(mocks.markTokenBroken).toHaveBeenCalledWith("acc1", expect.stringContaining("Session has expired"));
  });

  it("does not even try with a broken account token", async () => {
    account.tokenStatus = "BROKEN";
    const { stored } = await ingestWebhookPayload(storyReply("mid.broken", "narx"));
    expect(await processInstagramEvent(stored[0])).toBe("failed");
    expect(mocks.sendDirectMessage).not.toHaveBeenCalled();
    expect(rows("triggerExecution")[0].error).toMatch(/qayta ulang/);
  });

  it("the hourly cap queues the reply for later instead of sending", async () => {
    mocks.reserveDMSlot.mockResolvedValueOnce({ allowed: false, currentCount: 750 });
    const { stored } = await ingestWebhookPayload(storyReply("mid.cap", "narx"));
    await expect(processInstagramEvent(stored[0])).rejects.toBeInstanceOf(TriggerRetryableError);
    expect(mocks.sendDirectMessage).not.toHaveBeenCalled();
    expect(mocks.releaseWorkspaceDMReservation).toHaveBeenCalled();
    expect(rows("triggerExecution")[0].status).toBe("RETRYING");
  });

  it("a rate-limit retry waits past the hourly window", async () => {
    mocks.reserveDMSlot.mockResolvedValueOnce({ allowed: false, currentCount: 750 });
    const { stored } = await ingestWebhookPayload(storyReply("mid.cap2", "narx"));
    const error = await processInstagramEvent(stored[0]).catch((e) => e);
    expect(error).toBeInstanceOf(TriggerRetryableError);
    expect((error as TriggerRetryableError).failure.kind).toBe("rate_limit");
    expect(backoffDelay(1, "rate_limit")).toBeGreaterThan(60 * 60_000);
    expect(backoffDelay(1)).toBe(30_000);
    const nextRetryAt = rows("triggerExecution")[0].nextRetryAt as Date;
    expect(nextRetryAt.getTime() - Date.now()).toBeGreaterThan(60 * 60_000);
  });

  it("releases the workspace reservation when the slot check throws", async () => {
    mocks.reserveDMSlot.mockRejectedValueOnce(new Error("redis down"));
    const { stored } = await ingestWebhookPayload(storyReply("mid.redis", "narx"));
    await expect(processInstagramEvent(stored[0])).rejects.toThrow("redis down");
    expect(mocks.releaseWorkspaceDMReservation).toHaveBeenCalledTimes(1);
    expect(mocks.sendDirectMessage).not.toHaveBeenCalled();
  });

  it("a suspended workspace is skipped, not failed", async () => {
    mocks.reserveWorkspaceDMSend.mockResolvedValueOnce({ allowed: false, reason: "suspended", periodStart: null });
    const { stored } = await ingestWebhookPayload(storyReply("mid.susp", "narx"));
    expect(await processInstagramEvent(stored[0])).toBe("processed");
    expect(rows("triggerExecution")[0]).toMatchObject({ status: "SKIPPED" });
    expect(mocks.sendDirectMessage).not.toHaveBeenCalled();
  });

  it("a database failure inside the handler releases the claim for the retry", async () => {
    const { stored } = await ingestWebhookPayload(storyReply("mid.db", "narx"));
    // Make the campaign lookup throw, as a dropped connection would.
    const saved = db.tables.triggerCampaign;
    Object.defineProperty(db.tables, "triggerCampaign", {
      configurable: true,
      get() {
        throw new Error("connection reset");
      },
    });
    await expect(processInstagramEvent(stored[0])).rejects.toThrow("connection reset");
    Object.defineProperty(db.tables, "triggerCampaign", { configurable: true, writable: true, value: saved });
    expect(rows("instagramEvent")[0]).toMatchObject({ processingStatus: "RETRYING", processingStartedAt: null });

    expect(await processInstagramEvent(stored[0])).toBe("processed");
  });

  it("manual retry re-runs a failed event, never resends a sent one", async () => {
    mocks.sendDirectMessage.mockRejectedValueOnce(new TokenExpiredError("expired"));
    const { stored } = await ingestWebhookPayload(storyReply("mid.manual", "narx"));
    expect(await processInstagramEvent(stored[0])).toBe("failed");

    expect(await retryEvent("ws1", stored[0])).toEqual({ ok: true });
    expect(mocks.enqueueEvent).toHaveBeenLastCalledWith(stored[0], { suffix: expect.stringMatching(/^manual/) });
    expect(rows("instagramEvent")[0]).toMatchObject({ processingStatus: "PENDING", attempts: 0, error: null });
    expect(await processInstagramEvent(stored[0])).toBe("processed");
    expect(rows("triggerExecution")[0].status).toBe("SENT");

    // Already sent → refused
    expect(await retryEvent("ws1", stored[0])).toMatchObject({ ok: false, status: 409 });
    // Another workspace's event → not found
    expect(await retryEvent("ws2", stored[0])).toMatchObject({ ok: false, status: 404 });
  });

  it("the sweep re-queues events whose job was lost", async () => {
    mocks.enqueueEvent.mockRejectedValueOnce(new Error("Redis down"));
    const { stored } = await ingestWebhookPayload(storyReply("mid.lost", "narx"));
    expect(rows("instagramEvent")[0].processingStatus).toBe("PENDING");

    // Not yet: inside the grace period
    expect(await sweepTriggerEvents(new Date())).toBe(0);
    const later = new Date(Date.now() + 5 * 60_000);
    expect(await sweepTriggerEvents(later)).toBe(1);
    expect(mocks.enqueueEvent).toHaveBeenLastCalledWith(stored[0], { suffix: `sweep${later.getTime()}` });
  });
});

describe("Story replies claimed by the engine (no double DM)", () => {
  it("claims a story reply an active campaign will answer", async () => {
    const claimed = await findClaimedStoryReplies(storyReply("mid.claim", "Narxi qancha?"));
    expect([...claimed]).toEqual([storyReplyKey(IG_ID, "mid.claim")]);
  });

  it("does not claim a reply no campaign matches", async () => {
    expect((await findClaimedStoryReplies(storyReply("mid.nomatch", "salom"))).size).toBe(0);
  });

  it("does not claim for accounts without trigger campaigns", async () => {
    expect((await findClaimedStoryReplies(storyReply("mid.other", "narx", { igId: OTHER_IG_ID }))).size).toBe(0);
  });

  it("does not claim when the campaign is paused", async () => {
    campaign.active = false;
    expect((await findClaimedStoryReplies(storyReply("mid.paused", "narx"))).size).toBe(0);
  });

  it("does not claim when the engine is disabled", async () => {
    vi.stubEnv("TRIGGER_ENGINE_DISABLED", "1");
    expect((await findClaimedStoryReplies(storyReply("mid.off", "narx"))).size).toBe(0);
  });
});

describe("Simulator", () => {
  it("reports which campaign would answer without writing anything", async () => {
    const result = await simulateStoryReply("ws1", { instagramAccountId: "acc1", text: "Цена?" });
    expect(result.selected).toMatchObject({ id: "camp1", matchedKeyword: "цена" });
    const miss = await simulateStoryReply("ws1", { instagramAccountId: "acc1", text: "salom" });
    expect(miss.selected).toBeNull();
    expect(miss.campaigns[0]).toMatchObject({ matched: false, reason: "Kalit so'z mos kelmadi" });
    expect(rows("instagramEvent")).toHaveLength(0);
    expect(mocks.sendDirectMessage).not.toHaveBeenCalled();
  });
});
