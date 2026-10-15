/**
 * ETAP 3 end to end against the in-memory database:
 *
 *   reactions (observation only) · Direct triggers (keywords, audience,
 *   source, cooldown, quick replies, follow-ups, taps) · quiet inside a
 *   comment conversation · Story Mention · live comments · webhook claims ·
 *   simulators.
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
import { DM_CLAIM_FAILED_REASON, forgetAccountGate, ingestWebhookPayload, storyReplyKey } from "@/lib/triggers/ingest";
import { processInstagramEvent, REACTION_OBSERVATION_REASON } from "@/lib/triggers/processor";
import { TriggerRetryableError } from "@/lib/triggers/errors";
import { forgetCommentClaims } from "@/lib/triggers/claim";
import { COMMENT_OWNS_THREAD_REASON } from "@/lib/triggers/direct-handler";
import { CLAIMED_CAMPAIGN_GONE_REASON, DM_TRIGGER_TYPES, simulateDmTrigger } from "@/lib/triggers/dm-trigger-handler";
import { LIVE_ENDED_REASON, LIVE_TOO_OLD_REASON } from "@/lib/triggers/live-handler";
import { simulateComment } from "@/lib/triggers/comment-handler";

const IG_ID = "17841400000000001";
const USER = "6000000000000001";
const OTHER_USER = "6000000000000002";

type Row = Record<string, unknown>;
const rows = (model: string) => db.rows(model);
let dmCampaign: Row;

function messaging(item: Record<string, unknown>, opts: { sender?: string; at?: number } = {}) {
  const at = opts.at ?? Date.now();
  return {
    object: "instagram",
    entry: [{ id: IG_ID, time: at, messaging: [{ sender: { id: opts.sender ?? USER }, recipient: { id: IG_ID }, timestamp: at, ...item }] }],
  };
}
const dm = (mid: string, text: string, opts: { sender?: string; at?: number; quickReply?: string; referral?: Row } = {}) =>
  messaging(
    {
      message: {
        mid,
        text,
        ...(opts.quickReply ? { quick_reply: { payload: opts.quickReply } } : {}),
        ...(opts.referral ? { referral: opts.referral } : {}),
      },
    },
    opts
  );
const mention = (mid: string, sender = USER) =>
  messaging({ message: { mid, attachments: [{ type: "story_mention", payload: { url: "https://lookaside.fbsbx.com/s" } }] } }, { sender });

function liveComment(id: string, text: string, opts: { at?: Date; from?: string } = {}) {
  return {
    object: "instagram",
    entry: [
      {
        id: IG_ID,
        time: Date.now(),
        changes: [
          {
            field: "live_comments",
            value: {
              id,
              text,
              from: { id: opts.from ?? USER, username: "ali" },
              media: { id: "live1", media_product_type: "LIVE" },
              timestamp: Math.floor((opts.at ?? new Date()).getTime() / 1000),
            },
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

const executions = () => rows("triggerExecution");
const eventRow = (messageId: string) => rows("instagramEvent").find((e) => e.messageId === messageId)!;
const allSends = () =>
  mocks.sendDirectMessage.mock.calls.length +
  mocks.sendDirectMessageWithQuickReplies.mock.calls.length +
  mocks.sendPrivateReply.mock.calls.length +
  mocks.sendPrivateReplyWithButton.mock.calls.length +
  mocks.sendCommentReply.mock.calls.length;

beforeEach(() => {
  resetDb();
  forgetAccountGate();
  forgetCommentClaims();
  vi.clearAllMocks();
  vi.stubEnv("TRIGGER_ENGINE_DISABLED", "");

  db.seed("workspace", { id: "ws1", name: "Test", isSuspended: false });
  db.seed("instagramAccount", { id: "acc1", workspaceId: "ws1", instagramId: IG_ID, username: "dokon", accessToken: "enc", tokenStatus: "ACTIVE" });
  dmCampaign = seedCampaign({
    id: "dmNarx",
    name: "Narx (Direct)",
    matchingMode: "CONTAINS",
    keywords: ["narx"],
    intents: ["PRICE"],
    replyMode: "SEQUENTIAL",
    responseMessage: "Fallback",
  });
  const approvedAt = new Date();
  db.seed("triggerReplyVariant", { id: "v1", campaignId: "dmNarx", kind: "DM", text: "Narxlar: 100 000 so'm 👇", weight: 1, sort: 0, approvedAt });
  db.seed("triggerReplyVariant", { id: "v2", campaignId: "dmNarx", kind: "DM", text: "AI qoralama", weight: 1, sort: 1, approvedAt: null });
  db.seed("triggerQuickReply", { id: "qrMsg", campaignId: "dmNarx", label: "Manzil", action: "MESSAGE", responseText: "Toshkent, Chilonzor", sort: 0 });
  db.seed("triggerQuickReply", { id: "qrLead", campaignId: "dmNarx", label: "Raqam", action: "LEAD_CAPTURE", responseText: null, sort: 1 });
  db.seed("triggerFollowUpStep", { id: "s1", campaignId: "dmNarx", sort: 0, delayMinutes: 60, condition: "ALWAYS", message: "Savollar bormi?" });
  db.seed("triggerFollowUpStep", { id: "s2", campaignId: "dmNarx", sort: 1, delayMinutes: 30, condition: "NO_CLICK", message: "Tugmani bosing" });
  db.seed("triggerFollowUpStep", { id: "s3", campaignId: "dmNarx", sort: 2, delayMinutes: 120, condition: "NO_REPLY", message: "Javob kutyapmiz" });

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

describe("contract", () => {
  it("exports the DM trigger types", () => {
    expect(DM_TRIGGER_TYPES).toEqual(["DIRECT_MESSAGE", "STORY_MENTION"]);
  });
});

describe("MESSAGE_REACTION — observation only", () => {
  it("is stored with the reaction and never answered", async () => {
    seedCampaign({ id: "mentionAll", triggerType: "STORY_MENTION" });
    const result = await deliver(messaging({ reaction: { mid: "mid.ours", action: "react", reaction: "love", emoji: "❤️" } }));
    expect(result.outcomes).toEqual(["ignored"]);
    expect(rows("instagramEvent")[0]).toMatchObject({
      eventType: "MESSAGE_REACTION",
      reaction: "❤️",
      reactedMid: "mid.ours",
      processingStatus: "IGNORED",
      error: REACTION_OBSERVATION_REASON,
    });
    expect(allSends()).toBe(0);
    expect(executions()).toHaveLength(0);
    expect(rows("instagramContact")).toHaveLength(0);
  });
});

describe("Direct trigger", () => {
  it("answers a keyword DM with the approved variant and its quick replies, opening the window", async () => {
    const result = await deliver(dm("mid.1", "Salom, narxi qancha?"));
    expect(result.outcomes).toEqual(["processed"]);
    const exec = executions()[0];
    const event = eventRow("mid.1");
    expect(exec).toMatchObject({ status: "SENT", campaignId: "dmNarx", variantId: "v1", matchedKeyword: "PRICE: narxi" });
    expect(exec.openedAt).toEqual(event.timestamp);
    expect(exec.lastInboundAt).toEqual(event.timestamp);
    expect(mocks.sendDirectMessageWithQuickReplies).toHaveBeenCalledWith("plain:enc", IG_ID, USER, "Narxlar: 100 000 so'm 👇", [
      { title: "Manzil", payload: `c2:${exec.id}:qr:qrMsg`, contentType: "text" },
      { title: "Raqam", payload: `c2:${exec.id}:qr:qrLead`, contentType: "user_phone_number" },
    ]);
    expect(rows("triggerMessage").filter((m) => m.direction === "OUTBOUND")).toHaveLength(1);
    // follow-ups from the send; NO_CLICK means nothing without a button
    expect(rows("triggerFollowUpRun").map((r) => r.stepId).sort()).toEqual(["s1", "s3"]);
    expect(rows("triggerCampaign").find((c) => c.id === "dmNarx")!.sequenceCursor).toBe(1);
  });

  it("sends a plain DM when the campaign has no quick replies", async () => {
    db.tables.triggerQuickReply = [];
    await deliver(dm("mid.1", "narx"));
    expect(mocks.sendDirectMessage).toHaveBeenCalledWith("plain:enc", IG_ID, USER, "Narxlar: 100 000 so'm 👇");
    expect(mocks.sendDirectMessageWithQuickReplies).not.toHaveBeenCalled();
  });

  it("ignores a DM no campaign matches, with the reason", async () => {
    const result = await deliver(dm("mid.1", "rahmat"));
    expect(result.outcomes).toEqual(["ignored"]);
    expect(eventRow("mid.1").error).toBe("Kalit so'z yoki intent mos kelmadi");
    expect(allSends()).toBe(0);
  });

  it("a quick-reply tap on a DM-trigger execution runs its action", async () => {
    await deliver(dm("mid.1", "narx"));
    const exec = executions()[0];
    const tap = await deliver(dm("mid.2", "Manzil", { quickReply: `c2:${exec.id}:qr:qrMsg` }));
    expect(tap.outcomes).toEqual(["processed"]);
    expect(mocks.sendDirectMessage).toHaveBeenCalledWith("plain:enc", IG_ID, USER, "Toshkent, Chilonzor");
    // the tap is no new Direct trigger
    expect(executions()).toHaveLength(1);
  });

  it("a shared phone (lead chip without payload) is captured on a DM-trigger execution", async () => {
    await deliver(dm("mid.1", "narx"));
    const result = await deliver(dm("mid.2", "+998901234567"));
    expect(result.outcomes).toEqual(["processed"]);
    expect(rows("instagramContact")[0].phone).toBe("+998901234567");
    expect(executions()[0].leadCapturedAt).toBeInstanceOf(Date);
  });

  it("a later plain DM stops the follow-ups (stop on reply)", async () => {
    await deliver(dm("mid.1", "narx"));
    await deliver(dm("mid.2", "yaxshi, o'ylab ko'raman"));
    expect(executions()[0]).toMatchObject({ stopReason: "Mijoz javob yozdi" });
    expect(rows("triggerFollowUpRun").every((r) => r.status === "CANCELLED")).toBe(true);
  });

  it("cooldown: the same campaign answers the same person once per cooldown", async () => {
    await deliver(dm("mid.1", "narx"));
    const again = await deliver(dm("mid.2", "narx?"));
    expect(again.outcomes).toEqual(["processed"]); // booked on the first execution, not answered
    expect(executions()).toHaveLength(1);
    expect(mocks.sendDirectMessageWithQuickReplies).toHaveBeenCalledTimes(1);

    // another person is not affected
    await deliver(dm("mid.3", "narx", { sender: OTHER_USER }));
    expect(executions()).toHaveLength(2);

    // once the cooldown has passed, the campaign answers again (the cooldown
    // now counts executions by createdAt and claimed events by timestamp, so
    // the message is sent 25h later instead of back-dating sentAt)
    await deliver(dm("mid.4", "narx", { at: Date.now() + 25 * 3600_000 }));
    expect(executions()).toHaveLength(3);
  });

  it("audience: a new contact, then a returning one", async () => {
    dmCampaign.active = false;
    seedCampaign({ id: "fresh", audience: "NEW_CONTACT", responseMessage: "Xush kelibsiz!" });
    seedCampaign({ id: "back", audience: "RETURNING_CONTACT", responseMessage: "Yana salom!" });
    await deliver(dm("mid.1", "salom"));
    await deliver(dm("mid.2", "salom"));
    expect(executions().map((e) => e.campaignId)).toEqual(["fresh", "back"]);
  });

  it("audience REOPENED: the previous message is older than reopenAfterHours", async () => {
    dmCampaign.active = false;
    seedCampaign({ id: "reopen", audience: "REOPENED", reopenAfterHours: 72, responseMessage: "Qaytganingizdan xursandmiz" });
    const history = (sender: string, hoursAgo: number) => {
      const at = new Date(Date.now() - hoursAgo * 3600_000);
      db.seed("instagramContact", { workspaceId: "ws1", instagramAccountId: "acc1", igUserId: sender, interactionCount: 1, firstInteractionAt: at, lastInteractionAt: at, source: "DIRECT_MESSAGE" });
      db.seed("instagramEvent", {
        workspaceId: "ws1", instagramAccountId: "acc1", eventType: "DIRECT_MESSAGE", senderId: sender, messageId: `old.${sender}`,
        timestamp: at, processingStatus: "IGNORED", rawPayload: {},
      });
    };
    history(USER, 100);
    history(OTHER_USER, 2);
    await deliver(dm("mid.1", "salom"));
    const quick = await deliver(dm("mid.2", "salom", { sender: OTHER_USER }));
    expect(executions().map((e) => e.campaignId)).toEqual(["reopen"]);
    expect(quick.outcomes).toEqual(["ignored"]);
    expect(eventRow("mid.2").error).toContain("Auditoriya");
  });

  it("source ADS: the ad campaign answers its ad, the general one everything else", async () => {
    dmCampaign.active = false;
    seedCampaign({ id: "general", responseMessage: "Salom!" });
    seedCampaign({ id: "ad", sourceFilter: "ADS", adIds: ["120210000000000001"], responseMessage: "Reklamadan keldingiz!" });
    const referral = { ad_id: "120210000000000001", source: "ADS", type: "OPEN_THREAD", ads_context_data: { ad_title: "Kurs" } };
    await deliver(dm("mid.1", "Salom", { referral }));
    await deliver(dm("mid.2", "Salom", { sender: OTHER_USER, referral: { ...referral, ad_id: "999" } }));
    expect(executions().map((e) => e.campaignId)).toEqual(["ad", "general"]);
    expect(eventRow("mid.1")).toMatchObject({ referralSource: "ADS", adId: "120210000000000001" });
  });

  it("source LINK: an ig.me link open (no text) is greeted by the link campaign", async () => {
    seedCampaign({ id: "link", sourceFilter: "LINK", refs: ["bahor"], responseMessage: "Aksiya haqida 👇" });
    const result = await deliver(messaging({ referral: { ref: "bahor", source: "SHORTLINK", type: "OPEN_THREAD" } }));
    expect(result.outcomes).toEqual(["processed"]);
    expect(executions()[0]).toMatchObject({ campaignId: "link", status: "SENT" });
    expect(mocks.sendDirectMessage).toHaveBeenCalledWith("plain:enc", IG_ID, USER, "Aksiya haqida 👇");
  });

  it("stays quiet inside an active comment conversation, but books the reply there", async () => {
    seedCampaign({ id: "cmt", triggerType: "COMMENT", stopOnReply: true });
    const commentEvent = db.seed("instagramEvent", {
      workspaceId: "ws1", instagramAccountId: "acc1", eventType: "COMMENT", senderId: USER, messageId: "c1",
      timestamp: new Date(Date.now() - 3600_000), processingStatus: "PROCESSED", rawPayload: {},
    });
    db.seed("triggerExecution", {
      workspaceId: "ws1", eventId: commentEvent.id, campaignId: "cmt", status: "SENT", responseText: "x",
      sentAt: new Date(Date.now() - 3600_000), openedAt: null, lastInboundAt: null, stoppedAt: null, stopReason: null, handedOffAt: null,
    });

    const result = await deliver(dm("mid.1", "narx"));
    expect(result.claimed).toEqual(new Map()); // the DM keyword path / assistant answer instead
    expect(result.outcomes).toEqual(["processed"]);
    expect(eventRow("mid.1").error).toBe(COMMENT_OWNS_THREAD_REASON);
    expect(allSends()).toBe(0);
    expect(executions()[0].lastInboundAt).toEqual(eventRow("mid.1").timestamp);

    // the comment flow was stopped by that reply: the next DM gets the Direct answer
    await deliver(dm("mid.2", "narx", { at: Date.now() + 1000 }));
    expect(executions().map((e) => e.campaignId)).toEqual(["cmt", "dmNarx"]);
  });

  it("a comment conversation older than 24h does not keep Direct quiet", async () => {
    seedCampaign({ id: "cmt", triggerType: "COMMENT" });
    const commentEvent = db.seed("instagramEvent", {
      workspaceId: "ws1", instagramAccountId: "acc1", eventType: "COMMENT", senderId: USER, messageId: "c1",
      timestamp: new Date(Date.now() - 30 * 3600_000), processingStatus: "PROCESSED", rawPayload: {},
    });
    db.seed("triggerExecution", {
      workspaceId: "ws1", eventId: commentEvent.id, campaignId: "cmt", status: "SENT", responseText: "x",
      sentAt: new Date(Date.now() - 30 * 3600_000), openedAt: null, lastInboundAt: null, stoppedAt: null, stopReason: null, handedOffAt: null,
    });
    await deliver(dm("mid.1", "narx"));
    expect(mocks.sendDirectMessageWithQuickReplies).toHaveBeenCalledTimes(1);
  });

  it("a send failure is retried and keeps the campaign chosen first", async () => {
    mocks.sendDirectMessageWithQuickReplies.mockRejectedValueOnce(new MetaApiError(2, undefined, "t", "temporary"));
    const first = await deliver(dm("mid.1", "narx"));
    expect(first.outcomes).toEqual(["retrying"]);
    expect(executions()[0]).toMatchObject({ status: "RETRYING" });
    expect(await processInstagramEvent(String(eventRow("mid.1").id))).toBe("processed");
    expect(executions()).toHaveLength(1);
    expect(executions()[0]).toMatchObject({ status: "SENT", variantId: "v1" });
  });
});

describe("Story Mention", () => {
  it("an EVERY mention campaign thanks the person", async () => {
    seedCampaign({ id: "mention", triggerType: "STORY_MENTION", responseMessage: "Belgilaganingiz uchun rahmat! 🎁" });
    const result = await deliver(mention("mid.m1"));
    expect(result.outcomes).toEqual(["processed"]);
    expect(executions()[0]).toMatchObject({ campaignId: "mention", status: "SENT" });
    expect(mocks.sendDirectMessage).toHaveBeenCalledWith("plain:enc", IG_ID, USER, "Belgilaganingiz uchun rahmat! 🎁");
    expect(eventRow("mid.m1")).toMatchObject({ eventType: "STORY_MENTION", text: "", storyUrl: "https://lookaside.fbsbx.com/s" });
  });

  it("is ignored without a mention campaign", async () => {
    const result = await deliver(mention("mid.m1"));
    expect(result.outcomes).toEqual(["ignored"]);
    expect(eventRow("mid.m1").error).toBe("Story mention uchun faol kampaniya yo'q");
  });
});

describe("Live comments", () => {
  beforeEach(() => {
    seedCampaign({
      id: "live",
      triggerType: "LIVE_COMMENT",
      matchingMode: "CONTAINS",
      keywords: ["narx"],
      responseMessage: "Efirdagi narxlar 👇",
      publicReplyEnabled: true, // never used for live comments
      openingButtonLabel: "Ko'rish",
      mainMessage: "Narxlar ro'yxati",
    });
  });

  it("sends one private reply with the opening button and no public reply", async () => {
    const result = await deliver(liveComment("lc1", "narx?"));
    expect(result.outcomes).toEqual(["processed"]);
    const exec = executions()[0];
    expect(exec).toMatchObject({ campaignId: "live", status: "SENT" });
    expect(mocks.sendPrivateReplyWithButton).toHaveBeenCalledWith("plain:enc", IG_ID, "lc1", "Efirdagi narxlar 👇", "Ko'rish", `c2:${exec.id}:open`);
    expect(mocks.sendCommentReply).not.toHaveBeenCalled();

    // the tap continues like a comment campaign's
    await deliver(messaging({ postback: { mid: "pb1", title: "Ko'rish", payload: `c2:${exec.id}:open` } }));
    expect(mocks.sendDirectMessage).toHaveBeenCalledWith("plain:enc", IG_ID, USER, "Narxlar ro'yxati");
  });

  it("a refused private reply is final: no retry, the live has most likely ended", async () => {
    mocks.sendPrivateReplyWithButton.mockRejectedValueOnce(new MetaApiError(2, undefined, "t", "temporary"));
    const result = await deliver(liveComment("lc1", "narx"));
    expect(result.outcomes).toEqual(["failed"]);
    expect(executions()[0]).toMatchObject({ status: "FAILED", error: LIVE_ENDED_REASON });
    expect(rows("instagramEvent")[0]).toMatchObject({ processingStatus: "FAILED" });
  });

  it("a comment older than the longest broadcast is skipped", async () => {
    await deliver(liveComment("lc1", "narx", { at: new Date(Date.now() - 5 * 3600_000) }));
    expect(executions()[0]).toMatchObject({ status: "SKIPPED", error: LIVE_TOO_OLD_REASON });
    expect(allSends()).toBe(0);
  });

  it("post comments do not reach live campaigns", async () => {
    const result = await deliver({
      object: "instagram",
      entry: [{ id: IG_ID, changes: [{ field: "comments", value: { id: "c1", text: "narx", from: { id: USER }, media: { id: "p1" } } }] }],
    });
    expect(result.outcomes).toEqual(["ignored"]);
  });
});

describe("Webhook claim (DM keyword path / assistant step aside)", () => {
  // The claim is the ingest itself now: the decision is made once, stored on
  // the event (claimedCampaignId), and ingestWebhookPayload returns the
  // claimed keys the webhook route keeps away from production.
  const key = (mid: string) => storyReplyKey(IG_ID, mid);
  const claims = async (payload: unknown) => (await ingestWebhookPayload(payload)).claimed;

  it("claims a DM an active Direct campaign will answer, not one it will not", async () => {
    expect(await claims(dm("mid.1", "narxi qancha"))).toEqual(new Map([[key("mid.1"), "dmNarx"]]));
    expect(await claims(dm("mid.2", "rahmat", { sender: OTHER_USER }))).toEqual(new Map());
    expect(eventRow("mid.1").claimedCampaignId).toBe("dmNarx");
    expect(eventRow("mid.2")).toMatchObject({ claimedCampaignId: null });
  });

  it("claims a story mention and an ad message", async () => {
    seedCampaign({ id: "mention", triggerType: "STORY_MENTION" });
    seedCampaign({ id: "ad", sourceFilter: "ADS" });
    expect(await claims(mention("mid.m"))).toEqual(new Map([[key("mid.m"), "mention"]]));
    expect(await claims(dm("mid.a", "Salom", { sender: OTHER_USER, referral: { source: "ADS", ad_id: "1" } }))).toEqual(
      new Map([[key("mid.a"), "ad"]])
    );
  });

  it("never claims a quick-reply tap (the handler never answers one with a DM trigger)", async () => {
    expect(await claims(dm("mid.1", "narx", { quickReply: "c2:exec1:qr:qr1" }))).toEqual(new Map());
  });

  it("does not claim during the cooldown, but keeps claiming a redelivered answered message", async () => {
    await deliver(dm("mid.1", "narx"));
    expect(await claims(dm("mid.1", "narx"))).toEqual(new Map([[key("mid.1"), "dmNarx"]]));
    expect(await claims(dm("mid.2", "narx"))).toEqual(new Map());
  });

  it("respects the audience before the event (history = stored events of the person)", async () => {
    // Was seeded through InstagramContact.interactionCount: the decision now
    // reads the person's stored events instead (the same rows at webhook time
    // and later, unlike a counter the worker bumps).
    dmCampaign.audience = "NEW_CONTACT";
    expect(await claims(dm("mid.1", "narx"))).toEqual(new Map([[key("mid.1"), "dmNarx"]]));
    db.seed("instagramEvent", {
      workspaceId: "ws1", instagramAccountId: "acc1", eventType: "COMMENT", senderId: OTHER_USER, messageId: "c.old",
      timestamp: new Date(Date.now() - 3600_000), processingStatus: "PROCESSED", rawPayload: {},
    });
    expect(await claims(dm("mid.2", "narx", { sender: OTHER_USER }))).toEqual(new Map());
  });

  it("claims nothing for accounts without campaigns, when disabled, or on errors", async () => {
    const other = { object: "instagram", entry: [{ id: "999", messaging: [{ sender: { id: USER }, message: { mid: "x", text: "narx" } }] }] };
    expect(await claims(other)).toEqual(new Map());
    vi.stubEnv("TRIGGER_ENGINE_DISABLED", "1");
    expect(await claims(dm("mid.1", "narx"))).toEqual(new Map());
    vi.stubEnv("TRIGGER_ENGINE_DISABLED", "");
    const spy = vi.spyOn(db, "model").mockImplementation(() => {
      throw new Error("db down");
    });
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    forgetAccountGate();
    const result = await ingestWebhookPayload(dm("mid.1", "narx"));
    expect(result.claimed).toEqual(new Map());
    expect(result.failed).toBe(1);
    spy.mockRestore();
    error.mockRestore();
  });
});

describe("One webhook decision per DM (claimedCampaignId)", () => {
  const key = (mid: string) => storyReplyKey(IG_ID, mid);
  const T0 = Date.now() - 60_000;
  /** Several messages from the same person in one webhook payload. */
  const batch = (...items: Array<{ mid: string; text: string; at: number }>) => ({
    object: "instagram",
    entry: [
      {
        id: IG_ID,
        time: T0,
        messaging: items.map((item) => ({
          sender: { id: USER },
          recipient: { id: IG_ID },
          timestamp: item.at,
          message: { mid: item.mid, text: item.text },
        })),
      },
    ],
  });
  async function processAll(ids: string[]) {
    const outcomes = [];
    for (const id of ids) {
      try {
        outcomes.push(await processInstagramEvent(id));
      } catch (error) {
        if (error instanceof TriggerRetryableError) outcomes.push("retrying");
        else throw error;
      }
    }
    return outcomes;
  }

  beforeEach(() => {
    dmCampaign.active = false;
    seedCampaign({ id: "fresh", audience: "NEW_CONTACT", cooldownHours: 24, responseMessage: "Xush kelibsiz!" });
  });

  it("two messages from a new person in one payload: exactly one is claimed, the other goes to production", async () => {
    // Same timestamp on purpose: the earlier message of the payload is history all the same.
    const result = await ingestWebhookPayload(batch({ mid: "mid.1", text: "salom", at: T0 }, { mid: "mid.2", text: "salom", at: T0 }));
    expect(result.claimed).toEqual(new Map([[key("mid.1"), "fresh"]]));
    expect(eventRow("mid.2").claimedCampaignId).toBeNull();

    await processAll(result.stored);
    expect(mocks.sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(executions().map((e) => e.campaignId)).toEqual(["fresh"]);
  });

  it("two concurrent webhooks for the same new person: the per-person lock lets only one claim", async () => {
    const [a, b] = await Promise.all([
      ingestWebhookPayload(dm("mid.1", "salom", { at: T0 })),
      ingestWebhookPayload(dm("mid.2", "salom", { at: T0 + 1 })),
    ]);
    const claimed = new Map([...a.claimed, ...b.claimed]);
    expect(claimed.size).toBe(1);
    expect([...claimed.values()]).toEqual(["fresh"]);
    // the lock is a Postgres advisory transaction lock keyed by account + sender
    const locks = db.raw.filter((r) => r.sql.includes("pg_advisory_xact_lock"));
    expect(locks).toHaveLength(2);
    expect(locks[0].values).toEqual([`acc1:${USER}`]);

    await processAll([...a.stored, ...b.stored]);
    expect(mocks.sendDirectMessage).toHaveBeenCalledTimes(1);
  });

  it("NEW then RETURNING: both decided at the webhook, before any processing; the worker follows them (no double reply)", async () => {
    seedCampaign({ id: "back", audience: "RETURNING_CONTACT", cooldownHours: 24, responseMessage: "Yana salom!" });
    // Both webhooks arrive before the worker ran (the old claim read a counter
    // the worker had not bumped yet and disagreed with the handler).
    const first = await ingestWebhookPayload(dm("mid.1", "salom", { at: T0 }));
    const second = await ingestWebhookPayload(dm("mid.2", "salom", { at: T0 + 1000 }));
    expect(first.claimed).toEqual(new Map([[key("mid.1"), "fresh"]]));
    expect(second.claimed).toEqual(new Map([[key("mid.2"), "back"]]));

    await processAll([...first.stored, ...second.stored]);
    expect(executions().map((e) => [e.campaignId, e.status])).toEqual([
      ["fresh", "SENT"],
      ["back", "SENT"],
    ]);
    expect(mocks.sendDirectMessage.mock.calls.map((c) => c[3])).toEqual(["Xush kelibsiz!", "Yana salom!"]);
  });

  it("a retry after RETRYING sends with the claimed campaign and is not silenced by a stale comment thread", async () => {
    dmCampaign.active = true;
    seedCampaign({ id: "cmt", triggerType: "COMMENT", stopOnReply: false });
    const commentEvent = db.seed("instagramEvent", {
      workspaceId: "ws1", instagramAccountId: "acc1", eventType: "COMMENT", senderId: USER, messageId: "c1",
      timestamp: new Date(Date.now() - 30 * 3600_000), processingStatus: "PROCESSED", rawPayload: {},
    });
    const stale = db.seed("triggerExecution", {
      workspaceId: "ws1", eventId: commentEvent.id, campaignId: "cmt", status: "SENT", responseText: "x",
      sentAt: new Date(Date.now() - 30 * 3600_000), openedAt: null, lastInboundAt: null, stoppedAt: null, stopReason: null, handedOffAt: null,
    });
    mocks.sendDirectMessageWithQuickReplies.mockRejectedValueOnce(new MetaApiError(2, undefined, "t", "temporary"));

    const first = await deliver(dm("mid.1", "narx"));
    expect(first.outcomes).toEqual(["retrying"]);
    // the stale comment execution was not revived by the DM
    expect(stale.lastInboundAt).toBeNull();

    // a more specific campaign appears before the retry: the claim still decides
    seedCampaign({ id: "exact", matchingMode: "EXACT", keywords: ["narx"], priority: 10, responseMessage: "Boshqa" });
    expect(await processInstagramEvent(String(eventRow("mid.1").id))).toBe("processed");
    expect(executions().filter((e) => e.campaignId !== "cmt")).toEqual([
      expect.objectContaining({ campaignId: "dmNarx", status: "SENT" }),
    ]);
    expect(mocks.sendDirectMessageWithQuickReplies).toHaveBeenCalledTimes(2);
  });

  it("a claimed campaign switched off before the worker ran: IGNORED with the reason and a visible warning", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await ingestWebhookPayload(dm("mid.1", "salom", { at: T0 }));
    expect(result.claimed).toEqual(new Map([[key("mid.1"), "fresh"]]));
    rows("triggerCampaign").find((c) => c.id === "fresh")!.active = false;

    expect(await processInstagramEvent(result.stored[0])).toBe("ignored");
    expect(eventRow("mid.1")).toMatchObject({ processingStatus: "IGNORED", error: CLAIMED_CAMPAIGN_GONE_REASON });
    expect(allSends()).toBe(0);
    expect(rows("operationalEvent")).toEqual([
      expect.objectContaining({ level: "WARNING", workspaceId: "ws1", payload: { eventId: result.stored[0], campaignId: "fresh" } }),
    ]);
    warn.mockRestore();
  });

  it("a claimed campaign deleted before the worker ran (foreign key cleared the claim): same", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await ingestWebhookPayload(dm("mid.1", "salom", { at: T0 }));
    eventRow("mid.1").claimedCampaignId = null; // ON DELETE SET NULL
    expect(await processInstagramEvent(result.stored[0])).toBe("ignored");
    expect(eventRow("mid.1").error).toBe(CLAIMED_CAMPAIGN_GONE_REASON);
    expect(allSends()).toBe(0);
    warn.mockRestore();
  });

  it("a stale comment execution is not revived by a DM; an active one is booked", async () => {
    seedCampaign({ id: "cmt", triggerType: "COMMENT", stopOnReply: false });
    const execution = (messageId: string, hoursAgo: number) => {
      const ev = db.seed("instagramEvent", {
        workspaceId: "ws1", instagramAccountId: "acc1", eventType: "COMMENT", senderId: USER, messageId,
        timestamp: new Date(Date.now() - hoursAgo * 3600_000), processingStatus: "PROCESSED", rawPayload: {},
      });
      return db.seed("triggerExecution", {
        workspaceId: "ws1", eventId: ev.id, campaignId: "cmt", status: "SENT", responseText: "x",
        sentAt: new Date(Date.now() - hoursAgo * 3600_000), openedAt: null, lastInboundAt: null, stoppedAt: null, stopReason: null, handedOffAt: null,
      });
    };
    const stale = execution("c.stale", 30);
    const active = execution("c.active", 2);
    await deliver(dm("mid.1", "rahmat"));
    expect(stale.lastInboundAt).toBeNull();
    expect(active.lastInboundAt).toEqual(eventRow("mid.1").timestamp);
  });

  it("a redelivered webhook keeps the original decision, and production still skips a claimed message", async () => {
    const first = await deliver(dm("mid.1", "salom", { at: T0 }));
    expect(first.outcomes).toEqual(["processed"]);
    // now in the cooldown and no longer a new contact — but the event was decided already
    const again = await ingestWebhookPayload(dm("mid.1", "salom", { at: T0 }));
    expect(again).toMatchObject({ stored: [], duplicates: 1 });
    expect(again.claimed).toEqual(new Map([[key("mid.1"), "fresh"]]));

    // an unclaimed message stays unclaimed, even if a campaign would take it now
    const other = await ingestWebhookPayload(dm("mid.2", "salom", { at: T0 + 1000 }));
    expect(other.claimed).toEqual(new Map());
    seedCampaign({ id: "everyone", responseMessage: "Salom!" });
    expect((await ingestWebhookPayload(dm("mid.2", "salom", { at: T0 + 1000 }))).claimed).toEqual(new Map());
    expect(rows("instagramEvent")).toHaveLength(2);
  });

  it("a failed claim (lock / transaction error) claims nothing; the event is stored unclaimed and not answered", async () => {
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    db.transactionError = new Error("canceling statement due to lock timeout");
    const result = await ingestWebhookPayload(dm("mid.1", "salom", { at: T0 }));
    expect(result.claimed).toEqual(new Map());
    expect(result.stored).toHaveLength(1);
    expect(eventRow("mid.1").claimedCampaignId).toBeNull();
    db.transactionError = null;

    expect(await processInstagramEvent(result.stored[0])).toBe("ignored");
    expect(eventRow("mid.1").error).toBe(DM_CLAIM_FAILED_REASON);
    expect(allSends()).toBe(0);
    error.mockRestore();
  });
});

