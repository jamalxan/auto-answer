/**
 * ETAP 9.4 — points ledger, badges, settings and the leaderboard.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/queue/client", () => ({ getRedisConnection: () => ({}) }));

import { DEFAULT_BADGES, checkBadges } from "../lib/engagement/badges";
import { ledger, leaderboard, periodStart } from "../lib/engagement/leaderboard";
import { DEFAULT_POINTS_RULES, awardPoints, pointsOf } from "../lib/engagement/points";
import { getSettings, saveSettings } from "../lib/engagement/settings";
import { db, resetDb } from "./helpers/db-instance";

const NOW = new Date("2026-10-16T10:00:00Z");

function seed() {
  db.seed("workspace", { id: "w1", ownerId: "u1" });
  db.seed("workspace", { id: "w2", ownerId: "u2" });
  db.seed("crmContact", { id: "c1", workspaceId: "w1", instagramAccountId: "a1", igUserId: "u_1", username: "ali", name: "Ali" });
  db.seed("crmContact", { id: "c2", workspaceId: "w1", instagramAccountId: "a1", igUserId: "u_2", username: "vali" });
  db.seed("crmContact", { id: "c3", workspaceId: "w1", instagramAccountId: "a1", igUserId: "u_3", username: "zafar" });
  db.seed("crmContact", { id: "cw2", workspaceId: "w2", instagramAccountId: "a2", igUserId: "u_9" });
}

const award = (extra: Record<string, unknown> = {}) =>
  awardPoints({ workspaceId: "w1", contactId: "c1", reason: "purchase", sourceTable: "CrmDeal", sourceId: "d1", occurredAt: NOW, ...extra } as never);

beforeEach(() => {
  resetDb();
  seed();
});

describe("defaults", () => {
  it("match the contract", () => {
    expect(DEFAULT_POINTS_RULES).toEqual({
      comment: { points: 1, enabled: false },
      giveaway_entry: { points: 2, enabled: true },
      referral_qualified: { points: 10, enabled: true },
      purchase: { points: 20, enabled: true },
    });
    expect(DEFAULT_BADGES).toEqual([
      { key: "faol", name: "Faol", threshold: 10 },
      { key: "elchi", name: "Elchi", threshold: 50 },
      { key: "vip", name: "VIP", threshold: 150 },
    ]);
  });
});

describe("awardPoints", () => {
  it("takes the default points from the settings and records a NOTE on the timeline", async () => {
    const result = await award();
    expect(result).toMatchObject({ awarded: true, points: 20 });
    expect(db.rows("engagementPoint")).toHaveLength(1);
    expect(db.rows("engagementPoint")[0]).toMatchObject({ workspaceId: "w1", contactId: "c1", points: 20, reason: "purchase", sourceTable: "CrmDeal", sourceId: "d1" });
    const notes = db.rows("crmActivity").filter((a) => a.type === "NOTE");
    expect(notes).toHaveLength(2); // the points note + the "Faol" badge (20 >= 10)
    expect(notes.map((n) => n.title)).toContain("Ball: +20 (Xarid)");
    expect(notes.map((n) => n.title)).toContain("Nishon: Faol");
  });

  it("is idempotent on (sourceTable, sourceId, reason): replays add nothing", async () => {
    await award();
    const again = await award();
    const concurrent = await Promise.all([award(), award()]);
    expect(again).toMatchObject({ awarded: false, skipped: "duplicate" });
    expect(concurrent.every((r) => !r.awarded)).toBe(true);
    expect(db.rows("engagementPoint")).toHaveLength(1);
    expect(await pointsOf("w1", "c1")).toBe(20);
    // A different reason on the same source is a different row.
    expect((await award({ reason: "giveaway_entry" })).awarded).toBe(true);
  });

  it("honours explicit points, and skips a disabled / unknown rule or zero points", async () => {
    expect((await award({ points: 7 })).points).toBe(7);
    expect((await award({ reason: "comment", sourceTable: "InstagramEvent", sourceId: "e1" })).skipped).toBe("disabled");
    expect((await award({ reason: "weird", sourceId: "x" })).skipped).toBe("disabled");
    expect((await award({ points: 0, sourceId: "z" })).skipped).toBe("zero");
    expect((await award({ points: -5, sourceId: "z2" })).skipped).toBe("zero");
    expect(db.rows("engagementPoint")).toHaveLength(1);
  });

  it("never throws: a contact of another workspace or a broken database just skips", async () => {
    expect((await award({ contactId: "cw2" })).skipped).toBe("no_contact");
    expect((await award({ contactId: "missing", sourceId: "q" })).awarded).toBe(false);
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    db.rows("engagementPoint").push = () => {
      throw new Error("db down");
    };
    await expect(award({ sourceId: "boom" })).resolves.toMatchObject({ awarded: false, skipped: "error" });
    spy.mockRestore();
  });
});

describe("badges", () => {
  it("awards each badge once, at its threshold, with a timeline note", async () => {
    // 5 + 4 = 9: nothing; +1 = 10: Faol.
    await award({ points: 5, sourceId: "s1" });
    await award({ points: 4, sourceId: "s2" });
    expect(db.rows("engagementBadge")).toHaveLength(0);
    await award({ points: 1, sourceId: "s3" });
    expect(db.rows("engagementBadge").map((b) => b.badgeKey)).toEqual(["faol"]);
    // 49 + 1 = 50 reaches Elchi; nothing repeats.
    await award({ points: 39, sourceId: "s4" });
    await award({ points: 1, sourceId: "s5" });
    expect(db.rows("engagementBadge").map((b) => b.badgeKey)).toEqual(["faol", "elchi"]);
    expect(db.rows("crmActivity").filter((a) => a.title === "Nishon: Faol")).toHaveLength(1);
    expect(db.rows("crmActivity").filter((a) => a.title === "Nishon: Elchi")).toHaveLength(1);
    // Direct re-check is a no-op.
    expect(await checkBadges("w1", "c1")).toEqual([]);
  });

  it("one big award crosses several thresholds at once", async () => {
    await award({ points: 200, sourceId: "big" });
    expect(db.rows("engagementBadge").map((b) => b.badgeKey).sort()).toEqual(["elchi", "faol", "vip"]);
  });

  it("uses the thresholds from the settings", async () => {
    await saveSettings("w1", { pointsRules: {}, badgeRules: [{ key: "yangi", name: "Yangi", threshold: 3 }] });
    await award({ points: 3, sourceId: "s1" });
    expect(db.rows("engagementBadge").map((b) => b.badgeKey)).toEqual(["yangi"]);
  });
});

describe("settings", () => {
  it("merges the defaults with what was saved", async () => {
    expect(await getSettings("w1")).toEqual({ pointsRules: DEFAULT_POINTS_RULES, badgeRules: DEFAULT_BADGES });
    const saved = await saveSettings("w1", { pointsRules: { comment: { points: 3, enabled: true }, purchase: 50 }, badgeRules: [] });
    expect(saved.pointsRules.comment).toEqual({ points: 3, enabled: true });
    expect(saved.pointsRules.purchase).toEqual({ points: 50, enabled: true });
    expect(saved.pointsRules.giveaway_entry).toEqual(DEFAULT_POINTS_RULES.giveaway_entry);
    expect(saved.badgeRules).toEqual(DEFAULT_BADGES);
    // Another workspace keeps its defaults.
    expect((await getSettings("w2")).pointsRules.purchase.points).toBe(20);
  });

  it("validates points, thresholds, keys and the badge count", async () => {
    const badge = (key: string, threshold = 5) => ({ key, name: key, threshold });
    await expect(saveSettings("w1", { pointsRules: { purchase: 1001 } })).rejects.toMatchObject({ status: 422 });
    await expect(saveSettings("w1", { pointsRules: { purchase: -1 } })).rejects.toMatchObject({ status: 422 });
    await expect(saveSettings("w1", { pointsRules: { purchase: 1.5 } })).rejects.toMatchObject({ status: 422 });
    await expect(saveSettings("w1", { pointsRules: { nomalum: 5 } })).rejects.toMatchObject({ status: 422 });
    await expect(saveSettings("w1", { badgeRules: [badge("a", 0)] })).rejects.toMatchObject({ status: 422 });
    await expect(saveSettings("w1", { badgeRules: [badge("a", 100_001)] })).rejects.toMatchObject({ status: 422 });
    await expect(saveSettings("w1", { badgeRules: [badge("Katta Harf")] })).rejects.toMatchObject({ status: 422 });
    await expect(saveSettings("w1", { badgeRules: [badge("a"), badge("a", 9)] })).rejects.toMatchObject({ status: 422, message: expect.stringContaining("takrorlangan") });
    await expect(saveSettings("w1", { badgeRules: Array.from({ length: 21 }, (_, i) => badge(`b${i}`, i + 1)) })).rejects.toMatchObject({ status: 422 });
    // 20 unique badges and the 0 / 1000 edges are fine.
    await expect(
      saveSettings("w1", { pointsRules: { purchase: 0, referral_qualified: 1000 }, badgeRules: Array.from({ length: 20 }, (_, i) => badge(`b${i}`, i + 1)) })
    ).resolves.toBeTruthy();
    expect(db.rows("engagementSettings")).toHaveLength(1);
  });
});

describe("leaderboard", () => {
  // now = 2026-10-16 10:00Z = 15:00 Tashkent. 7d starts at Tashkent midnight of Oct 10 = Oct 9 19:00Z.
  const point = (contactId: string, points: number, occurredAt: Date, id: string) =>
    db.seed("engagementPoint", { id, workspaceId: "w1", contactId, points, reason: "purchase", sourceTable: "T", sourceId: id, occurredAt });

  it("computes the period boundaries on Tashkent days", () => {
    expect(periodStart("7d", NOW)!.toISOString()).toBe("2026-10-09T19:00:00.000Z");
    expect(periodStart("30d", NOW)!.toISOString()).toBe("2026-09-16T19:00:00.000Z");
    expect(periodStart("all", NOW)).toBeNull();
  });

  it("aggregates per contact, filters by period at the Tashkent midnight and sorts by points", async () => {
    point("c1", 10, new Date("2026-10-09T19:00:00.000Z"), "p1"); // exactly the 7d boundary: in
    point("c1", 5, new Date("2026-10-16T09:00:00.000Z"), "p2");
    point("c2", 40, new Date("2026-10-09T18:59:59.999Z"), "p3"); // 1 ms before: out of 7d
    point("c2", 3, new Date("2026-10-12T00:00:00.000Z"), "p4");
    point("c3", 100, new Date("2026-09-16T18:59:59.999Z"), "p5"); // out of 30d
    point("c3", 1, new Date("2026-09-16T19:00:00.000Z"), "p6"); // in 30d
    db.seed("engagementPoint", { id: "other", workspaceId: "w2", contactId: "cw2", points: 999, reason: "purchase", sourceTable: "T", sourceId: "other", occurredAt: NOW });

    const week = await leaderboard("w1", { period: "7d", limit: 10, now: NOW });
    expect(week.map((r) => [r.contactId, r.points])).toEqual([["c1", 15], ["c2", 3]]);
    const month = await leaderboard("w1", { period: "30d", limit: 10, now: NOW });
    expect(month.map((r) => [r.contactId, r.points])).toEqual([["c2", 43], ["c1", 15], ["c3", 1]]);
    const all = await leaderboard("w1", { period: "all", limit: 10, now: NOW });
    expect(all.map((r) => [r.contactId, r.points])).toEqual([["c3", 101], ["c2", 43], ["c1", 15]]);
  });

  it("returns username, name and badges, honours the limit and ties", async () => {
    point("c1", 10, NOW, "p1");
    point("c2", 10, NOW, "p2");
    point("c3", 30, NOW, "p3");
    db.seed("engagementBadge", { workspaceId: "w1", contactId: "c3", badgeKey: "faol" });
    db.seed("engagementBadge", { workspaceId: "w1", contactId: "c3", badgeKey: "ketdi" });
    const rows = await leaderboard("w1", { period: "all", limit: 2, now: NOW });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toEqual({ contactId: "c3", username: "zafar", name: null, points: 30, badges: [{ key: "faol", name: "Faol" }, { key: "ketdi", name: "ketdi" }] });
    expect(rows[1].contactId).toBe("c1"); // tie broken by id
    expect(await leaderboard("w1", { period: "7d", now: new Date("2030-01-01T00:00:00Z") })).toEqual([]);
  });

  it("never loads the ledger rows: totals and the ranking are database aggregates (SUM / GROUP BY)", async () => {
    for (let i = 0; i < 30; i++) {
      db.seed("engagementPoint", { workspaceId: "w1", contactId: i % 2 ? "c1" : "c2", points: 3, reason: "purchase", sourceTable: "T", sourceId: `s${i}`, occurredAt: NOW });
    }
    let pointRowLoads = 0;
    const original = db.model.bind(db);
    const spy = vi.spyOn(db, "model").mockImplementation((name: string) => {
      const model = original(name);
      if (name === "engagementPoint") {
        const findMany = model.findMany;
        model.findMany = (async (...args: Parameters<typeof findMany>) => {
          pointRowLoads++;
          return findMany(...args);
        }) as typeof findMany;
      }
      return model;
    });
    expect(await pointsOf("w1", "c1")).toBe(45);
    expect(await pointsOf("w1", "nobody")).toBe(0);
    const board = await leaderboard("w1", { period: "all", limit: 1, now: NOW });
    expect(board).toHaveLength(1);
    expect(board[0].points).toBe(45);
    expect(board[0].contactId).toBe("c1"); // tie 45/45: contactId ascending
    expect(pointRowLoads).toBe(0);
    spy.mockRestore();
  });

  it("pages the ledger newest first, optionally per contact", async () => {
    point("c1", 1, new Date("2026-10-16T01:00:00Z"), "p1");
    point("c1", 2, new Date("2026-10-16T02:00:00Z"), "p2");
    point("c2", 3, new Date("2026-10-16T03:00:00Z"), "p3");
    const first = await ledger("w1", { limit: 2 });
    expect(first.items.map((i) => i.id)).toEqual(["p3", "p2"]);
    const second = await ledger("w1", { limit: 2, cursor: first.nextCursor });
    expect(second.items.map((i) => i.id)).toEqual(["p1"]);
    expect(second.nextCursor).toBeNull();
    expect((await ledger("w1", { contactId: "c1" })).items.map((i) => i.id)).toEqual(["p2", "p1"]);
  });
});
