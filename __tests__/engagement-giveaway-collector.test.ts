/**
 * Giveaway collector, follow policies and backfill against the in-memory
 * database: InstagramEvent → GiveawayEntry, one entry per person.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  getUserFollowStatus: vi.fn(),
  getRecentMediaComments: vi.fn(),
  enqueueEngagement: vi.fn(),
  markTokenBroken: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/meta/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/meta/client")>()),
  getUserFollowStatus: mocks.getUserFollowStatus,
  getRecentMediaComments: mocks.getRecentMediaComments,
}));
vi.mock("@/lib/meta/oauth", () => ({
  decryptToken: (value: string) => `plain:${value}`,
  encryptToken: (value: string) => value,
}));
vi.mock("@/lib/meta/token-health", () => ({ markTokenBroken: mocks.markTokenBroken }));
vi.mock("@/lib/billing/usage", () => ({
  reserveWorkspaceDMSend: vi.fn(),
  releaseWorkspaceDMReservation: vi.fn(),
}));
vi.mock("@/lib/utils/rate-limiter", () => ({ reserveDMSlot: vi.fn() }));
vi.mock("@/lib/engagement/config", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/engagement/config")>()),
  BACKFILL_CAP: 5,
}));
vi.mock("@/lib/engagement/queue", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/engagement/queue")>()),
  enqueueEngagement: mocks.enqueueEngagement,
}));

import { COLLECT_BATCH } from "@/lib/engagement/config";
import { hasActiveEngagement } from "@/lib/engagement/gate";
import { failBackfill, runBackfill, startBackfill } from "@/lib/engagement/giveaway/backfill";
import { drainGiveaway, runGiveawayCollector } from "@/lib/engagement/giveaway/collector";
import { setFollowThrottleForTests } from "@/lib/engagement/giveaway/follow";
import { markEntry } from "@/lib/engagement/giveaway/lifecycle";
import { resetEngagementMaintenanceForTests, runEngagementMaintenance } from "@/lib/engagement/worker";

const NOW = new Date("2026-10-20T12:00:00Z");
const WS = "ws1";
const IG_ID = "17841400000000001";
const POST = "18000000000000777";
const AD = "18000000000000999";
const rows = (model: string) => db.rows(model);

let account: Record<string, unknown>;
let tick = 0;

function seedGiveaway(rules: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) {
  return db.seed("giveaway", {
    workspaceId: WS,
    instagramAccountId: account.id,
    name: "Yozgi giveaway",
    mediaId: POST,
    rules,
    windowStart: new Date("2026-10-19T00:00:00Z"),
    windowEnd: new Date("2026-10-25T00:00:00Z"),
    status: "ACTIVE",
    ...extra,
  });
}

function seedComment(senderId: string, text: string, extra: Record<string, unknown> = {}) {
  tick++;
  return db.seed("instagramEvent", {
    workspaceId: WS,
    instagramAccountId: account.id,
    eventType: "COMMENT",
    senderId,
    senderUsername: `user${senderId.slice(-2)}`,
    messageId: `c${tick}`,
    mediaId: POST,
    text,
    timestamp: new Date(NOW.getTime() - 3600_000 + tick * 1000),
    createdAt: new Date(NOW.getTime() - 3600_000 + tick * 1000),
    rawPayload: {},
    ...extra,
  });
}

function seedMention(senderId: string) {
  return seedComment(senderId, "", { eventType: "STORY_MENTION", mediaId: null, storyId: "st1" });
}

const entryOf = (igUserId: string) => rows("giveawayEntry").find((e) => e.igUserId === igUserId);

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  tick = 0;
  delete process.env.ENGAGEMENT_DISABLED;
  setFollowThrottleForTests(0);
  resetEngagementMaintenanceForTests();
  db.seed("workspace", { id: WS });
  account = db.seed("instagramAccount", { workspaceId: WS, instagramId: IG_ID, username: "shop", accessToken: "tok" });
  mocks.enqueueEngagement.mockResolvedValue(true);
});

describe("collector", () => {
  it("makes one entry per person: later comments add handles and counts, the qualifying comment is kept", async () => {
    seedGiveaway({ comment: { mode: "CONTAINS", keyword: "men" }, tagFriends: { required: true, min: 2 } });
    seedComment("6001", "salom");
    seedComment("6001", "men ham @ali");
    seedComment("6001", "yana @vali @ali");
    seedComment("6002", "men @x @y");

    const summary = await runGiveawayCollector(NOW);

    expect(summary).toMatchObject({ giveaways: 1, scanned: 4, created: 2, updated: 2 });
    expect(rows("giveawayEntry")).toHaveLength(2);
    const a = entryOf("6001")!;
    expect(a.commentCount).toBe(3);
    expect(a.firstCommentText).toBe("men ham @ali");
    expect(a.taggedUsernames).toEqual(["ali", "vali"]);
    expect(a.status).toBe("ELIGIBLE");
    expect(entryOf("6002")!.status).toBe("ELIGIBLE");
    expect(rows("giveaway")[0]).toMatchObject({ entriesCount: 2, eligibleCount: 2 });
  });

  it("applies keyword, tag-friends (distinct, business excluded) and mention rules", async () => {
    seedGiveaway({ comment: { mode: "CONTAINS", keyword: "men" }, tagFriends: { required: true, min: 2 }, mention: { required: true } });
    seedComment("6001", "boshqa matn @a @b");
    seedComment("6002", "men @a @a @shop");
    seedComment("6003", "men @a @b");
    seedMention("6003");

    await runGiveawayCollector(NOW);

    expect(entryOf("6001")).toMatchObject({ status: "INELIGIBLE" });
    expect(entryOf("6002")).toMatchObject({ status: "INELIGIBLE", taggedUsernames: ["a"] });
    expect(entryOf("6003")).toMatchObject({ status: "ELIGIBLE" });
    expect(entryOf("6003")!.mentionedAt).toBeInstanceOf(Date);
  });

  it("a story mention that arrives before the comment is not lost", async () => {
    seedGiveaway({ mention: { required: true } });
    seedMention("6001");
    await runGiveawayCollector(NOW);
    expect(entryOf("6001")).toMatchObject({ status: "INELIGIBLE", firstCommentId: "", commentCount: 0 });

    seedComment("6001", "ishtirok");
    await runGiveawayCollector(NOW);
    expect(entryOf("6001")).toMatchObject({ status: "ELIGIBLE", firstCommentText: "ishtirok", commentCount: 1 });
  });

  it("skips the business's own account and events outside the window or on other posts", async () => {
    seedGiveaway();
    seedComment(IG_ID, "javob");
    seedComment("6001", "erta", { timestamp: new Date("2026-10-18T23:00:00Z") });
    seedComment("6002", "kech", { timestamp: new Date("2026-10-26T00:00:00Z") });
    seedComment("6003", "boshqa post", { mediaId: "18000000000000555" });
    seedComment("6004", "to'g'ri");

    await runGiveawayCollector(NOW);

    expect(rows("giveawayEntry").map((e) => e.igUserId)).toEqual(["6004"]);
  });

  it("counts a comment on the ad's original_media_id", async () => {
    seedGiveaway();
    seedComment("6001", "reklama orqali", {
      mediaId: AD,
      rawPayload: { item: { value: { media: { id: AD, original_media_id: POST } } } },
    });
    await runGiveawayCollector(NOW);
    expect(entryOf("6001")).toBeTruthy();
  });

  it("advances the cursor, does not re-count on the next tick, and works in batches", async () => {
    const giveaway = seedGiveaway();
    for (let i = 0; i < COLLECT_BATCH + 1; i++) seedComment(String(7000 + i), "ha");

    const first = await runGiveawayCollector(NOW);
    expect(first.scanned).toBe(COLLECT_BATCH);
    expect(rows("giveawayEntry")).toHaveLength(COLLECT_BATCH);
    const cursor = rows("giveaway")[0].collectCursorId;
    expect(cursor).toBeTruthy();

    const second = await runGiveawayCollector(NOW);
    expect(second.scanned).toBe(1);
    expect(rows("giveawayEntry")).toHaveLength(COLLECT_BATCH + 1);
    expect(rows("giveaway")[0].collectCursorId).not.toBe(cursor);

    const third = await runGiveawayCollector(NOW);
    expect(third.scanned).toBe(0);
    expect(rows("giveaway")[0].entriesCount).toBe(COLLECT_BATCH + 1);
    expect(giveaway.id).toBeTruthy();
  });

  it("leaves DRAFT and CLOSED giveaways alone", async () => {
    seedGiveaway({}, { status: "DRAFT" });
    seedGiveaway({}, { status: "CLOSED", mediaId: "other" });
    seedComment("6001", "ha");
    expect((await runGiveawayCollector(NOW)).giveaways).toBe(0);
    expect(rows("giveawayEntry")).toHaveLength(0);
  });

  it("never overrides a decision the owner made by hand", async () => {
    seedGiveaway({ follow: { required: true } });
    mocks.getUserFollowStatus.mockResolvedValue(null);
    seedComment("6001", "ha");
    await runGiveawayCollector(NOW);
    expect(entryOf("6001")).toMatchObject({ status: "PENDING_CHECK", followResult: "UNVERIFIABLE" });

    await markEntry(WS, rows("giveaway")[0].id as string, entryOf("6001")!.id as string, "ELIGIBLE", "u1");
    seedComment("6001", "yana");
    await runGiveawayCollector(NOW);
    expect(entryOf("6001")).toMatchObject({ status: "ELIGIBLE", commentCount: 2 });
  });
});

describe("review fixes: cursor, mention, points", () => {
  it("an idle tick still moves the cursor to now - 60s (never backwards), and a late row inside the lag is still collected", async () => {
    seedGiveaway();
    seedComment("6001", "ha", { eventType: "DIRECT_MESSAGE" });
    const first = await runGiveawayCollector(NOW);
    expect(first.scanned).toBe(0);
    expect(rows("giveaway")[0].collectCursorAt).toEqual(new Date(NOW.getTime() - 60_000));
    // an older clock never moves it back
    await runGiveawayCollector(new Date(NOW.getTime() - 3600_000));
    expect(rows("giveaway")[0].collectCursorAt).toEqual(new Date(NOW.getTime() - 60_000));

    // a row stored inside the 60 s lag is picked up by the next tick (activation resets the cursor, so scans never grow)
    seedComment("6002", "ha", { createdAt: new Date(NOW.getTime() - 30_000), timestamp: new Date(NOW.getTime() - 30_000) });
    const next = await runGiveawayCollector(new Date(NOW.getTime() + 5_000));
    expect(next).toMatchObject({ scanned: 1, created: 1 });
    expect(entryOf("6002")).toBeTruthy();
    // and the following idle tick starts after it
    const idle = await runGiveawayCollector(new Date(NOW.getTime() + 10_000));
    expect(idle.scanned).toBe(0);
  });

  it("scopes the scan to the giveaway's workspace and account (other tenants' events are never read)", async () => {
    seedGiveaway();
    seedComment("6001", "ha", { workspaceId: "ws-other" });
    const otherAccount = db.seed("instagramAccount", { workspaceId: WS, instagramId: "999", username: "x", accessToken: "t" });
    seedComment("6002", "ha", { instagramAccountId: otherAccount.id });
    seedComment("6003", "ha");
    const summary = await runGiveawayCollector(NOW);
    expect(summary.scanned).toBe(1);
    expect(rows("giveawayEntry").map((e) => e.igUserId)).toEqual(["6003"]);
  });

  it("a story mention alone never makes someone a participant unless the rules ask for it", async () => {
    seedGiveaway({ comment: { required: false } });
    seedMention("6001");
    seedComment("6002", "ha");
    seedMention("6002");
    await runGiveawayCollector(NOW);
    expect(entryOf("6001")).toBeUndefined();
    // somebody who already has an entry still gets the mention recorded
    expect(entryOf("6002")).toMatchObject({ status: "ELIGIBLE" });
    expect(entryOf("6002")!.mentionedAt).toBeInstanceOf(Date);
  });

  it("a story mention creates the entry when mention.required is true", async () => {
    seedGiveaway({ comment: { required: false }, mention: { required: true } });
    seedMention("6001");
    await runGiveawayCollector(NOW);
    expect(entryOf("6001")).toMatchObject({ status: "ELIGIBLE" });
  });

  it("awards giveaway_entry points once per created entry, only for known CRM contacts and enabled rules", async () => {
    seedGiveaway();
    db.seed("crmContact", { id: "c1", workspaceId: WS, instagramAccountId: account.id, igUserId: "6001", username: "a" });
    seedComment("6001", "ha");
    seedComment("6001", "yana");
    seedComment("6002", "ha"); // no CRM contact: skipped silently
    await runGiveawayCollector(NOW);
    await runGiveawayCollector(NOW);

    const points = rows("engagementPoint");
    expect(points).toHaveLength(1);
    expect(points[0]).toMatchObject({ contactId: "c1", reason: "giveaway_entry", sourceTable: "GiveawayEntry", sourceId: entryOf("6001")!.id, points: 2 });
    expect(entryOf("6001")!.contactId).toBe("c1");
  });

  it("respects the workspace's disabled giveaway_entry rule", async () => {
    seedGiveaway();
    db.seed("engagementSettings", { workspaceId: WS, pointsRules: { giveaway_entry: { points: 5, enabled: false } } });
    db.seed("crmContact", { id: "c1", workspaceId: WS, instagramAccountId: account.id, igUserId: "6001", username: "a" });
    seedComment("6001", "ha");
    await runGiveawayCollector(NOW);
    expect(rows("engagementPoint")).toHaveLength(0);
  });

  it("drain runs under the collector's guard: it waits for a running tick and does one follow round", async () => {
    const giveaway = seedGiveaway({ follow: { required: true, onUnverifiable: "HOLD" } });
    seedComment("6001", "ha");
    let release!: (value: boolean) => void;
    mocks.getUserFollowStatus.mockImplementation(() => new Promise<boolean>((resolve) => (release = resolve)));

    const ticking = runGiveawayCollector(NOW);
    for (let i = 0; i < 50 && mocks.getUserFollowStatus.mock.calls.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
    expect(mocks.getUserFollowStatus).toHaveBeenCalledTimes(1);

    let drained = false;
    const draining = drainGiveaway(giveaway.id as string, NOW).then(() => (drained = true));
    await new Promise((r) => setTimeout(r, 80));
    expect(drained).toBe(false);

    release(true);
    await ticking;
    await draining;
    expect(drained).toBe(true);
    expect(entryOf("6001")).toMatchObject({ followResult: "FOLLOWER", status: "ELIGIBLE" });
    expect(mocks.getUserFollowStatus).toHaveBeenCalledTimes(1);
  });
});

describe("follow check", () => {
  it("never starves new entries behind old UNVERIFIABLE ones: NOT_CHECKED first, then the oldest due re-checks", async () => {
    const giveaway = seedGiveaway({ follow: { required: true, onUnverifiable: "HOLD" } });
    const base = { giveawayId: giveaway.id, workspaceId: WS, firstCommentId: "c", firstCommentText: "ha", firstCommentAt: NOW, status: "PENDING_CHECK" };
    for (let i = 0; i < 130; i++) {
      db.seed("giveawayEntry", { ...base, igUserId: `old${i}`, followResult: "UNVERIFIABLE", followCheckedAt: new Date(NOW.getTime() - 3600_000) });
    }
    db.seed("giveawayEntry", { ...base, igUserId: "due1", followResult: "UNVERIFIABLE", followCheckedAt: new Date(NOW.getTime() - 8 * 3600_000) });
    db.seed("giveawayEntry", { ...base, igUserId: "due2", followResult: "UNVERIFIABLE", followCheckedAt: new Date(NOW.getTime() - 9 * 3600_000) });
    db.seed("giveawayEntry", { ...base, igUserId: "fresh", followResult: "NOT_CHECKED" });
    mocks.getUserFollowStatus.mockResolvedValue(true);

    const summary = await runGiveawayCollector(NOW);

    expect(summary.followChecks).toBe(3);
    const asked = mocks.getUserFollowStatus.mock.calls.map((c) => c[1]);
    expect(asked[0]).toBe("fresh");
    expect(asked.slice(1)).toEqual(["due2", "due1"]); // oldest due first
    expect(entryOf("fresh")).toMatchObject({ followResult: "FOLLOWER", status: "ELIGIBLE" });
    expect(entryOf("old0")).toMatchObject({ followResult: "UNVERIFIABLE" });
  });

  it.each([
    ["FOLLOWER", true, "HOLD", "ELIGIBLE"],
    ["NOT_FOLLOWER", false, "HOLD", "INELIGIBLE"],
    ["UNVERIFIABLE", null, "ALLOW", "ELIGIBLE"],
    ["UNVERIFIABLE", null, "HOLD", "PENDING_CHECK"],
    ["UNVERIFIABLE", null, "EXCLUDE", "INELIGIBLE"],
  ])("%s with policy %s/%s → %s", async (result, apiAnswer, policy, status) => {
    void result;
    seedGiveaway({ follow: { required: true, onUnverifiable: policy } });
    mocks.getUserFollowStatus.mockResolvedValue(apiAnswer);
    seedComment("6001", "ha");

    const summary = await runGiveawayCollector(NOW);

    expect(summary.followChecks).toBe(1);
    expect(mocks.getUserFollowStatus).toHaveBeenCalledWith("plain:tok", "6001");
    expect(entryOf("6001")).toMatchObject({ status, followResult: result });
    expect(entryOf("6001")!.followCheckedAt).toEqual(NOW);
  });

  it("asks once, caches the answer, re-asks an old UNVERIFIABLE only after the recheck interval", async () => {
    seedGiveaway({ follow: { required: true, onUnverifiable: "HOLD" } });
    mocks.getUserFollowStatus.mockResolvedValue(null);
    seedComment("6001", "ha");
    await runGiveawayCollector(NOW);
    await runGiveawayCollector(new Date(NOW.getTime() + 60_000));
    expect(mocks.getUserFollowStatus).toHaveBeenCalledTimes(1);

    mocks.getUserFollowStatus.mockResolvedValue(true);
    await runGiveawayCollector(new Date(NOW.getTime() + 7 * 3600_000));
    expect(mocks.getUserFollowStatus).toHaveBeenCalledTimes(2);
    expect(entryOf("6001")).toMatchObject({ status: "ELIGIBLE", followResult: "FOLLOWER" });
  });

  it("is not called when the rules do not need it or another rule already failed", async () => {
    seedGiveaway({ comment: { mode: "CONTAINS", keyword: "men" } });
    seedComment("6001", "ha");
    await runGiveawayCollector(NOW);
    expect(mocks.getUserFollowStatus).not.toHaveBeenCalled();

    resetDb();
    db.seed("workspace", { id: WS });
    account = db.seed("instagramAccount", { workspaceId: WS, instagramId: IG_ID, username: "shop", accessToken: "tok" });
    seedGiveaway({ comment: { mode: "CONTAINS", keyword: "men" }, follow: { required: true } });
    seedComment("6001", "salom");
    await runGiveawayCollector(NOW);
    expect(mocks.getUserFollowStatus).not.toHaveBeenCalled();
    expect(entryOf("6001")!.status).toBe("INELIGIBLE");
  });
});

describe("backfill", () => {
  const comment = (id: string, from: string, text: string, minutesAgo: number) => ({
    id,
    text,
    from: { id: from, username: `u${from.slice(-2)}` },
    timestamp: new Date(NOW.getTime() - minutesAgo * 60_000).toISOString(),
  });

  it("writes entries directly (no InstagramEvent rows), one per person, and is idempotent", async () => {
    const giveaway = seedGiveaway({ comment: { mode: "CONTAINS", keyword: "men" } }, { backfillStatus: "RUNNING" });
    mocks.getRecentMediaComments.mockResolvedValue([
      comment("k3", "6002", "men @a", 5),
      comment("k2", "6001", "yana @b", 10),
      comment("k1", "6001", "men @a", 20),
      comment("k0", IG_ID, "rahmat", 30),
    ]);

    const result = await runBackfill(WS, giveaway.id as string, NOW);

    expect(result).toMatchObject({ scanned: 4, entries: 2, capped: false });
    expect(rows("instagramEvent")).toHaveLength(0);
    expect(rows("giveawayEntry")).toHaveLength(2);
    expect(entryOf("6001")).toMatchObject({ firstCommentId: "k1", commentCount: 2, status: "ELIGIBLE", sourceEventIds: [] });
    expect(entryOf("6001")!.taggedUsernames).toEqual(["a", "b"]);
    expect(rows("giveaway")[0]).toMatchObject({ backfillStatus: "DONE", backfillScanned: 4, entriesCount: 2 });

    await runBackfill(WS, giveaway.id as string, NOW);
    expect(rows("giveawayEntry")).toHaveLength(2);
    expect(entryOf("6001")!.commentCount).toBe(2);
  });

  it("asks Meta for at most BACKFILL_CAP comments and says so when it hit the cap", async () => {
    const giveaway = seedGiveaway();
    mocks.getRecentMediaComments.mockResolvedValue(["a", "b", "c", "d", "e"].map((id, i) => comment(id, `600${i}`, "x", i + 1)));

    const result = await runBackfill(WS, giveaway.id as string, NOW);

    expect(mocks.getRecentMediaComments).toHaveBeenCalledWith("plain:tok", POST, new Date("2026-10-19T00:00:00Z").getTime(), 5);
    expect(result?.capped).toBe(true);
    expect(rows("giveaway")[0].backfillError).toMatch(/5 ta izoh/);
  });

  it("ignores comments outside the window and never throws: a Graph failure is stored", async () => {
    const giveaway = seedGiveaway();
    mocks.getRecentMediaComments.mockResolvedValueOnce([comment("old", "6001", "x", 60 * 24 * 40)]);
    await runBackfill(WS, giveaway.id as string, NOW);
    expect(rows("giveawayEntry")).toHaveLength(0);

    mocks.getRecentMediaComments.mockRejectedValueOnce(new Error("Graph 500"));
    await expect(runBackfill(WS, giveaway.id as string, NOW)).resolves.toBeNull();
    expect(rows("giveaway")[0]).toMatchObject({ backfillStatus: "FAILED" });
    expect(String(rows("giveaway")[0].backfillError)).toContain("Graph 500");
  });

  it("a RUNNING backfill with no progress for 10 minutes is stale: startBackfill restarts it; a fresh one still conflicts", async () => {
    const giveaway = seedGiveaway({}, { backfillStatus: "RUNNING", backfillScanned: 12 });
    await expect(startBackfill(WS, giveaway.id as string)).rejects.toMatchObject({ status: 409 });

    rows("giveaway")[0].updatedAt = new Date(Date.now() - 11 * 60_000);
    await expect(startBackfill(WS, giveaway.id as string)).resolves.toEqual({ status: "RUNNING" });
    expect(rows("giveaway")[0]).toMatchObject({ backfillStatus: "RUNNING", backfillScanned: 0 });
    expect(mocks.enqueueEngagement).toHaveBeenCalledTimes(1);
  });

  it("failBackfill resets only a RUNNING backfill (worker failed handler)", async () => {
    const giveaway = seedGiveaway({}, { backfillStatus: "RUNNING" });
    await failBackfill(giveaway.id as string, "worker restart");
    expect(rows("giveaway")[0]).toMatchObject({ backfillStatus: "FAILED", backfillError: "worker restart" });
    rows("giveaway")[0].backfillStatus = "DONE";
    await failBackfill(giveaway.id as string, "late");
    expect(rows("giveaway")[0].backfillStatus).toBe("DONE");
  });

  it("startBackfill marks RUNNING and queues the job; a second start while running conflicts", async () => {
    const giveaway = seedGiveaway();
    await expect(startBackfill(WS, giveaway.id as string)).resolves.toEqual({ status: "RUNNING" });
    expect(rows("giveaway")[0].backfillStatus).toBe("RUNNING");
    expect(mocks.enqueueEngagement).toHaveBeenCalledWith(
      "giveaway-backfill",
      { workspaceId: WS, giveawayId: giveaway.id },
      expect.objectContaining({ attempts: 1 })
    );
    await expect(startBackfill(WS, giveaway.id as string)).rejects.toMatchObject({ status: 409 });
    await expect(startBackfill("other-ws", giveaway.id as string)).rejects.toMatchObject({ status: 404 });
  });
});

describe("ENGAGEMENT_DISABLED", () => {
  it("turns the collector, the maintenance tick, the gate and the queue into no-ops", async () => {
    seedGiveaway();
    seedComment("6001", "ha");
    process.env.ENGAGEMENT_DISABLED = "1";

    expect(await runGiveawayCollector(NOW)).toMatchObject({ giveaways: 0, created: 0 });
    await runEngagementMaintenance({ force: true, now: NOW });
    expect(rows("giveawayEntry")).toHaveLength(0);
    expect(await hasActiveEngagement(account.id as string)).toBe(false);
    const { enqueueEngagement: realEnqueue } = await vi.importActual<typeof import("@/lib/engagement/queue")>("@/lib/engagement/queue");
    expect(await realEnqueue("giveaway-notify", { workspaceId: WS, giveawayId: "g", sequence: 1 })).toBe(false);
    expect(await runBackfill(WS, "g", NOW)).toBeNull();
  });

  it("enabled: the maintenance tick collects and the gate sees an ACTIVE giveaway", async () => {
    expect(await hasActiveEngagement(account.id as string)).toBe(false);
    seedGiveaway();
    expect(await hasActiveEngagement(account.id as string)).toBe(true);
    seedComment("6001", "ha");
    await runEngagementMaintenance({ force: true, now: NOW });
    expect(rows("giveawayEntry")).toHaveLength(1);
  });

  it("an active referral program engages the account too", async () => {
    db.seed("referralProgram", { workspaceId: WS, instagramAccountId: account.id, name: "Do'st taklif", active: true });
    expect(await hasActiveEngagement(account.id as string)).toBe(true);
  });
});
