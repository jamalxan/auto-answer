/**
 * Comment Automation 2.0 end to end against the in-memory database:
 *
 *   comment webhook → InstagramEvent → handleComment → public reply + private
 *   reply with the opening button → tap (postback c2:…:open) → main message
 *   with quick replies → quick-reply actions / plain DM → follow-up sweep,
 *   plus the production claim, the simulator and backtrack.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  sendPrivateReply: vi.fn(),
  sendPrivateReplyWithButton: vi.fn(),
  sendCommentReply: vi.fn(),
  sendDirectMessage: vi.fn(),
  sendDirectMessageWithQuickReplies: vi.fn(),
  getMessagingProfile: vi.fn(),
  getRecentMediaComments: vi.fn(),
  getUserMedia: vi.fn(),
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
  sendPrivateReply: mocks.sendPrivateReply,
  sendPrivateReplyWithButton: mocks.sendPrivateReplyWithButton,
  sendCommentReply: mocks.sendCommentReply,
  sendDirectMessage: mocks.sendDirectMessage,
  sendDirectMessageWithQuickReplies: mocks.sendDirectMessageWithQuickReplies,
  getMessagingProfile: mocks.getMessagingProfile,
  getRecentMediaComments: mocks.getRecentMediaComments,
  getUserMedia: mocks.getUserMedia,
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (value: string) => `plain:${value}` }));
vi.mock("@/lib/meta/token-health", () => ({ markTokenBroken: mocks.markTokenBroken }));
vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mocks.reserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mocks.releaseWorkspaceDMReservation,
}));
vi.mock("@/lib/utils/rate-limiter", () => ({ reserveDMSlot: mocks.reserveDMSlot }));
vi.mock("@/lib/telegram/notify", () => ({ alertWorkspace: mocks.alertWorkspace }));
vi.mock("@/lib/triggers/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/triggers/queue")>()),
  enqueueEvent: mocks.enqueueEvent,
}));

import { MetaApiError } from "@/lib/meta/client";
import {
  findClaimedC2Messages,
  findClaimedLeadPhoneMessages,
  forgetAccountGate,
  handOverClaimedComment,
  ingestWebhookPayload,
  storyReplyKey,
} from "@/lib/triggers/ingest";
import { processInstagramEvent } from "@/lib/triggers/processor";
import { TriggerRetryableError } from "@/lib/triggers/errors";
import { simulateComment } from "@/lib/triggers/comment-handler";
import { cancelFollowUps, runDueFollowUps } from "@/lib/triggers/followups";
import { forgetCommentClaims, isClaimedC2Payload, isCommentClaimedByCommentEngine } from "@/lib/triggers/claim";
import { BacktrackConflictError, startBacktrack } from "@/lib/triggers/backtrack";
import { listBacktrackRuns } from "@/lib/triggers/comment-service";

const IG_ID = "17841400000000001";
const USER = "6000000000000001";
const OTHER_USER = "6000000000000002";
const POST = "18000000000000777";

type Row = Record<string, unknown>;
let campaign: Row;
const rows = (model: string) => db.rows(model);

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

function postback(mid: string, payload: string, sender = USER) {
  return {
    object: "instagram",
    entry: [{ id: IG_ID, time: Date.now(), messaging: [{ sender: { id: sender }, recipient: { id: IG_ID }, timestamp: Date.now(), postback: { mid, title: "Ochish", payload } }] }],
  };
}

function message(mid: string, text: string, quickReplyPayload?: string, sender = USER) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_ID,
        time: Date.now(),
        messaging: [
          {
            sender: { id: sender },
            recipient: { id: IG_ID },
            timestamp: Date.now(),
            message: { mid, text, ...(quickReplyPayload ? { quick_reply: { payload: quickReplyPayload } } : {}) },
          },
        ],
      },
    ],
  };
}

async function deliver(payload: unknown) {
  const result = await ingestWebhookPayload(payload);
  const outcomes = [];
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

function execution() {
  return rows("triggerExecution")[0];
}

/** Make one model method of the in-memory database fail (until restored). */
function failing(model: string, method: string, error = new Error("db down"), times = 1) {
  const original = db.model.bind(db);
  let left = times;
  return vi.spyOn(db, "model").mockImplementation((name: string) => {
    const real = original(name);
    if (name !== model) return real;
    return {
      ...real,
      [method]: (...args: unknown[]) => {
        if (left-- > 0) return Promise.reject(error);
        return (real as unknown as Record<string, (...a: unknown[]) => unknown>)[method](...args);
      },
    } as typeof real;
  });
}

