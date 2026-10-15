/**
 * Comment 2.0 quick replies meeting JavobAI: the AI action (LIVE → the
 * thread goes to JavobAI; otherwise HANDOFF as before) and LEAD_CAPTURE on a
 * LIVE account (a real Lead with the score prefix).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  sendDirectMessage: vi.fn(),
  sendDirectMessageWithQuickReplies: vi.fn(),
  getMessagingProfile: vi.fn(),
  reserveWorkspaceDMSend: vi.fn(),
  releaseWorkspaceDMReservation: vi.fn(),
  reserveDMSlot: vi.fn(),
  alertWorkspace: vi.fn(),
  enqueueJavobAiInbound: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  sendDirectMessage: mocks.sendDirectMessage,
  sendDirectMessageWithQuickReplies: mocks.sendDirectMessageWithQuickReplies,
  getMessagingProfile: mocks.getMessagingProfile,
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (value: string) => `plain:${value}` }));
vi.mock("@/lib/meta/token-health", () => ({ markTokenBroken: vi.fn() }));
vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: mocks.reserveWorkspaceDMSend,
  releaseWorkspaceDMReservation: mocks.releaseWorkspaceDMReservation,
}));
vi.mock("@/lib/utils/rate-limiter", () => ({ reserveDMSlot: mocks.reserveDMSlot }));
vi.mock("@/lib/telegram/notify", () => ({ alertWorkspace: mocks.alertWorkspace, notifyWorkspaceChats: vi.fn(async () => 1) }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => {}) }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({ set: async () => "OK", del: async () => 1 }) }));
vi.mock("@/lib/queue/assistant-queue", () => ({ enqueueDelivery: vi.fn(), enqueueNotify: vi.fn(), scheduleReply: vi.fn(), enqueueInbound: vi.fn(), enqueueEcho: vi.fn() }));
vi.mock("@/lib/integrations/throttle", () => ({ acquireSlot: vi.fn(async () => {}) }));
vi.mock("@/lib/javobai/queue", () => ({ enqueueJavobAiInbound: mocks.enqueueJavobAiInbound, enqueueJavobAiEcho: vi.fn(), scheduleJavobAiReply: vi.fn() }));

import { AI_HANDOFF_REASON, DEFAULT_HANDOFF_REPLY, handleDirectMessage } from "@/lib/triggers/direct-handler";
import { forgetJavobAiGate } from "@/lib/javobai/gate";
import type { EventWithAccount } from "@/lib/triggers/delivery";

const IG_ID = "17841400000000001";
const USER = "6000000000000001";
type Row = Record<string, unknown>;
const rows = (model: string) => db.rows(model);

function seed(mode: "OFF" | "LIVE") {
  db.seed("workspace", { id: "ws1", name: "Test", isSuspended: false });
  db.seed("instagramAccount", { id: "acc1", workspaceId: "ws1", instagramId: IG_ID, username: "dokon", accessToken: "enc", tokenStatus: "ACTIVE" });
  db.seed("assistantProfile", { id: "p1", workspaceId: "ws1", enabled: true, approvedAt: new Date(), companyName: "Dokon", description: "Mebel" });
  db.seed("javobAiAccount", { workspaceId: "ws1", instagramAccountId: "acc1", mode, config: {} });
  db.seed("triggerCampaign", { id: "camp1", workspaceId: "ws1", instagramAccountId: "acc1", name: "Narx", triggerType: "COMMENT", mainMessage: "Narxlar", stopOnHandoff: true, stopOnLead: false, active: true });
  db.seed("triggerQuickReply", { id: "qrAi", campaignId: "camp1", label: "AI bilan gaplashish", action: "AI", responseText: "Assistent ulandi", sort: 0 });
  db.seed("triggerQuickReply", { id: "qrAiPlain", campaignId: "camp1", label: "AI", action: "AI", responseText: null, sort: 1 });
  db.seed("triggerQuickReply", { id: "qrLead", campaignId: "camp1", label: "Raqam", action: "LEAD_CAPTURE", responseText: null, sort: 2 });
  const comment = db.seed("instagramEvent", { id: "ev1", workspaceId: "ws1", instagramAccountId: "acc1", senderId: USER, eventType: "COMMENT", messageId: "cmt1", timestamp: new Date(Date.now() - 60_000), processingStatus: "PROCESSED" });
  db.seed("triggerExecution", {
    id: "exec1", workspaceId: "ws1", eventId: comment.id, campaignId: "camp1", status: "SENT", sentAt: new Date(Date.now() - 60_000),
    openedAt: new Date(Date.now() - 30_000), lastInboundAt: new Date(Date.now() - 30_000), stoppedAt: null, stopReason: null, handedOffAt: null, leadCapturedAt: null,
  });
}

function tap(quickReplyId: string, text: string): EventWithAccount {
  const account = rows("instagramAccount")[0];
  const event = db.seed("instagramEvent", {
    workspaceId: "ws1", instagramAccountId: "acc1", senderId: USER, senderUsername: "ali", eventType: "DIRECT_MESSAGE",
    messageId: `mid.${quickReplyId}`, text, payload: `c2:exec1:qr:${quickReplyId}`, timestamp: new Date(), rawPayload: {},
  });
  return { ...event, instagramAccount: account } as unknown as EventWithAccount;
}

beforeEach(() => {
  resetDb();
  forgetJavobAiGate();
  vi.clearAllMocks();
  vi.stubEnv("TRIGGER_ENGINE_DISABLED", "");
  vi.stubEnv("JAVOBAI_DISABLED", "");
  let out = 0;
  mocks.sendDirectMessage.mockImplementation(async () => ({ recipient_id: USER, message_id: `mid.out.${++out}` }));
  mocks.getMessagingProfile.mockResolvedValue({ username: "ali", name: "Ali" });
  mocks.reserveWorkspaceDMSend.mockResolvedValue({ allowed: true, reserved: true, periodStart: new Date(), limit: 1, remaining: 1 });
  mocks.reserveDMSlot.mockResolvedValue({ allowed: true, currentCount: 1 });
  mocks.releaseWorkspaceDMReservation.mockResolvedValue({ count: 1 });
  mocks.alertWorkspace.mockResolvedValue(undefined);
  mocks.enqueueJavobAiInbound.mockResolvedValue(undefined);
});

describe("quick reply action AI", () => {
  it("LIVE: sends the optional text, stops the follow-ups and hands the thread to JavobAI", async () => {
    seed("LIVE");
    const result = await handleDirectMessage(tap("qrAi", "AI bilan gaplashish"));
    expect(result.status).toBe("PROCESSED");
    expect(mocks.sendDirectMessage).toHaveBeenCalledWith("plain:enc", IG_ID, USER, "Assistent ulandi");
    expect(rows("triggerExecution")[0]).toMatchObject({ stopReason: AI_HANDOFF_REASON, handedOffAt: null });
    expect(rows("triggerExecution")[0].stoppedAt).toBeInstanceOf(Date);
    expect(mocks.enqueueJavobAiInbound).toHaveBeenCalledWith({
      instagramAccountId: IG_ID, senderId: USER, messageId: "mid.qrAi", text: "AI bilan gaplashish", hasAttachment: false, shadow: false, source: "trigger",
    });
    const conversation = rows("conversation")[0] as Row;
    expect(conversation).toMatchObject({ instagramAccountId: "acc1", igUserId: USER, source: "CAMPAIGN" });
    expect(rows("aiConversationState")[0].context).toMatchObject({ campaignName: "Narx", executionId: "exec1", quickReplyLabel: "AI bilan gaplashish", source: "trigger" });
    expect(mocks.alertWorkspace).not.toHaveBeenCalled();
  });

  it("not LIVE: behaves exactly like HANDOFF", async () => {
    seed("OFF");
    const result = await handleDirectMessage(tap("qrAiPlain", "AI"));
    expect(result.status).toBe("PROCESSED");
    expect(mocks.sendDirectMessage).toHaveBeenCalledWith("plain:enc", IG_ID, USER, DEFAULT_HANDOFF_REPLY);
    expect(rows("triggerExecution")[0].handedOffAt).toBeInstanceOf(Date);
    expect(rows("triggerExecution")[0].stopReason).toBe("Operatorga o'tkazildi");
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(1);
    expect(mocks.enqueueJavobAiInbound).not.toHaveBeenCalled();
    expect(rows("conversation")).toHaveLength(0);
  });
});

describe("quick reply action LEAD_CAPTURE on a LIVE account", () => {
  it("also creates a real Lead with the 🧪 TEST / score prefix and an insight", async () => {
    seed("LIVE");
    const result = await handleDirectMessage(tap("qrLead", "90 123 45 67"));
    expect(result.status).toBe("PROCESSED");
    expect(rows("instagramContact")[0].phone).toBe("+998901234567");
    const lead = rows("lead")[0] as Row;
    expect(lead).toMatchObject({ workspaceId: "ws1", igUserId: USER, phoneE164: "+998901234567", source: "INBOUND_DM" });
    expect(lead.summary).toBe("🧪 TEST · ❄️ COLD 20 · Trigger kampaniyasi orqali raqam qoldirdi: Narx.");
    expect(rows("aiLeadInsight")[0]).toMatchObject({ leadId: lead.id, score: 20, temperature: "COLD", isTest: true });
    expect(rows("aiScoreEvent").map((e) => e.signal)).toEqual(["phone_provided"]);
    expect(mocks.sendDirectMessage).toHaveBeenCalledTimes(1); // the thank-you still goes out
  });

  it("OFF: no Lead (production behaviour unchanged)", async () => {
    seed("OFF");
    await handleDirectMessage(tap("qrLead", "90 123 45 67"));
    expect(rows("instagramContact")[0].phone).toBe("+998901234567");
    expect(rows("lead")).toHaveLength(0);
    expect(rows("conversation")).toHaveLength(0);
  });
});
