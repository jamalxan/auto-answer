/**
 * ETAP 9.3 — referral qualification (all three qualifiers), the reward
 * (tag + points + Telegram + DM inside the window), idempotency under double
 * execution, and the owner's review of flagged events.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("../lib/engagement/gate", () => ({ forgetEngagementGate: vi.fn(async () => {}), hasActiveEngagement: vi.fn(async () => false) }));
vi.mock("../lib/engagement/worker", () => ({
  registerEngagementJobHandler: vi.fn(),
  registerEngagementMaintenanceTask: vi.fn(),
}));
const tagControl = vi.hoisted(() => ({ fail: false }));
vi.mock("../lib/crm/tags", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/crm/tags")>();
  return {
    ...actual,
    addTag: vi.fn(async (...args: Parameters<typeof actual.addTag>) => {
      if (tagControl.fail) throw new Error("teg xizmati ishlamayapti");
      return actual.addTag(...args);
    }),
  };
});
vi.mock("../lib/telegram/notify", () => ({ notifyWorkspaceChats: vi.fn(async () => 1) }));
vi.mock("../lib/meta/client", () => ({ sendDirectMessage: vi.fn(async () => ({ recipient_id: "x", message_id: "mid" })) }));
vi.mock("../lib/triggers/delivery", () => ({
  readAccessToken: vi.fn(() => ({ ok: true, token: "tok" })),
  sendGuarded: vi.fn(async (_ws: string, _account: unknown, send: () => Promise<unknown>) => ({ ok: true, sent: await send() })),
}));

import { sendDirectMessage } from "../lib/meta/client";
import { notifyWorkspaceChats } from "../lib/telegram/notify";
import { clearCrmListeners, type CrmEvent } from "../lib/crm/hooks";
import { onCrmEventForEngagement } from "../lib/engagement/referral/module";
import { reviewReferralEvent, referralStats, listReferralEvents, saveProgram, getProgram } from "../lib/engagement/referral/program";
import { runReferralQualification } from "../lib/engagement/referral/qualification";
import { rewardReferralEvent } from "../lib/engagement/referral/reward";
import { db, resetDb } from "./helpers/db-instance";

const NOW = new Date("2026-10-16T10:00:00Z");
const at = (hhmm: string) => new Date(`2026-10-16T${hhmm}:00Z`);

type Row = Record<string, unknown>;

const RULES = { tagSlug: "taklifchi", points: 10, telegramOwner: true, dmTemplate: "Rahmat, {name}! Do'stingiz yozdi.", _activatedAt: "2026-10-16T08:00:00Z" };

function seed(programExtra: Row = {}) {
  db.seed("workspace", { id: "w1", ownerId: "u1" });
  db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "shop", instagramId: "ig_shop", accessToken: "enc" });
  db.seed("referralProgram", {
    id: "p1", workspaceId: "w1", instagramAccountId: "a1", name: "Do'st taklif", active: true, qualifier: "FIRST_MESSAGE",
    rewardRules: RULES, burstLimitPerDay: 10, createdAt: new Date("2026-10-01T00:00:00Z"), ...programExtra,
  });
  db.seed("referralCode", { id: "rc1", programId: "p1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "ref1", code: "ABC234" });
  db.seed("crmContact", {
    id: "c_ref", workspaceId: "w1", instagramAccountId: "a1", igUserId: "ref1", username: "ali", name: "Ali", lastInboundAt: new Date(NOW.getTime() - 3600_000),
  });
  db.seed("crmContact", { id: "c_fr", workspaceId: "w1", instagramAccountId: "a1", igUserId: "fr1", username: "vali", name: "Vali" });
  // The carrying event: the ig.me link opened (messaging_referral: empty text).
  db.seed("instagramEvent", {
    id: "e_open", workspaceId: "w1", instagramAccountId: "a1", eventType: "DIRECT_MESSAGE", senderId: "fr1", messageId: "ref:fr1:1",
    text: "", ref: "rf_abc234", timestamp: at("09:00"), createdAt: at("09:00"), rawPayload: {},
  });
}

function seedReferral(extra: Row = {}) {
  return db.seed("referralEvent", {
    id: "re1", programId: "p1", workspaceId: "w1", codeId: "rc1", referrerIgUserId: "ref1", referrerContactId: "c_ref",
    refereeIgUserId: "fr1", refereeContactId: "c_fr", sourceEventId: "e_open", createdAt: at("09:00"), ...extra,
  });
}

function dm(extra: Row) {
  return db.seed("instagramEvent", {
    workspaceId: "w1", instagramAccountId: "a1", eventType: "DIRECT_MESSAGE", senderId: "fr1", text: "", rawPayload: {},
    id: `dm_${db.rows("instagramEvent").length}`, messageId: `dm_${db.rows("instagramEvent").length}`, timestamp: at("09:05"), createdAt: at("09:05"), ...extra,
  });
}

const ev = () => db.rows("referralEvent").find((e) => e.id === "re1")!;
const tagsOf = (contactId: string) => db.rows("crmContactTag").filter((t) => t.contactId === contactId);
const pointsRows = () => db.rows("engagementPoint");

beforeEach(() => {
  resetDb();
  clearCrmListeners();
  vi.mocked(sendDirectMessage).mockClear();
  vi.mocked(notifyWorkspaceChats).mockClear();
  tagControl.fail = false;
  delete process.env.ENGAGEMENT_DISABLED;
  seed();
});
afterEach(() => {
  delete process.env.ENGAGEMENT_DISABLED;
});

describe("FIRST_MESSAGE qualifier", () => {
  it("an empty messaging_referral open alone does NOT qualify", async () => {
    seedReferral();
    const result = await runReferralQualification(NOW);
    expect(result.qualified).toBe(0);
    expect(ev().status).toBe("PENDING");
    expect(pointsRows()).toHaveLength(0);
  });

  it("the friend's first text message qualifies and rewards (tag + points + Telegram + DM)", async () => {
    seedReferral();
    dm({ text: "Salom, narxi qancha?" });
    const result = await runReferralQualification(NOW);
    expect(result).toMatchObject({ qualified: 1, rewarded: 1 });
    expect(ev()).toMatchObject({ status: "REWARDED", qualifiedBy: "FIRST_MESSAGE" });
    expect(ev().rewardedAt).toBeTruthy();

    expect(tagsOf("c_ref")).toHaveLength(1);
    expect(tagsOf("c_ref")[0]).toMatchObject({ origin: "AUTOMATION", sourceRef: "referral:re1" });
    expect(db.rows("crmTag")[0]).toMatchObject({ slug: "taklifchi" });
    expect(pointsRows()).toHaveLength(1);
    expect(pointsRows()[0]).toMatchObject({ contactId: "c_ref", points: 10, reason: "referral_qualified", sourceTable: "ReferralEvent", sourceId: "re1" });
    expect(notifyWorkspaceChats).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage).toHaveBeenCalledWith("tok", "ig_shop", "ref1", "Rahmat, Ali! Do'stingiz yozdi.");

    const snapshot = ev().rewardSnapshot as Record<string, unknown>;
    expect(snapshot).toMatchObject({
      referrerContactId: "c_ref",
      tag: { slug: "taklifchi", changed: true },
      points: { awarded: true, points: 10 },
      telegram: { delivered: 1 },
      dm: { sent: true },
    });
  });

  it("a quick-reply tap (payload, no text) qualifies", async () => {
    seedReferral();
    dm({ text: "", payload: "c2:abc" });
    expect((await runReferralQualification(NOW)).qualified).toBe(1);
    expect(ev().status).toBe("REWARDED");
  });

  it("a carrying event that is itself a message (message.referral) qualifies", async () => {
    seedReferral();
    db.rows("instagramEvent").find((e) => e.id === "e_open")!.text = "Assalomu alaykum";
    expect((await runReferralQualification(NOW)).qualified).toBe(1);
  });

  it("messages of other people, other event types and whitespace do not qualify", async () => {
    seedReferral();
    dm({ senderId: "someone_else", text: "salom" });
    dm({ eventType: "COMMENT", text: "zo'r" });
    dm({ text: "   " });
    expect((await runReferralQualification(NOW)).qualified).toBe(0);
  });

  it("the CRM interaction listener qualifies in real time", async () => {
    seedReferral();
    dm({ text: "Salom" });
    const contact = db.rows("crmContact").find((c) => c.id === "c_fr")!;
    await onCrmEventForEngagement({
      kind: "interaction", workspaceId: "w1", contactId: "c_fr", contact: contact as never, direction: "inbound", via: "reconcile", at: NOW,
    });
    expect(ev().status).toBe("REWARDED");
  });

  it("ignores an outbound interaction", async () => {
    seedReferral();
    dm({ text: "Salom" });
    const contact = db.rows("crmContact").find((c) => c.id === "c_fr")!;
    await onCrmEventForEngagement({
      kind: "interaction", workspaceId: "w1", contactId: "c_fr", contact: contact as never, direction: "outbound", via: "reconcile", at: NOW,
    });
    expect(ev().status).toBe("PENDING");
  });
});

describe("LEAD and PURCHASE qualifiers", () => {
  const crmEvent = (kind: "lead_created" | "stage_changed", extra: Record<string, unknown> = {}): CrmEvent => {
    const contact = db.rows("crmContact").find((c) => c.id === "c_fr")! as never;
    const base = { workspaceId: "w1", contactId: "c_fr", contact };
    return kind === "lead_created"
      ? ({ ...base, kind, leadId: "l1", dealId: "d1", productInterest: null, ...extra } as CrmEvent)
      : ({ ...base, kind, dealId: "d1", fromStageId: null, toStageId: "s1", stageKind: "WON", actor: { kind: "SYSTEM" }, ...extra } as CrmEvent);
  };

  it("LEAD: a text message alone does not qualify, lead_created does", async () => {
    db.rows("referralProgram")[0].qualifier = "LEAD";
    seedReferral();
    dm({ text: "Salom" });
    expect((await runReferralQualification(NOW)).qualified).toBe(0);
    await onCrmEventForEngagement(crmEvent("stage_changed", { stageKind: "OPEN" }));
    expect(ev().status).toBe("PENDING");
    await onCrmEventForEngagement(crmEvent("lead_created"));
    expect(ev()).toMatchObject({ status: "REWARDED", qualifiedBy: "LEAD" });
  });

  it("LEAD sweep: a deal created after the ref qualifies even if the listener missed it", async () => {
    db.rows("referralProgram")[0].qualifier = "LEAD";
    seedReferral();
    db.seed("crmDeal", { id: "d1", workspaceId: "w1", contactId: "c_fr", leadId: "l1", createdAt: at("09:30") });
    expect((await runReferralQualification(NOW)).qualified).toBe(1);
  });

  it("PURCHASE: only a WON stage qualifies", async () => {
    db.rows("referralProgram")[0].qualifier = "PURCHASE";
    seedReferral();
    await onCrmEventForEngagement(crmEvent("lead_created"));
    await onCrmEventForEngagement(crmEvent("stage_changed", { stageKind: "LOST" }));
    expect(ev().status).toBe("PENDING");
    await onCrmEventForEngagement(crmEvent("stage_changed"));
    expect(ev()).toMatchObject({ status: "REWARDED", qualifiedBy: "PURCHASE" });
    // The friend's own purchase also paid the friend (purchase points on the friend's contact).
    expect(pointsRows().find((p) => p.contactId === "c_fr")).toMatchObject({ reason: "purchase", sourceTable: "CrmDeal", sourceId: "d1" });
  });

  it("a WON deal of someone who is not a referee only earns purchase points", async () => {
    db.rows("referralProgram")[0].qualifier = "PURCHASE";
    seedReferral();
    db.seed("crmContact", { id: "c_x", workspaceId: "w1", instagramAccountId: "a1", igUserId: "stranger" });
    const stranger = db.rows("crmContact").find((c) => c.id === "c_x")! as never;
    await onCrmEventForEngagement({ kind: "stage_changed", workspaceId: "w1", contactId: "c_x", contact: stranger, dealId: "d9", fromStageId: null, toStageId: "s", stageKind: "WON", actor: { kind: "SYSTEM" } });
    expect(ev().status).toBe("PENDING");
    expect(pointsRows()).toHaveLength(1);
  });
});

describe("reward", () => {
  it("is idempotent under double execution (concurrent and repeated)", async () => {
    seedReferral({ status: "QUALIFIED", qualifiedAt: at("09:05"), qualifiedBy: "FIRST_MESSAGE" });
    const [a, b] = await Promise.all([rewardReferralEvent("re1", NOW), rewardReferralEvent("re1", NOW)]);
    const again = await rewardReferralEvent("re1", NOW);
    expect([a.rewarded, b.rewarded].filter(Boolean)).toHaveLength(1);
    expect(again.rewarded).toBe(false);
    expect(notifyWorkspaceChats).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(pointsRows()).toHaveLength(1);
    expect(tagsOf("c_ref")).toHaveLength(1);
  });

  it("the sweep never rewards an already rewarded event twice", async () => {
    seedReferral();
    dm({ text: "Salom" });
    await runReferralQualification(NOW);
    await runReferralQualification(NOW);
    expect(pointsRows()).toHaveLength(1);
    expect(notifyWorkspaceChats).toHaveBeenCalledTimes(1);
  });

  it("a throwing tag step does not hide the other steps; the sweep re-drives only tag + points", async () => {
    seedReferral({ status: "QUALIFIED" });
    tagControl.fail = true;
    const outcome = await rewardReferralEvent("re1", NOW);
    expect(outcome.rewarded).toBe(true);
    expect(ev().status).toBe("REWARDED");
    expect(ev().rewardSnapshot).toMatchObject({
      tagDone: false,
      pointsDone: true,
      errors: { tag: "teg xizmati ishlamayapti" },
      telegram: { delivered: 1 },
      dm: { sent: true },
    });
    expect(pointsRows()).toHaveLength(1);
    expect(tagsOf("c_ref")).toHaveLength(0);

    // Too fresh: its own run may still be finishing.
    expect((await runReferralQualification(new Date(NOW.getTime() + 30_000))).redriven).toBe(0);

    tagControl.fail = false;
    const later = new Date(NOW.getTime() + 5 * 60_000);
    const swept = await runReferralQualification(later);
    expect(swept.redriven).toBe(1);
    expect(tagsOf("c_ref")).toHaveLength(1);
    expect(ev().rewardSnapshot).toMatchObject({ tagDone: true, pointsDone: true, tag: { slug: "taklifchi" } });
    // Telegram and the DM are never repeated; points are not doubled.
    expect(notifyWorkspaceChats).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(pointsRows()).toHaveLength(1);
    expect((await runReferralQualification(later)).redriven).toBe(0);
  });

  it("a REWARDED event whose snapshot was never saved is completed by the sweep", async () => {
    seedReferral({ status: "REWARDED", rewardedAt: NOW, rewardSnapshot: null });
    const swept = await runReferralQualification(new Date(NOW.getTime() + 5 * 60_000));
    expect(swept.redriven).toBe(1);
    expect(pointsRows()).toHaveLength(1);
    expect(tagsOf("c_ref")).toHaveLength(1);
    expect(notifyWorkspaceChats).not.toHaveBeenCalled();
    expect(ev().rewardSnapshot).toMatchObject({ tagDone: true, pointsDone: true });
  });

  it("the owner's Telegram text names the qualifier that was met", async () => {
    for (const [qualifier, phrase] of [
      ["FIRST_MESSAGE", "birinchi xabarini yozdi"],
      ["LEAD", "lead qoldirdi"],
      ["PURCHASE", "xarid qildi"],
    ] as const) {
      db.rows("referralEvent").length = 0;
      db.rows("referralProgram")[0].qualifier = qualifier;
      vi.mocked(notifyWorkspaceChats).mockClear();
      seedReferral({ status: "QUALIFIED" });
      await rewardReferralEvent("re1", NOW);
      expect(vi.mocked(notifyWorkspaceChats).mock.calls[0][1]).toContain(phrase);
    }
  });

  it("sends the DM only inside the 24h window; otherwise stores the reason in the snapshot", async () => {
    db.rows("crmContact").find((c) => c.id === "c_ref")!.lastInboundAt = new Date(NOW.getTime() - 30 * 3600_000);
    seedReferral({ status: "QUALIFIED" });
    await rewardReferralEvent("re1", NOW);
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect((ev().rewardSnapshot as { dm: { sent: boolean; reason: string } }).dm).toEqual({ sent: false, reason: "oyna yopiq — DM yuborilmadi" });
    // The rest of the reward still happened.
    expect(tagsOf("c_ref")).toHaveLength(1);
    expect(pointsRows()).toHaveLength(1);
    expect(notifyWorkspaceChats).toHaveBeenCalledTimes(1);
  });

  it("never DMs a referrer who has no inbound at all, or who opted out", async () => {
    db.rows("crmContact").find((c) => c.id === "c_ref")!.lastInboundAt = null;
    seedReferral({ status: "QUALIFIED" });
    await rewardReferralEvent("re1", NOW);
    expect(sendDirectMessage).not.toHaveBeenCalled();

    db.rows("referralEvent").length = 0;
    db.rows("crmContact").find((c) => c.id === "c_ref")!.lastInboundAt = new Date(NOW.getTime() - 3600_000);
    db.rows("crmContact").find((c) => c.id === "c_ref")!.optedOutAt = new Date();
    seedReferral({ status: "QUALIFIED" });
    await rewardReferralEvent("re1", NOW);
    expect(sendDirectMessage).not.toHaveBeenCalled();
    expect((ev().rewardSnapshot as { dm: { reason: string } }).dm.reason).toContain("obunani bekor qilgan");
  });

  it("sends the friend's thank-you template inside their window", async () => {
    db.rows("referralProgram")[0].rewardRules = { ...RULES, dmTemplate: undefined, refereeDmTemplate: "Xush kelibsiz, {name}!" };
    db.rows("crmContact").find((c) => c.id === "c_fr")!.lastInboundAt = new Date(NOW.getTime() - 60_000);
    seedReferral({ status: "QUALIFIED" });
    await rewardReferralEvent("re1", NOW);
    expect(sendDirectMessage).toHaveBeenCalledTimes(1);
    expect(sendDirectMessage).toHaveBeenCalledWith("tok", "ig_shop", "fr1", "Xush kelibsiz, Vali!");
  });

  it("without rules it still marks the event and awards the default points", async () => {
    db.rows("referralProgram")[0].rewardRules = {};
    seedReferral({ status: "QUALIFIED" });
    await rewardReferralEvent("re1", NOW);
    expect(ev().status).toBe("REWARDED");
    expect(pointsRows()[0].points).toBe(10);
    expect(notifyWorkspaceChats).not.toHaveBeenCalled();
    expect(tagsOf("c_ref")).toHaveLength(0);
  });

  it("an unknown referrer contact skips tag and points but still notifies the owner", async () => {
    seedReferral({ status: "QUALIFIED", referrerContactId: null, referrerIgUserId: "ghost" });
    await rewardReferralEvent("re1", NOW);
    expect(ev().status).toBe("REWARDED");
    expect(pointsRows()).toHaveLength(0);
    expect((ev().rewardSnapshot as { tag: unknown }).tag).toEqual({ skipped: "taklif qiluvchi kontakti topilmadi" });
    expect(notifyWorkspaceChats).toHaveBeenCalledTimes(1);
  });

  it("re-drives a QUALIFIED event whose reward never finished", async () => {
    seedReferral({ status: "QUALIFIED", qualifiedAt: at("09:05") });
    const result = await runReferralQualification(NOW);
    expect(result.retried).toBe(1);
    expect(ev().status).toBe("REWARDED");
  });

  it("does nothing under ENGAGEMENT_DISABLED", async () => {
    process.env.ENGAGEMENT_DISABLED = "1";
    seedReferral();
    dm({ text: "Salom" });
    expect(await runReferralQualification(NOW)).toMatchObject({ checked: 0, qualified: 0 });
    const contact = db.rows("crmContact").find((c) => c.id === "c_fr")!;
    await onCrmEventForEngagement({ kind: "interaction", workspaceId: "w1", contactId: "c_fr", contact: contact as never, direction: "inbound", via: "reconcile", at: NOW });
    expect(ev().status).toBe("PENDING");
    expect(pointsRows()).toHaveLength(0);
  });
});

describe("flagged events and the owner's review", () => {
  it("a flagged event whose condition is met stays PENDING and is not rewarded", async () => {
    seedReferral({ fraudFlags: ["SELF_REFERRAL"] });
    dm({ text: "Salom" });
    const result = await runReferralQualification(NOW);
    expect(result.awaitingReview).toBe(1);
    expect(ev()).toMatchObject({ status: "PENDING", rewardedAt: null });
    expect((ev().rewardSnapshot as { awaitingReview: boolean }).awaitingReview).toBe(true);
    expect(pointsRows()).toHaveLength(0);
    expect(tagsOf("c_ref")).toHaveLength(0);
    expect(notifyWorkspaceChats).not.toHaveBeenCalled();
    // Further ticks do not reward it either.
    await runReferralQualification(NOW);
    expect(ev().status).toBe("PENDING");
  });

  it("SAME_PHONE found at qualification time flags the event", async () => {
    db.rows("crmContact").find((c) => c.id === "c_ref")!.phoneE164 = "+998901112233";
    db.rows("crmContact").find((c) => c.id === "c_fr")!.phoneE164 = "+998901112233";
    seedReferral();
    dm({ text: "Salom" });
    await runReferralQualification(NOW);
    expect(ev()).toMatchObject({ status: "PENDING", fraudFlags: ["SAME_PHONE"] });
  });

  it("APPROVE of a flagged PENDING friend who never messaged does NOT bypass the condition", async () => {
    seedReferral({ fraudFlags: ["ALREADY_KNOWN_CONTACT"], rewardSnapshot: { awaitingReview: true } });
    const item = await reviewReferralEvent("w1", "re1", "APPROVE", "user1");
    expect(item.status).toBe("PENDING");
    expect(ev()).toMatchObject({ status: "PENDING", reviewedByUserId: "user1", rewardSnapshot: { awaitingReview: false } });
    expect(ev().reviewedAt).toBeTruthy();
    expect(pointsRows()).toHaveLength(0);
    await runReferralQualification(NOW);
    expect(ev().status).toBe("PENDING");

    // The friend's first message then qualifies and rewards through the normal path.
    dm({ text: "Salom" });
    await runReferralQualification(NOW);
    expect(ev()).toMatchObject({ status: "REWARDED", qualifiedBy: "FIRST_MESSAGE" });
    expect(pointsRows()).toHaveLength(1);
    // Approving twice is harmless.
    await reviewReferralEvent("w1", "re1", "APPROVE", "user1");
    expect(pointsRows()).toHaveLength(1);
    expect(notifyWorkspaceChats).toHaveBeenCalledTimes(1);
  });

  it("APPROVE of a flagged PENDING friend whose condition is already met rewards at once", async () => {
    seedReferral({ fraudFlags: ["ALREADY_KNOWN_CONTACT"] });
    dm({ text: "Salom" });
    const item = await reviewReferralEvent("w1", "re1", "APPROVE", "user1");
    expect(item.status).toBe("REWARDED");
    expect(ev()).toMatchObject({ reviewedByUserId: "user1", qualifiedBy: "FIRST_MESSAGE" });
    expect(pointsRows()).toHaveLength(1);
  });

  it("APPROVE rewards a flagged QUALIFIED event", async () => {
    seedReferral({ status: "QUALIFIED", fraudFlags: ["BURST"] });
    expect((await reviewReferralEvent("w1", "re1", "APPROVE", "user1")).status).toBe("REWARDED");
  });

  it("an approved flagged event is then rewarded by the normal flow once the condition is met", async () => {
    seedReferral({ fraudFlags: ["BURST"], reviewedAt: NOW, reviewedByUserId: "user1" });
    dm({ text: "Salom" });
    await runReferralQualification(NOW);
    expect(ev().status).toBe("REWARDED");
  });

  it("REJECT stays REJECTED, is never rewarded and keeps the reason", async () => {
    seedReferral({ fraudFlags: ["SELF_REFERRAL"] });
    const item = await reviewReferralEvent("w1", "re1", "REJECT", "user1", "  o'zi taklif qilgan ");
    expect(item).toMatchObject({ status: "REJECTED", rejectReason: "o'zi taklif qilgan", reviewedByUserId: "user1" });
    dm({ text: "Salom" });
    await runReferralQualification(NOW);
    expect(ev().status).toBe("REJECTED");
    expect(pointsRows()).toHaveLength(0);
    await expect(reviewReferralEvent("w1", "re1", "APPROVE", "user1")).rejects.toMatchObject({ status: 409 });
  });

  it("validates the review: unflagged APPROVE, REJECT of a rewarded event, wrong workspace", async () => {
    seedReferral();
    await expect(reviewReferralEvent("w1", "re1", "APPROVE", "user1")).rejects.toMatchObject({ status: 422 });
    await expect(reviewReferralEvent("w2", "re1", "REJECT", "user1")).rejects.toMatchObject({ status: 404 });
    ev().status = "REWARDED";
    await expect(reviewReferralEvent("w1", "re1", "REJECT", "user1")).rejects.toMatchObject({ status: 409 });
  });
});

describe("program service", () => {
  it("saveProgram validates, stamps the activation time once and refreshes the gate", async () => {
    resetDb();
    db.seed("workspace", { id: "w1", ownerId: "u1" });
    db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "shop", instagramId: "ig_shop" });
    const input = { name: "Do'st taklif", active: true, qualifier: "FIRST_MESSAGE", rewardRules: { telegramOwner: true, points: 5, tagSlug: "elchi" }, burstLimitPerDay: 5 };

    const first = await saveProgram("w1", "a1", input);
    expect(first).toMatchObject({ active: true, burstLimitPerDay: 5, rewardRules: { telegramOwner: true, points: 5, tagSlug: "elchi" } });
    const stamp = first.activatedAt.getTime();
    const second = await saveProgram("w1", "a1", { ...input, name: "Yangi nom" });
    expect(second.activatedAt.getTime()).toBe(stamp);
    expect(db.rows("referralProgram")).toHaveLength(1);

    // Off and on again restarts the history cut-off.
    await saveProgram("w1", "a1", { ...input, active: false });
    const again = await saveProgram("w1", "a1", input);
    expect(again.activatedAt.getTime()).toBeGreaterThanOrEqual(stamp);

    const { forgetEngagementGate } = await import("../lib/engagement/gate");
    expect(forgetEngagementGate).toHaveBeenCalledWith("a1");
    expect((await getProgram("w1", "a1"))?.name).toBe("Do'st taklif");
    await expect(getProgram("w2", "a1")).rejects.toMatchObject({ status: 404 });
  });

  it("rejects bad input with Uzbek messages", async () => {
    resetDb();
    db.seed("workspace", { id: "w1", ownerId: "u1" });
    db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "shop", instagramId: "ig_shop" });
    const ok = { name: "X", active: false, qualifier: "FIRST_MESSAGE", rewardRules: { telegramOwner: false }, burstLimitPerDay: 5 };
    await expect(saveProgram("w1", "a1", { ...ok, burstLimitPerDay: 0 })).rejects.toMatchObject({ status: 422 });
    await expect(saveProgram("w1", "a1", { ...ok, burstLimitPerDay: 201 })).rejects.toMatchObject({ status: 422 });
    await expect(saveProgram("w1", "a1", { ...ok, rewardRules: { telegramOwner: false, points: 1001 } })).rejects.toMatchObject({ status: 422 });
    await expect(saveProgram("w1", "a1", { ...ok, rewardRules: { telegramOwner: false, dmTemplate: "x".repeat(501) } })).rejects.toMatchObject({ status: 422 });
    await expect(saveProgram("w1", "a1", { ...ok, qualifier: "NOPE" })).rejects.toMatchObject({ status: 422 });
    await expect(saveProgram("w1", "missing", ok)).rejects.toMatchObject({ status: 404 });
  });

  it("lists events with filters and computes stats per referrer", async () => {
    seedReferral({ status: "REWARDED" });
    seedReferral({ id: "re2", refereeIgUserId: "fr2", refereeContactId: null, fraudFlags: ["BURST"], createdAt: at("09:10") });
    seedReferral({ id: "re3", refereeIgUserId: "fr3", refereeContactId: null, status: "QUALIFIED", createdAt: at("09:20") });

    const all = await listReferralEvents("w1", { programId: "p1" });
    expect(all.items.map((i) => i.id)).toEqual(["re3", "re2", "re1"]);
    expect(all.items[2].referrerUsername).toBe("ali");
    expect((await listReferralEvents("w1", { flagged: true })).items.map((i) => i.id)).toEqual(["re2"]);
    expect((await listReferralEvents("w1", { flagged: false })).items.map((i) => i.id)).toEqual(["re3", "re1"]);
    expect((await listReferralEvents("w1", { status: "QUALIFIED" })).items.map((i) => i.id)).toEqual(["re3"]);
    const paged = await listReferralEvents("w1", { limit: 2 });
    expect(paged.nextCursor).toBeTruthy();
    expect((await listReferralEvents("w1", { limit: 2, cursor: paged.nextCursor })).items.map((i) => i.id)).toEqual(["re1"]);

    const stats = await referralStats("w1", "p1");
    expect(stats.totals).toMatchObject({ pending: 1, qualified: 1, rewarded: 1, flagged: 1, total: 3 });
    expect(stats.topReferrers[0]).toMatchObject({ referrerIgUserId: "ref1", username: "ali", pending: 1, qualified: 1, rewarded: 1 });
    await expect(referralStats("w2", "p1")).rejects.toMatchObject({ status: 404 });
  });
});