beforeEach(() => {
  resetDb();
  forgetAccountGate();
  forgetCommentClaims();
  vi.clearAllMocks();
  vi.stubEnv("TRIGGER_ENGINE_DISABLED", "");

  db.seed("workspace", { id: "ws1", name: "Test", isSuspended: false });
  db.seed("instagramAccount", { id: "acc1", workspaceId: "ws1", instagramId: IG_ID, username: "dokon", accessToken: "enc", tokenStatus: "ACTIVE" });
  campaign = db.seed("triggerCampaign", {
    id: "camp1",
    workspaceId: "ws1",
    instagramAccountId: "acc1",
    name: "Narx",
    triggerType: "COMMENT",
    keywords: [],
    matchingMode: "CONTAINS",
    intents: ["PRICE"],
    mediaScope: "ANY",
    mediaIds: [],
    priority: 0,
    replyMode: "SEQUENTIAL",
    sequenceCursor: 0,
    responseMessage: "Fallback javob",
    publicReplyEnabled: true,
    openingButtonLabel: "Narxni ko'rish",
    mainMessage: "Narxlar: 100 000 so'm. Nima qilamiz?",
    stopOnReply: true,
    stopOnLead: true,
    stopOnHandoff: true,
    active: true,
  });
  const approvedAt = new Date();
  db.seed("triggerReplyVariant", { id: "dm1", campaignId: "camp1", kind: "DM", text: "Salom! Narxni yuboraman 👇", weight: 1, sort: 0, approvedAt });
  db.seed("triggerReplyVariant", { id: "dm2", campaignId: "camp1", kind: "DM", text: "Assalomu alaykum! Pastdagi tugmani bosing", weight: 1, sort: 1, approvedAt });
  db.seed("triggerReplyVariant", { id: "dm3", campaignId: "camp1", kind: "DM", text: "AI qoralama", weight: 1, sort: 2, approvedAt: null });
  db.seed("triggerReplyVariant", { id: "pub1", campaignId: "camp1", kind: "PUBLIC", text: "Direktga yozdik ✅", weight: 1, sort: 0, approvedAt });
  db.seed("triggerQuickReply", { id: "qrMsg", campaignId: "camp1", label: "Manzil", action: "MESSAGE", responseText: "Toshkent, Chilonzor", sort: 0 });
  db.seed("triggerQuickReply", { id: "qrLead", campaignId: "camp1", label: "Raqam", action: "LEAD_CAPTURE", responseText: null, sort: 1 });
  db.seed("triggerQuickReply", { id: "qrOp", campaignId: "camp1", label: "Operator", action: "HANDOFF", responseText: null, sort: 2 });
  db.seed("triggerFollowUpStep", { id: "step1", campaignId: "camp1", sort: 0, delayMinutes: 60, condition: "ALWAYS", message: "Savollaringiz bormi?" });
  db.seed("triggerFollowUpStep", { id: "step2", campaignId: "camp1", sort: 1, delayMinutes: 30, condition: "NO_CLICK", message: "Tugmani bosishni unutmang" });

  let out = 0;
  const sent = async () => ({ recipient_id: USER, message_id: `mid.out.${++out}` });
  mocks.sendPrivateReply.mockImplementation(sent);
  mocks.sendPrivateReplyWithButton.mockImplementation(sent);
  mocks.sendDirectMessage.mockImplementation(sent);
  mocks.sendDirectMessageWithQuickReplies.mockImplementation(sent);
  mocks.sendCommentReply.mockResolvedValue({ id: "reply1" });
  mocks.getMessagingProfile.mockResolvedValue({ username: "ali", name: "Ali" });
  mocks.reserveWorkspaceDMSend.mockResolvedValue({ allowed: true, reserved: true, periodStart: new Date(), limit: 1, remaining: 1 });
  mocks.reserveDMSlot.mockResolvedValue({ allowed: true, currentCount: 1 });
  mocks.releaseWorkspaceDMReservation.mockResolvedValue({ count: 1 });
  mocks.enqueueEvent.mockResolvedValue(undefined);
  mocks.alertWorkspace.mockResolvedValue(undefined);
});

