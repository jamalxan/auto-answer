/**
 * ETAP 5.0 — the merged timeline read live from the stores (design 4a):
 * comment → reply → DM → AI reply → lead → delivery in order, the same
 * message in two stores shown once, keyset paging. In-memory database.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/client", () => ({ getRedisConnection: () => ({}) }));

import { upsertContactFromParts } from "../lib/crm/contacts";
import { loadTimeline } from "../lib/crm/timeline";
import { db, resetDb } from "./helpers/db-instance";

const at = (minutes: number) => new Date(Date.UTC(2026, 9, 16, 12, minutes));

async function seedWorld() {
  db.seed("workspace", { id: "w1", ownerId: "owner" });
  db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "shop", instagramId: "ig1" });
  db.seed("instagramContact", { id: "ic1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "u1", username: "aziz", source: "COMMENT", firstInteractionAt: at(0), lastInteractionAt: at(0) });
  db.seed("triggerConversation", { id: "tc1", workspaceId: "w1", instagramAccountId: "a1", contactId: "ic1", lastMessageAt: at(0) });
  db.seed("triggerCampaign", { id: "camp1", workspaceId: "w1", instagramAccountId: "a1", name: "IELTS post" });
  db.seed("conversation", { id: "c1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "u1" });

  // 0: comment (InstagramEvent + the TriggerMessage copy)
  db.seed("instagramEvent", { id: "ev1", workspaceId: "w1", instagramAccountId: "a1", eventType: "COMMENT", senderId: "u1", messageId: "cmt1", text: "Narxi?", timestamp: at(0), rawPayload: {}, contactId: "ic1" });
  db.seed("triggerMessage", { id: "tm1", conversationId: "tc1", direction: "INBOUND", eventType: "COMMENT", text: "Narxi?", mid: "cmt1", eventId: "ev1", createdAt: at(0) });
  // 1: comment reply (TriggerExecution; its DM copy in TriggerMessage shares the mid)
  db.seed("triggerExecution", { id: "te1", workspaceId: "w1", eventId: "ev1", campaignId: "camp1", status: "SENT", responseText: "Direct'ga yozdik", sentMessageId: "m-reply", sentAt: at(1), createdAt: at(1) });
  db.seed("triggerMessage", { id: "tm2", conversationId: "tc1", direction: "OUTBOUND", text: "Direct'ga yozdik", mid: "m-reply", executionId: "te1", createdAt: at(1) });
  db.seed("triggerFollowUpRun", { id: "fr1", workspaceId: "w1", executionId: "te1", stepId: "st1", status: "SENT", scheduledAt: at(1), sentAt: at(2) });
  // 3: DM from the person (InstagramEvent + the assistant's ConversationMessage share the mid)
  db.seed("instagramEvent", { id: "ev2", workspaceId: "w1", instagramAccountId: "a1", eventType: "DIRECT_MESSAGE", senderId: "u1", messageId: "m-in", text: "Salom", timestamp: at(3), rawPayload: {} });
  db.seed("conversationMessage", { id: "cm1", conversationId: "c1", mid: "m-in", author: "CUSTOMER", text: "Salom", createdAt: at(3) });
  // 4: AI reply
  db.seed("conversationMessage", { id: "cm2", conversationId: "c1", mid: "m-ai", author: "ASSISTANT", text: "Assalomu alaykum", createdAt: at(4) });
  // 5: lead, 6: delivery
  db.seed("lead", { id: "l1", workspaceId: "w1", instagramAccountId: "a1", conversationId: "c1", igUserId: "u1", idempotencyKey: "c1:0", summary: "Kurs", createdAt: at(5) });
  db.seed("integration", { id: "int1", workspaceId: "w1", type: "TELEGRAM", name: "Telegram" });
  db.seed("leadDelivery", { id: "ld1", leadId: "l1", integrationId: "int1", status: "SENT", sentAt: at(6) });
  // 7: handoff opened, 8: accepted
  db.seed("aiHandoff", { id: "h1", conversationId: "c1", reason: "score", openedAt: at(7), status: "ACCEPTED", acceptedAt: at(8), acceptedBy: "echo" });
  // 9: score signal
  db.seed("aiConversationState", { id: "s1", conversationId: "c1", score: 40 });
  db.seed("aiScoreEvent", { stateId: "s1", leadCycle: 0, signal: "phone_provided", points: 20, createdAt: at(9) });

  const contact = await upsertContactFromParts({ workspaceId: "w1", instagramAccountId: "a1", igUserId: "u1", conversationId: "c1", instagramContactId: "ic1" });
  // 10: a note; a LEAD_CREATED activity synced from the Lead row must not double the live item
  db.seed("crmActivity", { workspaceId: "w1", contactId: contact.id, type: "NOTE", occurredAt: at(10), actorKind: "OPERATOR", title: "Eslatma", body: "Ertaga qo'ng'iroq" });
  db.seed("crmActivity", { workspaceId: "w1", contactId: contact.id, type: "LEAD_CREATED", occurredAt: at(5), actorKind: "SYSTEM", title: "Lead yaratildi", sourceTable: "Lead", sourceId: "l1" });
  return contact;
}

beforeEach(() => resetDb());

describe("loadTimeline", () => {
  it("merges the stores newest first and shows each message once", async () => {
    const contact = await seedWorld();
    const page = await loadTimeline("w1", contact.id, { limit: 50 });
    expect(page.hasMore).toBe(false);
    expect(page.items.map((i) => `${i.type}:${i.sourceTable}`)).toEqual([
      "NOTE:CrmActivity",
      "SCORE_CHANGED:AiScoreEvent",
      "HANDOFF_ACCEPTED:AiHandoff",
      "HANDOFF_OPENED:AiHandoff",
      "LEAD_DELIVERED:LeadDelivery",
      "LEAD_CREATED:Lead",
      "AI_REPLY:ConversationMessage",
      "INBOUND_MESSAGE:ConversationMessage", // the InstagramEvent copy of m-in is deduped
      "FOLLOW_UP_SENT:TriggerFollowUpRun",
      "AUTOMATION_REPLY:TriggerMessage", // the TriggerExecution copy of m-reply is deduped
      "COMMENT:TriggerMessage", // the InstagramEvent copy of cmt1 is deduped
    ]);
    expect(page.items.find((i) => i.type === "LEAD_DELIVERED")?.title).toBe("Lead yetkazildi: Telegram");
    expect(page.items.find((i) => i.type === "SCORE_CHANGED")?.title).toBe("Ball +20: phone_provided");
    expect(page.items.find((i) => i.type === "COMMENT")?.body).toBe("Narxi?");
  });

  it("pages with `before` and refuses another workspace", async () => {
    const contact = await seedWorld();
    const first = await loadTimeline("w1", contact.id, { limit: 3 });
    expect(first.items.map((i) => i.type)).toEqual(["NOTE", "SCORE_CHANGED", "HANDOFF_ACCEPTED"]);
    expect(first.hasMore).toBe(true);
    expect(first.nextBefore).toEqual(at(8));
    const second = await loadTimeline("w1", contact.id, { limit: 3, before: first.nextBefore });
    expect(second.items.map((i) => i.type)).toEqual(["HANDOFF_OPENED", "LEAD_DELIVERED", "LEAD_CREATED"]);
    const third = await loadTimeline("w1", contact.id, { limit: 10, before: second.nextBefore });
    expect(third.items.map((i) => i.type)).toEqual(["AI_REPLY", "INBOUND_MESSAGE", "FOLLOW_UP_SENT", "AUTOMATION_REPLY", "COMMENT"]);
    expect(third.hasMore).toBe(false);
    expect(await loadTimeline("w2", contact.id)).toEqual({ items: [], nextBefore: null, hasMore: false });
  });

  it("works for a contact that only exists in the legacy DmLog store", async () => {
    db.seed("workspace", { id: "w1", ownerId: "owner" });
    db.seed("automation", { id: "auto1", workspaceId: "w1", instagramAccountId: "a1", name: "Eski kampaniya" });
    db.seed("dmLog", { id: "dm1", workspaceId: "w1", automationId: "auto1", instagramAccountId: "a1", commenterId: "u9", commentText: "info", commentId: "cmt9", status: "SENT", dmSentAt: at(2), createdAt: at(1) });
    const contact = await upsertContactFromParts({ workspaceId: "w1", instagramAccountId: "a1", igUserId: "u9" });
    const page = await loadTimeline("w1", contact.id);
    expect(page.items.map((i) => [i.type, i.title])).toEqual([
      ["AUTOMATION_REPLY", "Kampaniya DM: Eski kampaniya"],
      ["COMMENT", "Izoh"],
    ]);
  });
});