describe("Simulators", () => {
  it("simulateDmTrigger shows the campaign, reply and chips without writing", async () => {
    seedCampaign({ id: "back", audience: "RETURNING_CONTACT", matchingMode: "EXACT", keywords: ["narx"], responseMessage: "Yana salom" });
    const before = db.log.length;
    const fresh = await simulateDmTrigger("ws1", { instagramAccountId: IG_ID, eventType: "DIRECT_MESSAGE", text: "narxi qancha" });
    expect(fresh).toEqual({
      matched: true,
      campaignId: "dmNarx",
      campaignName: "Narx (Direct)",
      matchKind: "INTENT",
      matchedKeyword: "PRICE: narxi",
      replyPreview: "Narxlar: 100 000 so'm 👇",
      quickReplies: ["Manzil", "Raqam"],
    });
    const returning = await simulateDmTrigger("ws1", { instagramAccountId: "acc1", eventType: "DIRECT_MESSAGE", text: "Narx", contactState: "RETURNING" });
    expect(returning).toMatchObject({ campaignId: "back", matchKind: "EXACT" });
    const none = await simulateDmTrigger("ws1", { instagramAccountId: IG_ID, eventType: "STORY_MENTION", text: "" });
    expect(none).toEqual({ matched: false, reason: "Story mention uchun faol kampaniya yo'q" });
    expect(db.log.length).toBe(before);
    expect(allSends()).toBe(0);
    expect(rows("triggerCampaign").find((c) => c.id === "dmNarx")!.sequenceCursor).toBe(0);
  });

  it("simulateDmTrigger applies source filters", async () => {
    seedCampaign({ id: "ad", sourceFilter: "ADS", adIds: ["ad1"], responseMessage: "Reklama" });
    expect(await simulateDmTrigger("ws1", { instagramAccountId: IG_ID, eventType: "DIRECT_MESSAGE", text: "salom", referralSource: "ADS", adId: "ad1" })).toMatchObject({ campaignId: "ad" });
    expect(await simulateDmTrigger("ws1", { instagramAccountId: IG_ID, eventType: "DIRECT_MESSAGE", text: "salom", referralSource: "ADS", adId: "ad2" })).toMatchObject({ matched: false });
  });

  it("simulateComment checks live-comment campaigns when asked", async () => {
    seedCampaign({ id: "cmt", triggerType: "COMMENT", matchingMode: "CONTAINS", keywords: ["narx"], publicReplyEnabled: true, responseMessage: "Post" });
    seedCampaign({ id: "live", triggerType: "LIVE_COMMENT", matchingMode: "CONTAINS", keywords: ["narx"], publicReplyEnabled: true, responseMessage: "Live" });
    db.seed("triggerReplyVariant", { campaignId: "live", kind: "PUBLIC", text: "ochiq", weight: 1, sort: 0, approvedAt: new Date() });
    const live = await simulateComment("ws1", { instagramAccountId: IG_ID, mediaId: null, text: "narx", eventType: "LIVE_COMMENT" });
    expect(live).toMatchObject({ matched: true, campaignId: "live", dmPreview: "Live" });
    expect(live.publicPreview).toBeUndefined();
    expect(await simulateComment("ws1", { instagramAccountId: IG_ID, mediaId: null, text: "narx" })).toMatchObject({ campaignId: "cmt" });
  });
});