describe("handleComment", () => {
  it("answers a matching comment: public reply + private reply with the opening button", async () => {
    const result = await deliver(commentPayload("cmt1", "НАРХИ қанча?"));
    expect(result.outcomes).toEqual(["processed"]);

    const exec = execution();
    expect(exec).toMatchObject({
      status: "SENT",
      campaignId: "camp1",
      variantId: "dm1",
      responseText: "Salom! Narxni yuboraman 👇",
      matchedKeyword: "PRICE: narxi",
      publicReplyStatus: "SENT",
      publicReplyError: null,
    });
    expect(mocks.sendCommentReply).toHaveBeenCalledWith("plain:enc", "cmt1", "Direktga yozdik ✅");
    expect(mocks.sendPrivateReplyWithButton).toHaveBeenCalledWith(
      "plain:enc", IG_ID, "cmt1", "Salom! Narxni yuboraman 👇", "Narxni ko'rish", `c2:${exec.id}:open`
    );
    expect(mocks.sendPrivateReply).not.toHaveBeenCalled();
    expect(rows("triggerMessage").filter((m) => m.direction === "OUTBOUND")).toHaveLength(1);
    // the sequence moved once; NO_CLICK is scheduled at send, the rest waits for the tap
    expect(rows("triggerCampaign")[0].sequenceCursor).toBe(1);
    expect(rows("triggerFollowUpRun").map((r) => r.stepId)).toEqual(["step2"]);
  });

  it("goes round robin through approved variants only", async () => {
    await deliver(commentPayload("cmt1", "narx"));
    await deliver(commentPayload("cmt2", "narx", { from: OTHER_USER }));
    await deliver(commentPayload("cmt3", "narx", { from: "6000000000000003" }));
    expect(rows("triggerExecution").map((e) => e.variantId)).toEqual(["dm1", "dm2", "dm1"]);
  });

  it("sends a plain private reply when the campaign has no button", async () => {
    campaign.openingButtonLabel = null;
    await deliver(commentPayload("cmt1", "narx"));
    expect(mocks.sendPrivateReply).toHaveBeenCalledWith("plain:enc", IG_ID, "cmt1", "Salom! Narxni yuboraman 👇");
    // without a button every step is scheduled from the send
    expect(rows("triggerFollowUpRun").map((r) => r.stepId).sort()).toEqual(["step1", "step2"]);
  });

  it("ignores comments no campaign matches", async () => {
    const result = await deliver(commentPayload("cmt1", "zo'r post"));
    expect(result.outcomes).toEqual(["ignored"]);
    expect(rows("instagramEvent")[0]).toMatchObject({ processingStatus: "IGNORED", error: "Kalit so'z yoki intent mos kelmadi" });
    expect(mocks.sendPrivateReplyWithButton).not.toHaveBeenCalled();
  });

  it("skips a comment older than 7 days (Meta's private-reply limit)", async () => {
    const result = await deliver(commentPayload("cmt1", "narx", { at: new Date(Date.now() - 8 * 24 * 3600_000) }));
    expect(result.outcomes).toEqual(["processed"]);
    expect(execution()).toMatchObject({ status: "SKIPPED", error: expect.stringContaining("7 kundan eski") });
    expect(mocks.sendCommentReply).not.toHaveBeenCalled();
    expect(mocks.sendPrivateReplyWithButton).not.toHaveBeenCalled();
    expect(rows("triggerCampaign")[0].sequenceCursor).toBe(0);
  });

  it("never answers a comment production already answered privately", async () => {
    db.seed("dmLog", { commentId: "cmt1", status: "SENT", automationId: "a1" });
    await deliver(commentPayload("cmt1", "narx"));
    expect(execution()).toMatchObject({ status: "SKIPPED" });
    expect(mocks.sendPrivateReplyWithButton).not.toHaveBeenCalled();
  });

  it("a failed public reply does not stop the DM", async () => {
    mocks.sendCommentReply.mockRejectedValue(new MetaApiError(10, undefined, "t", "no permission"));
    await deliver(commentPayload("cmt1", "narx"));
    expect(execution()).toMatchObject({ status: "SENT", publicReplyStatus: "FAILED" });
    expect(String(execution().publicReplyError)).toContain("no permission");
  });

  it("a failed DM keeps the public reply, and the retry does not post it again", async () => {
    mocks.sendPrivateReplyWithButton.mockRejectedValueOnce(new MetaApiError(2, undefined, "t", "temporary"));
    const first = await deliver(commentPayload("cmt1", "narx"));
    expect(first.outcomes).toEqual(["retrying"]);
    expect(execution()).toMatchObject({ status: "RETRYING", publicReplyStatus: "SENT" });

    const again = await processInstagramEvent(String(rows("instagramEvent")[0].id));
    expect(again).toBe("processed");
    expect(execution()).toMatchObject({ status: "SENT", variantId: "dm1" });
    expect(mocks.sendCommentReply).toHaveBeenCalledTimes(1);
    expect(rows("triggerCampaign")[0].sequenceCursor).toBe(1);
  });

  it("a redelivered comment webhook is a no-op", async () => {
    await deliver(commentPayload("cmt1", "narx"));
    const second = await deliver(commentPayload("cmt1", "narx"));
    expect(second.duplicates).toBe(1);
    expect(mocks.sendPrivateReplyWithButton).toHaveBeenCalledTimes(1);
  });
});

