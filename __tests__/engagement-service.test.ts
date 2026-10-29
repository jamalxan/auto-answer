/**
 * ETAP 9 — the engagement service: giveaway validation (account ownership,
 * window, rules, confirmation campaign type), DRAFT-only edits and deletes,
 * workspace scoping, entries paging, the permission matrix of the guard, the
 * pure verify route and the rule that the encrypted seed never leaves.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  developerSession: vi.fn(),
  workspaceContext: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: vi.fn() }));
vi.mock("@/lib/telegram/notify", () => ({ alertWorkspace: vi.fn() }));
vi.mock("@/lib/developer/auth", () => ({ getDeveloperSession: mocks.developerSession }));
// Not importOriginal: the real module pulls next-auth, which vitest cannot resolve.
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mocks.workspaceContext,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
  canManageBilling: (role: string) => role === "OWNER",
  hasWorkspaceRole: () => true,
}));

import { requireEngagement, stripSeeds, type EngagementAccess } from "@/lib/developer/engagement-guard";
import {
  createGiveaway,
  deleteGiveaway,
  entriesQuerySchema,
  getGiveaway,
  getGiveawayDetail,
  giveawayInputSchema,
  listEntries,
  listGiveaways,
  requireEntry,
  run,
  updateGiveaway,
  verifyBodySchema,
} from "@/lib/engagement/service";
import { createCommitment, drawWinners } from "@/lib/engagement/giveaway/draw";
import { POST as verifyRoute } from "@/app/api/engagement/verify/route";

type Row = Record<string, unknown>;
const rows = (model: string) => db.rows(model) as Row[];
const WS = "ws1";
const HOUR = 3_600_000;
const SECRET_SEED = "ENCRYPTED-SEED-SHOULD-NEVER-LEAK";

function ctx(role: string, workspaceId = WS) {
  return { userId: "u1", workspaceId, workspace: { id: workspaceId }, role };
}

function input(overrides: Record<string, unknown> = {}) {
  return {
    name: "Oktabr sovg'asi",
    instagramAccountId: "acc1",
    mediaId: "media_1",
    windowStart: new Date(Date.now() - HOUR),
    windowEnd: new Date(Date.now() + 48 * HOUR),
    winnersCount: 2,
    backupCount: 1,
    ...overrides,
  } as Parameters<typeof createGiveaway>[1];
}

function seedGiveaway(overrides: Row = {}): Row {
  return db.seed("giveaway", {
    id: "gw1",
    workspaceId: WS,
    instagramAccountId: "acc1",
    name: "G",
    description: null,
    mediaId: "media_1",
    mediaMeta: null,
    rules: {},
    windowStart: new Date(Date.now() - HOUR),
    windowEnd: new Date(Date.now() + HOUR),
    status: "DRAFT",
    winnersCount: 1,
    backupCount: 0,
    seedCommitment: null,
    seedEncrypted: null,
    committedAt: null,
    confirmCampaignId: null,
    backfillStatus: null,
    backfillScanned: 0,
    backfillError: null,
    entriesCount: 0,
    eligibleCount: 0,
    createdByUserId: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

function seedEntry(n: number, overrides: Row = {}): Row {
  return db.seed("giveawayEntry", {
    id: `e${n}`,
    giveawayId: "gw1",
    workspaceId: WS,
    igUserId: `ig${n}`,
    username: `user${n}`,
    contactId: null,
    firstCommentId: `c${n}`,
    firstCommentText: `komment ${n}`,
    firstCommentAt: new Date(Date.UTC(2026, 9, 1, 10, n)),
    commentCount: 1,
    sourceEventIds: [],
    taggedUsernames: [],
    followResult: "NOT_CHECKED",
    checks: {},
    status: "ELIGIBLE",
    ineligibleReason: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  });
}

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  mocks.developerSession.mockResolvedValue({ email: "dev@example.com" });
  mocks.workspaceContext.mockResolvedValue(ctx("OWNER"));
  db.seed("workspace", { id: WS, name: "Test", ownerId: "u1", isSuspended: false });
  db.seed("workspace", { id: "ws2", name: "Other", ownerId: "u2", isSuspended: false });
  db.seed("instagramAccount", { id: "acc1", workspaceId: WS, instagramId: "178", username: "shop", accessToken: "enc", tokenStatus: "ACTIVE" });
  db.seed("instagramAccount", { id: "acc2", workspaceId: WS, instagramId: "179", username: "shop2", accessToken: "enc", tokenStatus: "ACTIVE" });
  db.seed("instagramAccount", { id: "foreign", workspaceId: "ws2", instagramId: "180", username: "other", accessToken: "enc", tokenStatus: "ACTIVE" });
});

describe("requireEngagement (permission matrix)", () => {
  async function status(role: string, access: EngagementAccess) {
    mocks.workspaceContext.mockResolvedValue(ctx(role));
    const auth = await requireEngagement(access);
    return auth.ok ? 200 : auth.response.status;
  }

  it("answers 401 without an app session, whatever the developer login says", async () => {
    mocks.developerSession.mockResolvedValueOnce(null);
    expect(await status("OWNER", "read")).toBe(200);
    mocks.workspaceContext.mockResolvedValueOnce(null);
    const auth = await requireEngagement("read");
    expect(auth.ok ? 200 : auth.response.status).toBe(401);
  });

  it("VIEWER reads but is refused every write and the export", async () => {
    expect(await status("VIEWER", "read")).toBe(200);
    expect(await status("VIEWER", "config")).toBe(403);
    expect(await status("VIEWER", "winners")).toBe(403);
    expect(await status("VIEWER", "export")).toBe(403);
  });

  it("OPERATOR reads only: it cannot configure, draw, confirm, notify or export", async () => {
    expect(await status("OPERATOR", "read")).toBe(200);
    expect(await status("MEMBER", "read")).toBe(200);
    expect(await status("OPERATOR", "config")).toBe(403);
    expect(await status("OPERATOR", "winners")).toBe(403);
    expect(await status("OPERATOR", "export")).toBe(403);
  });

  it("MANAGER, ADMIN and OWNER may do everything; an unknown role is a VIEWER", async () => {
    for (const role of ["MANAGER", "ADMIN", "OWNER"]) {
      for (const access of ["read", "config", "winners", "export"] as const) expect(await status(role, access)).toBe(200);
    }
    expect(await status("SOMETHING", "config")).toBe(403);
    expect(await status("SOMETHING", "read")).toBe(200);
  });
});

describe("createGiveaway", () => {
  it("creates a DRAFT with zeroed counters and the default rules", async () => {
    const created = await createGiveaway(WS, input(), "u1");
    expect(created.status).toBe("DRAFT");
    expect(created.entriesCount).toBe(0);
    expect(created.eligibleCount).toBe(0);
    expect(created.createdByUserId).toBe("u1");
    expect((created.rules as { comment: { required: boolean } }).comment.required).toBe(true);
    expect(rows("giveaway")).toHaveLength(1);
  });

  it("refuses an account of another workspace or a missing one (404)", async () => {
    await expect(createGiveaway(WS, input({ instagramAccountId: "foreign" }))).rejects.toMatchObject({ status: 404 });
    await expect(createGiveaway(WS, input({ instagramAccountId: "nope" }))).rejects.toMatchObject({ status: 404 });
    expect(rows("giveaway")).toHaveLength(0);
  });

  it("validates the media id, the window and the counts", async () => {
    expect(giveawayInputSchema.safeParse(input({ mediaId: "  " })).success).toBe(false);
    expect(giveawayInputSchema.safeParse(input({ winnersCount: 0 })).success).toBe(false);
    expect(giveawayInputSchema.safeParse(input({ winnersCount: 51 })).success).toBe(false);
    expect(giveawayInputSchema.safeParse(input({ backupCount: 21 })).success).toBe(false);
    expect(giveawayInputSchema.safeParse(input({ backupCount: -1 })).success).toBe(false);

    const start = new Date(Date.now() + HOUR);
    await expect(createGiveaway(WS, input({ windowStart: start, windowEnd: start }))).rejects.toMatchObject({ status: 422 });
    await expect(createGiveaway(WS, input({ windowStart: start, windowEnd: new Date(start.getTime() - HOUR) }))).rejects.toMatchObject({ status: 422 });
    await expect(createGiveaway(WS, input({ windowStart: start, windowEnd: new Date(start.getTime() + 91 * 24 * HOUR) }))).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("90"),
    });
    await expect(createGiveaway(WS, input({ windowStart: new Date(Date.now() - 3 * HOUR), windowEnd: new Date(Date.now() - HOUR) }))).rejects.toMatchObject({ status: 422 });
    expect((await createGiveaway(WS, input({ windowStart: start, windowEnd: new Date(start.getTime() + 90 * 24 * HOUR) }))).status).toBe("DRAFT");
  });

  it("rejects broken rules with an Uzbek 422", async () => {
    await expect(createGiveaway(WS, input({ rules: { tagFriends: { required: true, min: 99 } } }))).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("Qoidalar noto'g'ri"),
    });
    await expect(createGiveaway(WS, input({ rules: { comment: { mode: "SOMETIMES" } } }))).rejects.toMatchObject({ status: 422 });
  });

  it("accepts only a COMMENT campaign of the same account and workspace as confirmation", async () => {
    db.seed("triggerCampaign", { id: "camp_ok", workspaceId: WS, instagramAccountId: "acc1", triggerType: "COMMENT", name: "Izoh", active: true });
    db.seed("triggerCampaign", { id: "camp_story", workspaceId: WS, instagramAccountId: "acc1", triggerType: "STORY_REPLY", name: "Story", active: true });
    db.seed("triggerCampaign", { id: "camp_acc2", workspaceId: WS, instagramAccountId: "acc2", triggerType: "COMMENT", name: "Boshqa", active: true });
    db.seed("triggerCampaign", { id: "camp_foreign", workspaceId: "ws2", instagramAccountId: "foreign", triggerType: "COMMENT", name: "Begona", active: true });

    expect((await createGiveaway(WS, input({ confirmCampaignId: "camp_ok" }))).confirmCampaignId).toBe("camp_ok");
    await expect(createGiveaway(WS, input({ confirmCampaignId: "camp_story" }))).rejects.toMatchObject({ status: 422 });
    await expect(createGiveaway(WS, input({ confirmCampaignId: "camp_acc2" }))).rejects.toMatchObject({ status: 422 });
    await expect(createGiveaway(WS, input({ confirmCampaignId: "camp_foreign" }))).rejects.toMatchObject({ status: 404 });
    await expect(createGiveaway(WS, input({ confirmCampaignId: "missing" }))).rejects.toMatchObject({ status: 404 });
  });
});

describe("updateGiveaway / deleteGiveaway (DRAFT only)", () => {
  it("edits a DRAFT, re-validating the merged result", async () => {
    const created = await createGiveaway(WS, input());
    const updated = await updateGiveaway(WS, created.id, { name: "Yangi nom", winnersCount: 3 });
    expect(updated.name).toBe("Yangi nom");
    expect(updated.winnersCount).toBe(3);
    expect(updated.mediaId).toBe("media_1");
    await expect(updateGiveaway(WS, created.id, { instagramAccountId: "foreign" })).rejects.toMatchObject({ status: 404 });
    await expect(updateGiveaway(WS, created.id, { winnersCount: 80 })).rejects.toMatchObject({ status: 422 });
    await expect(updateGiveaway(WS, created.id, { windowEnd: new Date(Date.now() - 5 * HOUR) })).rejects.toMatchObject({ status: 422 });
  });

  it("refuses to edit or delete once the giveaway left DRAFT (409)", async () => {
    for (const status of ["ACTIVE", "CLOSED", "DRAWN", "ARCHIVED"]) {
      seedGiveaway({ id: `gw_${status}`, status });
      await expect(updateGiveaway(WS, `gw_${status}`, { name: "x" })).rejects.toMatchObject({ status: 409 });
      await expect(deleteGiveaway(WS, `gw_${status}`)).rejects.toMatchObject({ status: 409 });
    }
    expect(rows("giveaway")).toHaveLength(4);
  });

  it("deletes a DRAFT", async () => {
    const created = await createGiveaway(WS, input());
    expect(await deleteGiveaway(WS, created.id)).toEqual({ deleted: true });
    expect(rows("giveaway")).toHaveLength(0);
  });
});

describe("scoping", () => {
  it("another workspace's giveaway, entries and entry ids read as 404", async () => {
    seedGiveaway();
    seedEntry(1);
    await expect(getGiveaway("ws2", "gw1")).rejects.toMatchObject({ status: 404 });
    await expect(getGiveawayDetail("ws2", "gw1")).rejects.toMatchObject({ status: 404 });
    await expect(listEntries("ws2", "gw1")).rejects.toMatchObject({ status: 404 });
    await expect(updateGiveaway("ws2", "gw1", { name: "x" })).rejects.toMatchObject({ status: 404 });
    await expect(deleteGiveaway("ws2", "gw1")).rejects.toMatchObject({ status: 404 });
    await expect(requireEntry("ws2", "gw1", "e1")).rejects.toMatchObject({ status: 404 });
    await expect(requireEntry(WS, "gw1", "missing")).rejects.toMatchObject({ status: 404 });
    expect((await requireEntry(WS, "gw1", "e1")).id).toBe("e1");
    expect(await listGiveaways("ws2")).toEqual([]);
  });

  it("run() maps a service error to { ok: false, status, error }", async () => {
    const result = await run(() => getGiveaway(WS, "nope"));
    expect(result).toEqual({ ok: false, status: 404, error: "Giveaway topilmadi" });
  });
});

describe("listGiveaways / listEntries", () => {
  it("lists with entry / eligible / pending counters and the account username", async () => {
    seedGiveaway({ entriesCount: 3, eligibleCount: 2 });
    seedEntry(1);
    seedEntry(2);
    seedEntry(3, { status: "PENDING_CHECK" });
    const [row] = await listGiveaways(WS);
    expect(row).toMatchObject({ id: "gw1", entriesCount: 3, eligibleCount: 2, pendingCount: 1, accountUsername: "shop" });
    expect(await listGiveaways(WS, { status: "ACTIVE" })).toHaveLength(0);
  });

  it("pages entries newest first with a cursor and filters by status and text", async () => {
    seedGiveaway();
    for (let n = 1; n <= 5; n++) seedEntry(n, n === 4 ? { status: "PENDING_CHECK", username: "maria_k" } : {});
    const first = await listEntries(WS, "gw1", { limit: 2 });
    expect(first.entries.map((e) => e.id)).toEqual(["e5", "e4"]);
    expect(first.nextCursor).toBe("e4");
    const second = await listEntries(WS, "gw1", { limit: 2, cursor: first.nextCursor ?? undefined });
    expect(second.entries.map((e) => e.id)).toEqual(["e3", "e2"]);
    const last = await listEntries(WS, "gw1", { limit: 2, cursor: second.nextCursor ?? undefined });
    expect(last.entries.map((e) => e.id)).toEqual(["e1"]);
    expect(last.nextCursor).toBeNull();

    expect((await listEntries(WS, "gw1", { status: "PENDING_CHECK" })).entries.map((e) => e.id)).toEqual(["e4"]);
    expect((await listEntries(WS, "gw1", { q: "@MARIA" })).entries.map((e) => e.id)).toEqual(["e4"]);
    expect((await listEntries(WS, "gw1", { q: "komment 2" })).entries.map((e) => e.id)).toEqual(["e2"]);
  });

  it("the entries query schema bounds the limit and rejects unknown statuses", () => {
    expect(entriesQuerySchema.parse({}).limit).toBe(50);
    expect(entriesQuerySchema.safeParse({ limit: "500" }).success).toBe(false);
    expect(entriesQuerySchema.safeParse({ status: "BANANA" }).success).toBe(false);
  });
});

describe("the encrypted seed never leaves", () => {
  it("is absent from the giveaway, the list, the detail and the deep strip", async () => {
    seedGiveaway({ status: "CLOSED", seedCommitment: "a".repeat(64), seedEncrypted: SECRET_SEED, committedAt: new Date() });
    seedEntry(1);
    const detail = await getGiveawayDetail(WS, "gw1");
    const list = await listGiveaways(WS);
    const single = await getGiveaway(WS, "gw1");
    for (const payload of [detail, list, single]) expect(JSON.stringify(payload)).not.toContain(SECRET_SEED);
    expect(detail.giveaway.seedCommitment).toBe("a".repeat(64));

    const nested = { giveaway: { id: "x", seedEncrypted: SECRET_SEED }, list: [{ seedEncrypted: SECRET_SEED, ok: 1 }], when: new Date(0) };
    const stripped = stripSeeds(nested);
    expect(JSON.stringify(stripped)).not.toContain(SECRET_SEED);
    expect(stripped.when).toBeInstanceOf(Date);
    expect(stripped.list[0]).toEqual({ ok: 1 });
  });

  it("shows the revealed seed only through draws", async () => {
    seedGiveaway({ status: "DRAWN", seedCommitment: "b".repeat(64), seedEncrypted: SECRET_SEED });
    seedEntry(1);
    db.seed("giveawayDraw", {
      id: "d1",
      giveawayId: "gw1",
      workspaceId: WS,
      sequence: 1,
      algorithm: "hmac-sha256-fisher-yates/v1",
      seedCommitment: "b".repeat(64),
      seedRevealed: "c".repeat(64),
      entrantsHash: "h",
      entrantsCount: 1,
      winnersCount: 1,
      winnerEntryIds: ["e1"],
      backupEntryIds: [],
      verification: "line",
      status: "DRAWN",
      drawnAt: new Date(),
    });
    const detail = await getGiveawayDetail(WS, "gw1");
    expect(detail.draws[0].seedRevealed).toBe("c".repeat(64));
    expect(detail.draws[0].winners[0]).toMatchObject({ id: "e1", username: "user1" });
    expect(JSON.stringify(detail)).not.toContain(SECRET_SEED);
  });
});

describe("POST /verify (pure)", () => {
  function post(body: unknown) {
    return verifyRoute(new NextRequest("http://localhost/api/engagement/verify", { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body) }));
  }

  const entrants = Array.from({ length: 12 }, (_, i) => `ig${100 + i}`);
  const { seedHex, commitment } = createCommitment();
  const drawn = drawWinners({ seedHex, entrants: entrants.map((id) => ({ id, igUserId: id })), winners: 2, backups: 1 });

  it("confirms a genuine draw", async () => {
    const res = await post({ seedHex, commitment, entrants, winners: drawn.winnerIds, backups: drawn.backupIds });
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.data.ok).toBe(true);
    expect(json.data.winners).toEqual(drawn.winnerIds);
  });

  it("flags a tampered winner list or a wrong commitment (still 200, ok false)", async () => {
    const fake = [...drawn.winnerIds].reverse();
    const tampered = await (await post({ seedHex, commitment, entrants, winners: fake })).json();
    expect(tampered.data.ok).toBe(false);
    expect(tampered.data.problems.length).toBeGreaterThan(0);
    const wrongCommit = await (await post({ seedHex, commitment: "0".repeat(64), entrants, winners: drawn.winnerIds })).json();
    expect(wrongCommit.data.ok).toBe(false);
  });

  it("answers 400 for malformed JSON and for a bad seed", async () => {
    expect((await post("not json")).status).toBe(400);
    expect((await post({ seedHex: "xyz", entrants, winners: ["a"] })).status).toBe(400);
    expect(verifyBodySchema.safeParse({ seedHex, entrants: [], winners: [] }).success).toBe(true);
  });

  it("needs the app session (401) but no write permission", async () => {
    mocks.workspaceContext.mockResolvedValue(ctx("VIEWER"));
    expect((await post({ seedHex, commitment, entrants, winners: drawn.winnerIds })).status).toBe(200);
    mocks.workspaceContext.mockResolvedValueOnce(null);
    expect((await post({ seedHex, commitment, entrants, winners: drawn.winnerIds })).status).toBe(401);
  });
});
