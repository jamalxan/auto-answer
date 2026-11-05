/**
 * Network-only posts (2026-11-05): a post can go to Facebook / Threads /
 * YouTube / Telegram without an Instagram account. It is SCHEDULED without
 * Instagram jobs, the cross-post sweep publishes its targets, and
 * settleNetworkOnlyPosts gives it the final status.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  schedulePrepare: vi.fn(async () => undefined),
  schedulePublish: vi.fn(async () => undefined),
  scheduleManualNotify: vi.fn(async () => undefined),
  removePostJobs: vi.fn(async () => undefined),
  accountQuota: vi.fn(async () => ({ used: 0, total: 50, scheduledNext24h: 0, resetsAt: null, source: "cache" as const })),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/content/queue", () => ({
  schedulePrepare: mocks.schedulePrepare,
  schedulePublish: mocks.schedulePublish,
  scheduleManualNotify: mocks.scheduleManualNotify,
  removePostJobs: mocks.removePostJobs,
  enqueueMediaProcess: vi.fn(),
}));
vi.mock("@/lib/content/quota", () => ({
  accountQuota: mocks.accountQuota,
  quotaWindowFull: () => false,
}));
vi.mock("@/lib/content/storage", () => ({
  getStorage: () => ({ presignGet: async (key: string) => `https://b/${key}`, headObject: async () => null, deleteObject: async () => undefined }),
  mediaKey: () => "k",
}));

import { createPost, listPosts, schedulePost } from "@/lib/content/service";
import { settleNetworkOnlyPosts } from "@/lib/channels/crosspost";

const WS = "ws1";
const NOW = new Date("2026-11-05T10:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

beforeEach(() => {
  resetDb();
  for (const m of Object.values(mocks)) m.mockClear();
  db.seed("workspace", { id: WS, name: "W", ownerId: "u1", timezone: "Asia/Tashkent" });
  db.seed("instagramAccount", { id: "acc1", workspaceId: WS, instagramId: "ig1", username: "shop", accessToken: "t", tokenStatus: "ACTIVE", canPublish: true });
  db.seed("mediaAsset", {
    id: "m1", workspaceId: WS, kind: "IMAGE", originalKey: "k/m1", preparedKey: "k/m1.p", thumbKey: "k/m1.t", mimeType: "image/jpeg",
    sizeBytes: 1000, width: 1080, height: 1350, durationMs: null, status: "READY",
  });
});

const networkDraft = (over: Record<string, unknown> = {}) =>
  createPost(WS, "u1", { instagramAccountId: null, type: "FEED_IMAGE", caption: "Salom", media: [{ mediaId: "m1" }], ...over } as never);

function seedTarget(postId: string, channel: string, status = "PENDING", extra: Record<string, unknown> = {}) {
  return db.seed("channelPostTarget", { id: `${postId}-${channel}-${status}`, workspaceId: WS, postId, channel, accountRef: `${channel}-acc`, status, ...extra });
}

describe("network-only post: create and schedule", () => {
  it("is created as a DRAFT with no Instagram account", async () => {
    const p = await networkDraft();
    expect(p.status).toBe("DRAFT");
    expect(p.instagramAccountId).toBeNull();
  });

  it("refuses to schedule with no network chosen (instead of sitting in the plan forever)", async () => {
    const p = await networkDraft();
    await expect(schedulePost(WS, p.id, at(60), { now: NOW })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("tarmoq") });
  });

  it("schedules at the chosen time with no Instagram jobs once a target exists", async () => {
    const p = await networkDraft();
    seedTarget(p.id, "facebook");
    const s = await schedulePost(WS, p.id, at(60), { now: NOW });
    expect(s.status).toBe("SCHEDULED");
    expect(new Date(s.scheduledAt!).getTime()).toBe(at(60).getTime());
    expect(mocks.schedulePrepare).not.toHaveBeenCalled();
    expect(mocks.schedulePublish).not.toHaveBeenCalled();
    expect(mocks.accountQuota).not.toHaveBeenCalled();
  });

  it("refuses a Story without Instagram", async () => {
    const p = await networkDraft({ type: "STORY", caption: undefined });
    seedTarget(p.id, "facebook");
    await expect(schedulePost(WS, p.id, at(60), { now: NOW })).rejects.toMatchObject({ status: 400, message: expect.stringContaining("Story") });
  });

  it("a retry re-sends the targets that failed", async () => {
    const p = await networkDraft();
    seedTarget(p.id, "threads", "FAILED", { lastError: "x", attempts: 3 });
    await (db.client() as never as { scheduledPost: { update: (a: unknown) => Promise<unknown> } }).scheduledPost.update({ where: { id: p.id }, data: { status: "FAILED" } });
    await schedulePost(WS, p.id, at(30), { now: NOW });
    expect(db.rows("channelPostTarget")[0]).toMatchObject({ status: "PENDING", attempts: 0, lastError: null });
  });
});

describe("listPosts: network filter and the networks of each card", () => {
  it("filters by network and lists every network a post goes to", async () => {
    const ig = await createPost(WS, "u1", { instagramAccountId: "acc1", type: "FEED_IMAGE", caption: "IG", media: [{ mediaId: "m1" }] } as never);
    seedTarget(ig.id, "threads");
    const fb = await networkDraft();
    seedTarget(fb.id, "facebook");

    const all = await listPosts(WS, { page: 1, pageSize: 50 } as never);
    expect(all.items.find((i) => i.id === ig.id)?.networks.sort()).toEqual(["instagram", "threads"]);
    expect(all.items.find((i) => i.id === fb.id)?.networks).toEqual(["facebook"]);

    expect((await listPosts(WS, { page: 1, pageSize: 50, network: "instagram" } as never)).items.map((i) => i.id)).toEqual([ig.id]);
    expect((await listPosts(WS, { page: 1, pageSize: 50, network: "facebook" } as never)).items.map((i) => i.id)).toEqual([fb.id]);
  });
});

describe("settleNetworkOnlyPosts", () => {
  function seedScheduled(id: string) {
    return db.seed("scheduledPost", { id, workspaceId: WS, instagramAccountId: null, type: "FEED_IMAGE", status: "SCHEDULED", scheduledAt: at(-5), timezone: "Asia/Tashkent", version: 1, attempts: 1 });
  }

  it("PUBLISHED once every target is done and one went out; a partial failure is noted", async () => {
    seedScheduled("p1");
    seedTarget("p1", "facebook", "PUBLISHED", { publishedAt: at(-4) });
    seedTarget("p1", "threads", "FAILED", { lastError: "Threads rad etdi" });
    expect(await settleNetworkOnlyPosts(NOW)).toBe(1);
    expect(db.rows("scheduledPost")[0]).toMatchObject({ status: "PUBLISHED", lastErrorMessage: expect.stringContaining("Ba'zi") });
  });

  it("FAILED with the first reason when no network took it", async () => {
    seedScheduled("p2");
    seedTarget("p2", "youtube", "FAILED", { lastError: "YouTube limiti" });
    await settleNetworkOnlyPosts(NOW);
    expect(db.rows("scheduledPost")[0]).toMatchObject({ status: "FAILED", lastErrorCode: "NETWORK_ALL_FAILED", lastErrorMessage: "YouTube limiti" });
  });

  it("waits while a target is still pending, and leaves Instagram posts alone", async () => {
    seedScheduled("p3");
    seedTarget("p3", "facebook", "PENDING");
    db.seed("scheduledPost", { id: "ig", workspaceId: WS, instagramAccountId: "acc1", type: "FEED_IMAGE", status: "SCHEDULED", scheduledAt: at(-5), timezone: "Asia/Tashkent", version: 1, attempts: 1 });
    expect(await settleNetworkOnlyPosts(NOW)).toBe(0);
    expect(db.rows("scheduledPost").map((r) => r.status)).toEqual(["SCHEDULED", "SCHEDULED"]);
  });
});