describe("handleDirectMessage", () => {
  async function commentAndTap() {
    await deliver(commentPayload("cmt1", "narx"));
    const exec = execution();
    await deliver(postback("mid.tap.1", `c2:${exec.id}:open`));
    return exec;
  }

  it("button tap: opens the window, sends the main message with quick replies, schedules follow-ups", async () => {
    const exec = await commentAndTap();
    expect(rows("instagramEvent")[1]).toMatchObject({ eventType: "DIRECT_MESSAGE", payload: `c2:${exec.id}:open`, processingStatus: "PROCESSED" });
    expect(exec.openedAt).toBeInstanceOf(Date);
    expect(exec.lastInboundAt).toBeInstanceOf(Date);
    expect(mocks.sendDirectMessageWithQuickReplies).toHaveBeenCalledWith(
      "plain:enc", IG_ID, USER, "Narxlar: 100 000 so'm. Nima qilamiz?",
      [
        { title: "Manzil", payload: `c2:${exec.id}:qr:qrMsg`, contentType: "text" },
        { title: "Raqam", payload: `c2:${exec.id}:qr:qrLead`, contentType: "user_phone_number" },
        { title: "Operator", payload: `c2:${exec.id}:qr:qrOp`, contentType: "text" },
      ]
    );
    expect(rows("triggerFollowUpRun").map((r) => r.stepId).sort()).toEqual(["step1", "step2"]);
  });

  it("a crash after the send (before the bookkeeping) never sends the main message again", async () => {
    await deliver(commentPayload("cmt1", "narx"));
    const exec = execution();
    const spy = failing("triggerFollowUpStep", "findMany");
    await expect(deliver(postback("mid.tap.1", `c2:${exec.id}:open`))).rejects.toThrow("db down");
    spy.mockRestore();
    const tap = rows("instagramEvent")[1];
    expect(tap.processingStatus).toBe("RETRYING");

    expect(await processInstagramEvent(String(tap.id))).toBe("processed");
    expect(mocks.sendDirectMessageWithQuickReplies).toHaveBeenCalledTimes(1);
    expect(rows("triggerFollowUpRun").map((r) => r.stepId).sort()).toEqual(["step1", "step2"]);
    const outbound = rows("triggerMessage").filter((m) => m.direction === "OUTBOUND" && m.eventId === tap.id);
    expect(outbound.map((m) => m.mid)).toEqual(["mid.out.2"]);
  });

  it("a send interrupted before it was confirmed is not repeated, and the log says why", async () => {
    await deliver(commentPayload("cmt1", "narx"));
    const exec = execution();
    // the marker cannot be confirmed: it stays "pending", as after a crash
    const spy = failing("triggerMessage", "update");
    await deliver(postback("mid.tap.1", `c2:${exec.id}:open`));
    spy.mockRestore();
    const tap = rows("instagramEvent")[1];
    expect(rows("triggerMessage").find((m) => m.eventId === tap.id && m.direction === "OUTBOUND")?.mid).toBe(
      `pending:${tap.id}:open`
    );

    tap.processingStatus = "PENDING";
    expect(await processInstagramEvent(String(tap.id))).toBe("processed");
    expect(mocks.sendDirectMessageWithQuickReplies).toHaveBeenCalledTimes(1);
    expect(tap.error).toContain("uzildi");
  });

  it("a send Meta refused leaves no marker, so the retry sends", async () => {
    await deliver(commentPayload("cmt1", "narx"));
    const exec = execution();
    mocks.sendDirectMessageWithQuickReplies.mockRejectedValueOnce(new MetaApiError(2, undefined, "t", "temporary"));
    expect((await deliver(postback("mid.tap.1", `c2:${exec.id}:open`))).outcomes).toEqual(["retrying"]);
    const tap = rows("instagramEvent")[1];
    expect(rows("triggerMessage").filter((m) => m.eventId === tap.id && m.direction === "OUTBOUND")).toHaveLength(0);

    expect(await processInstagramEvent(String(tap.id))).toBe("processed");
    expect(mocks.sendDirectMessageWithQuickReplies).toHaveBeenCalledTimes(2);
    expect(rows("triggerMessage").filter((m) => m.eventId === tap.id && m.direction === "OUTBOUND")).toHaveLength(1);
  });

  it("a second tap on the button keeps the window open without repeating the main message", async () => {
    const exec = await commentAndTap();
    const openedAt = exec.openedAt as Date;
    const again = postback("mid.tap.2", `c2:${exec.id}:open`);
    again.entry[0].messaging[0].timestamp = Date.now() + 60_000;
    expect((await deliver(again)).outcomes).toEqual(["processed"]);
    expect(mocks.sendDirectMessageWithQuickReplies).toHaveBeenCalledTimes(1);
    expect(exec.openedAt).toEqual(openedAt);
    expect((exec.lastInboundAt as Date).getTime()).toBeGreaterThan(openedAt.getTime());
  });

  it("a retried tap event does not send the main message twice", async () => {
    await commentAndTap();
    const tap = rows("instagramEvent")[1];
    tap.processingStatus = "PENDING";
    await processInstagramEvent(String(tap.id));
    expect(mocks.sendDirectMessageWithQuickReplies).toHaveBeenCalledTimes(1);
    expect(rows("triggerFollowUpRun")).toHaveLength(2);
  });

  it("ignores a tap from someone else", async () => {
    await deliver(commentPayload("cmt1", "narx"));
    const result = await deliver(postback("mid.tap.x", `c2:${execution().id}:open`, OTHER_USER));
    expect(result.outcomes).toEqual(["ignored"]);
    expect(mocks.sendDirectMessageWithQuickReplies).not.toHaveBeenCalled();
  });

  it("MESSAGE quick reply sends its text", async () => {
    const exec = await commentAndTap();
    await deliver(message("mid.qr.1", "Manzil", `c2:${exec.id}:qr:qrMsg`));
    expect(mocks.sendDirectMessage).toHaveBeenLastCalledWith("plain:enc", IG_ID, USER, "Toshkent, Chilonzor");
  });

  it("LEAD_CAPTURE saves the phone, thanks the person and stops follow-ups", async () => {
    const exec = await commentAndTap();
    await deliver(message("mid.qr.2", "90 123 45 67", `c2:${exec.id}:qr:qrLead`));
    expect(rows("instagramContact")[0].phone).toBe("+998901234567");
    expect(exec.leadCapturedAt).toBeInstanceOf(Date);
    expect(exec.stopReason).toContain("Lead");
    expect(rows("triggerFollowUpRun").every((r) => r.status === "CANCELLED")).toBe(true);
    expect(mocks.sendDirectMessage).toHaveBeenLastCalledWith("plain:enc", IG_ID, USER, expect.stringContaining("Rahmat"));
  });

  it("LEAD_CAPTURE without our payload (Meta sent the number) still counts", async () => {
    await commentAndTap();
    await deliver(message("mid.qr.3", "+998901234567", "+998901234567"));
    expect(rows("instagramContact")[0].phone).toBe("+998901234567");
  });

  it("a phone typed without any quick-reply data counts as the lead too", async () => {
    const exec = await commentAndTap();
    await deliver(message("mid.qr.5", "90 123 45 67"));
    expect(rows("instagramContact")[0].phone).toBe("+998901234567");
    expect(exec.leadCapturedAt).toBeInstanceOf(Date);
    expect(mocks.sendDirectMessage).toHaveBeenLastCalledWith("plain:enc", IG_ID, USER, expect.stringContaining("Rahmat"));
  });

  it("claims a phone from someone with a pending lead, and only then", async () => {
    const phone = (mid: string, sender = USER) => message(mid, "+998901234567", "+998901234567", sender);
    // private reply sent, button not tapped yet: nothing pending
    await deliver(commentPayload("cmt1", "narx"));
    expect((await findClaimedLeadPhoneMessages(phone("mid.p1"))).size).toBe(0);

    await deliver(postback("mid.tap.1", `c2:${execution().id}:open`));
    expect(await findClaimedLeadPhoneMessages(phone("mid.p2"))).toEqual(new Set([storyReplyKey(IG_ID, "mid.p2")]));
    expect((await findClaimedLeadPhoneMessages(message("mid.p3", "salom"))).size).toBe(0);
    expect((await findClaimedLeadPhoneMessages(phone("mid.p4", OTHER_USER))).size).toBe(0);
    // a c2 tap is claimed by findClaimedC2Messages, not here
    expect((await findClaimedLeadPhoneMessages(message("mid.p5", "+998901234567", `c2:${execution().id}:qr:qrLead`))).size).toBe(0);

    campaign.active = false;
    expect((await findClaimedLeadPhoneMessages(phone("mid.p6"))).size).toBe(0);
    campaign.active = true;
    db.tables.triggerQuickReply = rows("triggerQuickReply").filter((r) => r.action !== "LEAD_CAPTURE");
    expect((await findClaimedLeadPhoneMessages(phone("mid.p7"))).size).toBe(0);
  });

  it("still claims the phone after the person wrote something (stop on reply), not after the lead", async () => {
    const phone = (mid: string) => message(mid, "+998901234567", "+998901234567");
    await commentAndTap();
    await deliver(message("mid.dm.9", "qancha turadi?"));
    expect(execution().stopReason).toBe("Mijoz javob yozdi");
    expect((await findClaimedLeadPhoneMessages(phone("mid.p8"))).size).toBe(1);

    await deliver(phone("mid.p8"));
    expect(rows("instagramContact")[0].phone).toBe("+998901234567");
    expect((await findClaimedLeadPhoneMessages(phone("mid.p9"))).size).toBe(0);
  });

  it("claims nothing (and does not throw) when the lookup fails", async () => {
    await commentAndTap();
    const spy = failing("triggerExecution", "findFirst");
    expect((await findClaimedLeadPhoneMessages(message("mid.p10", "+998901234567"))).size).toBe(0);
    spy.mockRestore();
  });

  it("HANDOFF marks the hand-off, alerts Telegram and stops follow-ups", async () => {
    const exec = await commentAndTap();
    await deliver(message("mid.qr.4", "Operator", `c2:${exec.id}:qr:qrOp`));
    expect(exec.handedOffAt).toBeInstanceOf(Date);
    expect(mocks.alertWorkspace).toHaveBeenCalledWith("ws1", expect.any(String), expect.stringContaining("Narx"), expect.any(String));
    expect(rows("triggerFollowUpRun").every((r) => r.status === "CANCELLED")).toBe(true);
  });

  it("a plain DM keeps the window open and stops follow-ups (stop on reply)", async () => {
    const exec = await commentAndTap();
    const result = await deliver(message("mid.dm.1", "rahmat, o'ylab ko'raman"));
    expect(result.outcomes).toEqual(["processed"]);
    expect(exec.stopReason).toBe("Mijoz javob yozdi");
    expect(rows("triggerFollowUpRun").every((r) => r.status === "CANCELLED")).toBe(true);
  });

  it("a plain DM from someone without a comment execution is ignored", async () => {
    const result = await deliver(message("mid.dm.2", "salom", undefined, OTHER_USER));
    expect(result.outcomes).toEqual(["ignored"]);
  });

  it("claims c2 quick-reply taps away from the DM keyword path and the assistant", () => {
    const payload = message("mid.qr.9", "Manzil", "c2:e1:qr:q1");
    expect(findClaimedC2Messages(payload)).toEqual(new Set([storyReplyKey(IG_ID, "mid.qr.9")]));
    expect(findClaimedC2Messages(message("mid.plain", "salom")).size).toBe(0);
    expect(isClaimedC2Payload("c2:e1:open")).toBe(true);
    expect(isClaimedC2Payload("reveal:abc")).toBe(false);
  });
});

