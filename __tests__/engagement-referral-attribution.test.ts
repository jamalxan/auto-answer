/**
 * ETAP 9.3 — referral attribution: ref events become PENDING referral events
 * (first ref wins, unknown codes and history ignored) and the fraud flags.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("../lib/engagement/gate", () => ({ forgetEngagementGate: vi.fn(async () => {}), hasActiveEngagement: vi.fn(async () => false) }));

import { computeFraudFlags, isBlocked, mergeFlags } from "../lib/engagement/referral/fraud";
import { REFERRAL_CURSOR_SOURCE, runReferralAttribution } from "../lib/engagement/referral/attribution";
import { db, resetDb } from "./helpers/db-instance";

const NOW = new Date("2026-10-16T10:00:00Z");
const ACTIVATED = "2026-10-16T08:00:00Z";
const at = (hhmm: string) => new Date(`2026-10-16T${hhmm}:00Z`);

type Row = Record<string, unknown>;

function seed(programExtra: Row = {}) {
  db.seed("workspace", { id: "w1", ownerId: "u1" });
  db.seed("instagramAccount", { id: "a1", workspaceId: "w1", username: "shop", instagramId: "ig_shop" });
  db.seed("referralProgram", {
    id: "p1", workspaceId: "w1", instagramAccountId: "a1", name: "Do'st taklif", active: true,
    rewardRules: { telegramOwner: false, _activatedAt: ACTIVATED }, burstLimitPerDay: 10, createdAt: new Date("2026-10-01T00:00:00Z"),
    ...programExtra,
  });
  db.seed("referralCode", { id: "rc1", programId: "p1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "ref1", code: "ABC234" });
  db.seed("crmContact", { id: "c_ref", workspaceId: "w1", instagramAccountId: "a1", igUserId: "ref1", username: "ali" });
  // The scan position is old enough to see today's events (the first run would seed it at "now").
  db.seed("crmSyncCursor", { source: REFERRAL_CURSOR_SOURCE, cursorAt: new Date("2026-10-16T00:00:00Z"), cursorId: null });
}

let counter = 0;
function refEvent(extra: Row = {}) {
  counter++;
  const timestamp = (extra.timestamp as Date) ?? at("09:00");
  return db.seed("instagramEvent", {
    id: `e${counter}`, workspaceId: "w1", instagramAccountId: "a1", eventType: "DIRECT_MESSAGE", senderId: `fr${counter}`,
    messageId: `m${counter}`, text: "", ref: "rf_abc234", timestamp, createdAt: timestamp, rawPayload: {}, ...extra,
  });
}

const events = () => db.rows("referralEvent");

beforeEach(() => {
  resetDb();
  counter = 0;
  delete process.env.ENGAGEMENT_DISABLED;
  seed();
});
afterEach(() => {
  delete process.env.ENGAGEMENT_DISABLED;
});

describe("attribution", () => {
  it("turns a ref event into a PENDING referral event and stamps the code", async () => {
    refEvent({ id: "e_main", senderId: "friend1" });
    const result = await runReferralAttribution(NOW);
    expect(result).toMatchObject({ scanned: 1, created: 1, flagged: 0 });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({
      programId: "p1", workspaceId: "w1", codeId: "rc1", referrerIgUserId: "ref1", referrerContactId: "c_ref",
      refereeIgUserId: "friend1", sourceEventId: "e_main", status: "PENDING", fraudFlags: [],
    });
    expect((db.rows("referralCode")[0].lastSharedAt as Date).getTime()).toBe(at("09:00").getTime());
  });

  it("an empty scan still advances the cursor (to now - 60s), never backwards and never past a late row", async () => {
    refEvent({ senderId: "friend1", ref: "other_ref" });
    const first = await runReferralAttribution(NOW);
    expect(first.scanned).toBe(0);
    expect(db.rows("crmSyncCursor")[0].cursorAt).toEqual(new Date(NOW.getTime() - 60_000));
    expect(db.rows("crmSyncCursor")[0].cursorId).toBeNull();
    // Idle ticks with an older clock never move it back.
    await runReferralAttribution(new Date(NOW.getTime() - 3600_000));
    expect(db.rows("crmSyncCursor")[0].cursorAt).toEqual(new Date(NOW.getTime() - 60_000));
    // A row stored inside the 60s lag is still seen by the next scan.
    refEvent({ senderId: "friend2", timestamp: new Date(NOW.getTime() - 20_000) });
    const later = await runReferralAttribution(new Date(NOW.getTime() + 10_000));
    expect(later.created).toBe(1);
  });

  it("first ref wins: a later ref of the same friend (even another code) is ignored", async () => {
    db.seed("referralCode", { id: "rc2", programId: "p1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "ref2", code: "XYZ789" });
    refEvent({ id: "e1", senderId: "friend1", timestamp: at("09:00") });
    refEvent({ id: "e2", senderId: "friend1", ref: "rf_xyz789", timestamp: at("09:30") });
    const result = await runReferralAttribution(NOW);
    expect(result).toMatchObject({ scanned: 2, created: 1, ignored: 1 });
    expect(events()).toHaveLength(1);
    expect(events()[0]).toMatchObject({ sourceEventId: "e1", referrerIgUserId: "ref1" });
  });

  it("is idempotent across runs and keeps the keyset cursor", async () => {
    refEvent({ senderId: "friend1" });
    await runReferralAttribution(NOW);
    const cursor = db.rows("crmSyncCursor")[0];
    expect(cursor.cursorId).toBe("e1");
    const again = await runReferralAttribution(NOW);
    expect(again.scanned).toBe(0);
    refEvent({ senderId: "friend2", timestamp: new Date(NOW.getTime() - 30_000) });
    expect((await runReferralAttribution(NOW)).created).toBe(1);
    expect(events()).toHaveLength(2);
    // A forced rescan from the beginning finds the rows and creates nothing new.
    db.rows("crmSyncCursor")[0].cursorAt = new Date("2026-10-15T00:00:00Z");
    db.rows("crmSyncCursor")[0].cursorId = null;
    expect((await runReferralAttribution(NOW)).created).toBe(0);
    expect(events()).toHaveLength(2);
  });

  it("ignores unknown codes, non-referral refs and refs of an account without an active program", async () => {
    refEvent({ senderId: "f1", ref: "rf_zzzzzz" });
    refEvent({ senderId: "f2", ref: "rf_" });
    refEvent({ senderId: "f3", ref: "yozgi-aksiya" });
    await runReferralAttribution(NOW);
    expect(events()).toHaveLength(0);

    db.rows("referralProgram")[0].active = false;
    refEvent({ senderId: "f4", timestamp: at("09:20") });
    await runReferralAttribution(NOW);
    expect(events()).toHaveLength(0);
  });

  it("does not use a code of another program or account", async () => {
    db.seed("instagramAccount", { id: "a2", workspaceId: "w1", username: "other", instagramId: "ig_other" });
    refEvent({ senderId: "f1", instagramAccountId: "a2" });
    await runReferralAttribution(NOW);
    expect(events()).toHaveLength(0);
  });

  it("is case-insensitive on the code", async () => {
    refEvent({ senderId: "f1", ref: "rf_AbC234" });
    refEvent({ senderId: "f2", ref: "rf_abc234", timestamp: at("09:05") });
    await runReferralAttribution(NOW);
    expect(events().map((e) => e.codeId)).toEqual(["rc1", "rc1"]);
  });

  it("stays silent for history: events before the activation, and everything on the very first run", async () => {
    refEvent({ senderId: "old", timestamp: at("07:00"), createdAt: at("09:00") });
    await runReferralAttribution(NOW);
    expect(events()).toHaveLength(0);

    // A fresh install: no cursor yet — the first run seeds it at "now" and rewards nothing from the past.
    resetDb();
    counter = 0;
    seed();
    db.tables.crmSyncCursor = [];
    refEvent({ senderId: "past", timestamp: at("09:00") });
    const first = await runReferralAttribution(NOW);
    expect(first.created).toBe(0);
    expect(db.rows("crmSyncCursor")[0]).toMatchObject({ source: REFERRAL_CURSOR_SOURCE });
    expect((db.rows("crmSyncCursor")[0].cursorAt as Date).getTime()).toBe(NOW.getTime());
  });

  it("processes at most 500 events per tick and continues on the next", async () => {
    for (let i = 0; i < 503; i++) refEvent({ senderId: `bulk${i}`, timestamp: new Date(at("09:00").getTime() + i * 1000) });
    db.rows("referralProgram")[0].burstLimitPerDay = 200;
    const first = await runReferralAttribution(NOW);
    expect(first.scanned).toBe(500);
    const second = await runReferralAttribution(NOW);
    expect(second.scanned).toBe(3);
    expect(events()).toHaveLength(503);
  });

  it("does nothing under ENGAGEMENT_DISABLED", async () => {
    process.env.ENGAGEMENT_DISABLED = "1";
    refEvent({ senderId: "f1" });
    const result = await runReferralAttribution(NOW);
    expect(result).toEqual({ scanned: 0, created: 0, flagged: 0, ignored: 0 });
    expect(events()).toHaveLength(0);
    expect(db.rows("crmSyncCursor")[0].cursorId).toBeNull();
  });
});

describe("fraud flags at attribution", () => {
  it("SELF_REFERRAL: the referrer opens their own link", async () => {
    refEvent({ senderId: "ref1" });
    await runReferralAttribution(NOW);
    expect(events()[0].fraudFlags).toEqual(["SELF_REFERRAL"]);
  });

  it("SAME_PHONE only when both phones are known and equal", async () => {
    db.rows("crmContact")[0].phoneE164 = "+998901112233";
    db.seed("crmContact", { id: "c_f1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "f1", phoneE164: "+998901112233" });
    db.seed("crmContact", { id: "c_f2", workspaceId: "w1", instagramAccountId: "a1", igUserId: "f2", phoneE164: "+998909998877" });
    db.seed("crmContact", { id: "c_f3", workspaceId: "w1", instagramAccountId: "a1", igUserId: "f3", phoneE164: null });
    refEvent({ senderId: "f1", timestamp: at("09:00") });
    refEvent({ senderId: "f2", timestamp: at("09:01") });
    refEvent({ senderId: "f3", timestamp: at("09:02") });
    await runReferralAttribution(NOW);
    const byReferee = Object.fromEntries(events().map((e) => [e.refereeIgUserId, e.fraudFlags]));
    expect(byReferee).toEqual({ f1: ["SAME_PHONE"], f2: [], f3: [] });
  });

  it("BURST: the event beyond the daily limit is flagged, the ones within it are not", async () => {
    db.rows("referralProgram")[0].burstLimitPerDay = 2;
    refEvent({ senderId: "f1", timestamp: at("09:00") });
    refEvent({ senderId: "f2", timestamp: at("09:01") });
    refEvent({ senderId: "f3", timestamp: at("09:02") });
    await runReferralAttribution(NOW);
    const byReferee = Object.fromEntries(events().map((e) => [e.refereeIgUserId, e.fraudFlags]));
    expect(byReferee).toEqual({ f1: [], f2: [], f3: ["BURST"] });
  });

  it("BURST counts only the last 24 hours", async () => {
    db.rows("referralProgram")[0].burstLimitPerDay = 1;
    db.seed("referralEvent", {
      programId: "p1", workspaceId: "w1", codeId: "rc1", referrerIgUserId: "ref1", refereeIgUserId: "yesterday", sourceEventId: "x",
      createdAt: new Date("2026-10-15T08:00:00Z"),
    });
    refEvent({ senderId: "f1", timestamp: at("09:00") });
    await runReferralAttribution(NOW);
    expect(events().find((e) => e.refereeIgUserId === "f1")!.fraudFlags).toEqual([]);
  });

  it("ALREADY_KNOWN_CONTACT: earlier events of the friend count, the carrying event itself and later ones do not", async () => {
    db.seed("instagramEvent", {
      id: "old_dm", workspaceId: "w1", instagramAccountId: "a1", eventType: "DIRECT_MESSAGE", senderId: "known", messageId: "old",
      text: "salom", timestamp: new Date("2026-10-10T09:00:00Z"), createdAt: new Date("2026-10-10T09:00:00Z"), rawPayload: {},
    });
    db.seed("instagramEvent", {
      id: "later_dm", workspaceId: "w1", instagramAccountId: "a1", eventType: "DIRECT_MESSAGE", senderId: "fresh", messageId: "later",
      text: "narx?", timestamp: at("09:30"), createdAt: at("09:30"), rawPayload: {},
    });
    refEvent({ senderId: "known", timestamp: at("09:00") });
    refEvent({ senderId: "fresh", timestamp: at("09:00") });
    await runReferralAttribution(NOW);
    const byReferee = Object.fromEntries(events().map((e) => [e.refereeIgUserId, e.fraudFlags]));
    expect(byReferee).toEqual({ known: ["ALREADY_KNOWN_CONTACT"], fresh: [] });
  });

  it("can raise several flags at once", async () => {
    db.rows("referralProgram")[0].burstLimitPerDay = 1;
    refEvent({ senderId: "f1", timestamp: at("09:00") });
    refEvent({ senderId: "ref1", timestamp: at("09:01") });
    await runReferralAttribution(NOW);
    expect(events().find((e) => e.refereeIgUserId === "ref1")!.fraudFlags).toEqual(["SELF_REFERRAL", "BURST"]);
  });
});

describe("fraud.ts (pure)", () => {
  const base = {
    referrerIgUserId: "a", refereeIgUserId: "b", referrerPhone: null, refereePhone: null,
    referrerEventsIn24h: 1, burstLimitPerDay: 10, refereeKnownBefore: false,
  };

  it("matrix", () => {
    expect(computeFraudFlags(base)).toEqual([]);
    expect(computeFraudFlags({ ...base, refereeIgUserId: "a" })).toEqual(["SELF_REFERRAL"]);
    expect(computeFraudFlags({ ...base, referrerPhone: "+1", refereePhone: "+1" })).toEqual(["SAME_PHONE"]);
    expect(computeFraudFlags({ ...base, referrerPhone: "+1", refereePhone: null })).toEqual([]);
    expect(computeFraudFlags({ ...base, referrerPhone: "+1", refereePhone: "+2" })).toEqual([]);
    expect(computeFraudFlags({ ...base, referrerEventsIn24h: 10 })).toEqual([]);
    expect(computeFraudFlags({ ...base, referrerEventsIn24h: 11 })).toEqual(["BURST"]);
    expect(computeFraudFlags({ ...base, refereeKnownBefore: true })).toEqual(["ALREADY_KNOWN_CONTACT"]);
  });

  it("merges in canonical order and blocks only unreviewed flagged events", () => {
    expect(mergeFlags(["BURST"], ["SAME_PHONE", "BURST"])).toEqual(["SAME_PHONE", "BURST"]);
    expect(isBlocked({ fraudFlags: [], reviewedAt: null })).toBe(false);
    expect(isBlocked({ fraudFlags: ["BURST"], reviewedAt: null })).toBe(true);
    expect(isBlocked({ fraudFlags: ["BURST"], reviewedAt: new Date() })).toBe(false);
  });
});