describe("follow-up sweep", () => {
  it("sends a due step inside the window and skips one whose window closed", async () => {
    await deliver(commentPayload("cmt1", "narx"));
    const exec = execution();
    await deliver(postback("mid.tap.1", `c2:${exec.id}:open`));

    const later = new Date(Date.now() + 2 * 3600_000);
    const first = await runDueFollowUps(later);
    expect(first).toMatchObject({ sent: 1, skipped: 1 }); // ALWAYS sent; NO_CLICK skipped (tapped)
    const byStep = Object.fromEntries(rows("triggerFollowUpRun").map((r) => [r.stepId, r]));
    expect(byStep.step1).toMatchObject({ status: "SENT" });
    expect(byStep.step2).toMatchObject({ status: "SKIPPED" });
    expect(mocks.sendDirectMessage).toHaveBeenLastCalledWith("plain:enc", IG_ID, USER, "Savollaringiz bormi?");
  });

  it("skips when the window closed and cancels a stopped execution", async () => {
    campaign.openingButtonLabel = null;
    await deliver(commentPayload("cmt1", "narx"));
    await deliver(commentPayload("cmt2", "narx", { from: OTHER_USER }));
    const [a, b] = rows("triggerExecution");
    await cancelFollowUps("ws1", String(b.id), "Qo'lda bekor qilindi");

    const result = await runDueFollowUps(new Date(Date.now() + 2 * 3600_000));
    // execution a: nobody tapped or wrote → no window
    expect(rows("triggerFollowUpRun").filter((r) => r.executionId === a.id).every((r) => r.status === "SKIPPED")).toBe(true);
    expect(rows("triggerFollowUpRun").filter((r) => r.executionId === b.id).every((r) => r.status === "CANCELLED")).toBe(true);
    expect(result.sent).toBe(0);
    expect(mocks.sendDirectMessage).not.toHaveBeenCalled();
  });

  it("stop on purchase: a CRM deal won (or a lead created) cancels the follow-ups; switched off, they still go", async () => {
    await deliver(commentPayload("cmt1", "narx"));
    const exec = execution();
    await deliver(postback("mid.tap.1", `c2:${exec.id}:open`));
    db.seed("crmContact", { id: "ct1", workspaceId: "ws1", instagramAccountId: "acc1", igUserId: USER });
    db.seed("crmDeal", { id: "dl1", workspaceId: "ws1", contactId: "ct1", pipelineId: "p1", stageId: "s1", title: "Bitim", wonAt: new Date(Date.now() + 3600_000) });

    const result = await runDueFollowUps(new Date(Date.now() + 2 * 3600_000));
    expect(result.sent).toBe(0);
    expect(mocks.sendDirectMessage).not.toHaveBeenCalled();
    expect(rows("triggerFollowUpRun").filter((r) => r.status === "CANCELLED").length).toBeGreaterThan(0);
    expect(rows("triggerExecution")[0].stopReason).toContain("CRM bitim yutildi");
  });

  it("stop on purchase off: the same won deal does not stop the follow-up", async () => {
    campaign.stopOnPurchase = false;
    await deliver(commentPayload("cmt1", "narx"));
    await deliver(postback("mid.tap.1", `c2:${execution().id}:open`));
    db.seed("crmContact", { id: "ct1", workspaceId: "ws1", instagramAccountId: "acc1", igUserId: USER });
    db.seed("crmDeal", { id: "dl1", workspaceId: "ws1", contactId: "ct1", pipelineId: "p1", stageId: "s1", title: "Bitim", wonAt: new Date(Date.now() + 3600_000) });
    const result = await runDueFollowUps(new Date(Date.now() + 2 * 3600_000));
    expect(result.sent).toBe(1);
  });

  it("stop on purchase: a lead created after the answer stops the follow-ups", async () => {
    await deliver(commentPayload("cmt1", "narx"));
    await deliver(postback("mid.tap.1", `c2:${execution().id}:open`));
    db.seed("lead", { id: "ld1", workspaceId: "ws1", instagramAccountId: "acc1", igUserId: USER, createdAt: new Date(Date.now() + 1000) });
    const result = await runDueFollowUps(new Date(Date.now() + 2 * 3600_000));
    expect(result.sent).toBe(0);
    expect(rows("triggerExecution")[0].stopReason).toContain("lead yaratildi");
  });

  it("retries a temporary failure up to three tries", async () => {
    await deliver(commentPayload("cmt1", "narx"));
    await deliver(postback("mid.tap.1", `c2:${execution().id}:open`));
    mocks.sendDirectMessage.mockRejectedValue(new MetaApiError(2, undefined, "t", "temporary"));

    let at = Date.now() + 2 * 3600_000;
    await runDueFollowUps(new Date(at));
    const run = () => rows("triggerFollowUpRun").find((r) => r.stepId === "step1")!;
    expect(run()).toMatchObject({ status: "SCHEDULED", reason: expect.stringContaining("Qayta urinish 2/3") });
    at += 6 * 60_000;
    await runDueFollowUps(new Date(at));
    expect(run().reason).toContain("Qayta urinish 3/3");
    at += 6 * 60_000;
    await runDueFollowUps(new Date(at));
    expect(run()).toMatchObject({ status: "FAILED" });
  });
});

describe("production claim", () => {
  it("claims a comment an active Comment 2.0 campaign will answer", async () => {
    expect(await isCommentClaimedByCommentEngine(IG_ID, POST, "Цена?")).toBe(true);
    expect(await isCommentClaimedByCommentEngine("acc1", POST, "narxi qancha")).toBe(true);
    expect(await isCommentClaimedByCommentEngine(IG_ID, POST, "zo'r post")).toBe(false);
    expect(await isCommentClaimedByCommentEngine("17841400000000999", POST, "narx")).toBe(false);
  });

  it("reads campaigns fresh: a campaign switched off elsewhere stops claiming at once", async () => {
    expect(await isCommentClaimedByCommentEngine(IG_ID, POST, "narx")).toBe(true);
    campaign.active = false; // another process, no forget call reaches this one
    expect(await isCommentClaimedByCommentEngine(IG_ID, POST, "narx")).toBe(false);
  });

  it("caches only the answer that an account has no comment campaign", async () => {
    campaign.active = false;
    expect(await isCommentClaimedByCommentEngine(IG_ID, POST, "narx")).toBe(false);
    campaign.active = true;
    expect(await isCommentClaimedByCommentEngine(IG_ID, POST, "narx")).toBe(false); // cached "none"
    forgetCommentClaims(IG_ID);
    expect(await isCommentClaimedByCommentEngine(IG_ID, POST, "narx")).toBe(true);
  });

  it("claims nothing when the engine is off", async () => {
    vi.stubEnv("TRIGGER_ENGINE_DISABLED", "1");
    expect(await isCommentClaimedByCommentEngine(IG_ID, POST, "narx")).toBe(false);
  });

  it("honours SPECIFIC posts, including the ad's original post", async () => {
    campaign.mediaScope = "SPECIFIC";
    campaign.mediaIds = ["organic1"];
    expect(await isCommentClaimedByCommentEngine(IG_ID, "ad1", "narx")).toBe(false);
    expect(await isCommentClaimedByCommentEngine(IG_ID, "ad1", "narx", "organic1")).toBe(true);
  });

  it("hands a polled comment the production worker skipped over to the engine", async () => {
    const comment = { instagramId: IG_ID, commentId: "polled1", text: "narx?", commenterId: USER, mediaId: POST };
    expect(await handOverClaimedComment(comment)).toBe(true);
    expect(rows("instagramEvent").filter((e) => e.messageId === "polled1")).toHaveLength(1);
    expect(mocks.enqueueEvent).toHaveBeenCalledTimes(1);

    // The webhook copy (or a second poll) is already stored: no second event.
    expect(await handOverClaimedComment(comment)).toBe(false);
    expect(rows("instagramEvent").filter((e) => e.messageId === "polled1")).toHaveLength(1);
    expect(mocks.enqueueEvent).toHaveBeenCalledTimes(1);
  });

  it("hands nothing over for an unknown account or with the engine off", async () => {
    const comment = { instagramId: "17841400000000999", commentId: "x1", text: "narx", commenterId: USER, mediaId: POST };
    expect(await handOverClaimedComment(comment)).toBe(false);
    vi.stubEnv("TRIGGER_ENGINE_DISABLED", "1");
    expect(await handOverClaimedComment({ ...comment, instagramId: IG_ID })).toBe(false);
    expect(mocks.enqueueEvent).not.toHaveBeenCalled();
  });
});

describe("simulateComment", () => {
  it("previews without sending or writing", async () => {
    const before = db.log.length;
    const sim = await simulateComment("ws1", { instagramAccountId: "acc1", mediaId: POST, text: "Цена?" });
    expect(sim).toEqual({
      matched: true,
      campaignId: "camp1",
      campaignName: "Narx",
      matchKind: "INTENT",
      matchedKeyword: "PRICE: цена",
      dmPreview: "Salom! Narxni yuboraman 👇",
      publicPreview: "Direktga yozdik ✅",
    });
    expect(db.log.length).toBe(before);
    expect(rows("triggerCampaign")[0].sequenceCursor).toBe(0);
    expect(mocks.sendPrivateReplyWithButton).not.toHaveBeenCalled();
  });

  it("tests an off (draft / paused) campaign when it is named, still without sending or writing", async () => {
    campaign.active = false;
    expect(await simulateComment("ws1", { instagramAccountId: "acc1", mediaId: POST, text: "Цена?" })).toMatchObject({ matched: false });
    const before = db.log.length;
    const sim = await simulateComment("ws1", { instagramAccountId: "acc1", mediaId: POST, text: "Цена?", includeCampaignId: "camp1" });
    expect(sim).toMatchObject({ matched: true, campaignId: "camp1" });
    expect(db.log.length).toBe(before);
    expect(rows("triggerCampaign")[0].active).toBe(false);
    expect(mocks.sendPrivateReplyWithButton).not.toHaveBeenCalled();
  });

  it("explains a miss", async () => {
    expect(await simulateComment("ws1", { instagramAccountId: "acc1", mediaId: null, text: "salom" })).toEqual({
      matched: false,
      reason: "Kalit so'z yoki intent mos kelmadi",
    });
  });
});

describe("startBacktrack", () => {
  const iso = (hoursAgo: number) => new Date(Date.now() - hoursAgo * 3600_000).toISOString();

  it("queues matching comments and counts the skipped ones", async () => {
    db.seed("instagramEvent", { workspaceId: "ws1", instagramAccountId: "acc1", eventType: "COMMENT", senderId: USER, messageId: "old-known", timestamp: new Date(), rawPayload: {} });
    db.seed("dmLog", { commentId: "prod-answered", status: "SENT", automationId: "a1" });
    mocks.getUserMedia.mockResolvedValue([{ id: POST }]);
    mocks.getRecentMediaComments.mockResolvedValue([
      { id: "new1", text: "narxi qancha", timestamp: iso(5), from: { id: USER } },
      { id: "new2", text: "Цена?", timestamp: iso(30), from: { id: OTHER_USER } },
      { id: "nomatch", text: "zo'r", timestamp: iso(5), from: { id: USER } },
      { id: "old-known", text: "narx", timestamp: iso(5), from: { id: USER } },
      { id: "prod-answered", text: "narx", timestamp: iso(5), from: { id: USER } },
      { id: "expired", text: "narx", timestamp: iso(24 * 7 - 1), from: { id: USER } },
      { id: "own", text: "narx", timestamp: iso(5), from: { id: IG_ID } },
    ]);

    const { runId } = await startBacktrack("ws1", "camp1", 30);
    const run = rows("triggerBacktrackRun")[0];
    // returns at once; the scan finishes in the background
    await vi.waitFor(() => expect(run.status).not.toBe("RUNNING"));
    expect(run).toMatchObject({ id: runId, days: 7, status: "DONE", queued: 2, skippedNoMatch: 1, skippedDuplicate: 2, skippedExpired: 1, scanned: 6 });
    const queued = rows("instagramEvent").filter((e) => e.backtrackRunId === runId);
    expect(queued.map((e) => e.messageId).sort()).toEqual(["new1", "new2"]);
    expect(mocks.enqueueEvent).toHaveBeenCalledTimes(2);

    // the queued events are answered by this campaign like live comments
    await processInstagramEvent(String(queued[0].id));
    expect(rows("triggerExecution")[0]).toMatchObject({ status: "SENT", campaignId: "camp1" });
  });

  it("validates the campaign", async () => {
    await expect(startBacktrack("ws-other", "camp1", 3)).rejects.toThrow("Kampaniya topilmadi");
    campaign.triggerType = "STORY_REPLY";
    await expect(startBacktrack("ws1", "camp1", 3)).rejects.toThrow("faqat comment");
  });

  it("records a failure on the run instead of throwing", async () => {
    mocks.getUserMedia.mockRejectedValue(new MetaApiError(2, undefined, "t", "boom"));
    const { runId } = await startBacktrack("ws1", "camp1", 3);
    await vi.waitFor(() => expect(rows("triggerBacktrackRun")[0].status).not.toBe("RUNNING"));
    expect(rows("triggerBacktrackRun")[0]).toMatchObject({ id: runId, status: "FAILED", error: expect.stringContaining("Backtrack to'xtadi") });
  });

  it("returns before the scan ends and refuses a second start meanwhile", async () => {
    let finish: (value: { id: string }[]) => void = () => {};
    mocks.getUserMedia.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const { runId } = await startBacktrack("ws1", "camp1", 3);
    expect(rows("triggerBacktrackRun")[0]).toMatchObject({ id: runId, status: "RUNNING" });

    await expect(startBacktrack("ws1", "camp1", 3)).rejects.toBeInstanceOf(BacktrackConflictError);
    expect(rows("triggerBacktrackRun")).toHaveLength(1);

    finish([]);
    await vi.waitFor(() => expect(rows("triggerBacktrackRun")[0].status).toBe("DONE"));
  });

  it("of two starts racing past the check, only the oldest run goes ahead", async () => {
    mocks.getUserMedia.mockReturnValue(new Promise(() => {}));
    // a run another request created a moment earlier, after our "is one running?" check
    db.seed("triggerBacktrackRun", { id: "aaa-earlier", workspaceId: "ws1", campaignId: "camp1", days: 3, status: "RUNNING", startedAt: new Date(Date.now() - 1000) });
    const original = db.model.bind(db);
    let calls = 0;
    const race = vi.spyOn(db, "model").mockImplementation((name: string) => {
      const real = original(name);
      if (name !== "triggerBacktrackRun") return real;
      return {
        ...real,
        // the first check runs before the other request's row is visible
        findFirst: (args: Parameters<typeof real.findFirst>[0]) => (calls++ === 0 ? Promise.resolve(null) : real.findFirst(args)),
      } as typeof real;
    });
    await expect(startBacktrack("ws1", "camp1", 3)).rejects.toBeInstanceOf(BacktrackConflictError);
    race.mockRestore();
    expect(rows("triggerBacktrackRun").map((r) => r.id)).toEqual(["aaa-earlier"]);
  });

  it("lists a run stuck in RUNNING for over 30 minutes as failed", async () => {
    db.seed("triggerBacktrackRun", { id: "stuck", workspaceId: "ws1", campaignId: "camp1", days: 3, status: "RUNNING", startedAt: new Date(Date.now() - 31 * 60_000) });
    db.seed("triggerBacktrackRun", { id: "fresh", workspaceId: "ws1", campaignId: "camp1", days: 3, status: "RUNNING", startedAt: new Date() });
    await listBacktrackRuns("ws1", "camp1");
    const byId = Object.fromEntries(rows("triggerBacktrackRun").map((r) => [r.id, r]));
    expect(byId.stuck).toMatchObject({ status: "FAILED", error: expect.stringContaining("to'xtab qolgan") });
    expect(byId.fresh.status).toBe("RUNNING");
  });
});
