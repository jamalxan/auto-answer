/**
 * ETAP 13 — the post service: drafts, optimistic-locked edits, scheduling
 * with lead time / same-minute spacing / quota, pause-resume, delete,
 * duplicate, manual confirmation and tenant isolation (FR-S*, AC-13/14).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  schedulePrepare: vi.fn(async () => undefined),
  schedulePublish: vi.fn(async () => undefined),
  scheduleManualNotify: vi.fn(async () => undefined),
  removePostJobs: vi.fn(async () => undefined),
  accountQuota: vi.fn(async (): Promise<{ used: number; total: number; scheduledNext24h: number; resetsAt: Date | null; source: "api" | "cache" | "default" }> => ({ used: 3, total: 50, scheduledNext24h: 0, resetsAt: null, source: "cache" })),
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
  quotaWindowFull: (q: { used: number; total: number; scheduledNext24h: number }, extra = 1) => q.used + q.scheduledNext24h + extra > q.total,
}));
vi.mock("@/lib/content/storage", () => ({
  getStorage: () => ({ presignGet: async (key: string) => `https://b/${key}`, headObject: async () => null, deleteObject: async () => undefined }),
  mediaKey: () => "k",
}));

import {
  cancelPost,
  createPost,
  deletePost,
  duplicatePost,
  getPost,
  listPosts,
  markPublishedManually,
  pausePost,
  publishNow,
  resumePost,
  retryPost,
  schedulePost,
  unschedulePost,
  updatePost,
} from "@/lib/content/service";

const WS = "ws1";
const NOW = new Date("2026-10-24T10:00:00Z");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

function seedMedia(id: string, kind: "IMAGE" | "VIDEO" = "IMAGE", ws = WS) {
  return db.seed("mediaAsset", {
    id, workspaceId: ws, kind, originalKey: `k/${id}`, preparedKey: `k/${id}.p`, thumbKey: `k/${id}.t`, mimeType: kind === "IMAGE" ? "image/jpeg" : "video/mp4",
    sizeBytes: 1000, width: kind === "IMAGE" ? 1080 : 1080, height: kind === "IMAGE" ? 1350 : 1920, durationMs: kind === "VIDEO" ? 20_000 : null, status: "READY",
  });
}

beforeEach(() => {
  resetDb();
  for (const m of Object.values(mocks)) m.mockClear();
  db.seed("workspace", { id: WS, name: "W", ownerId: "u1", timezone: "Asia/Tashkent" });
  db.seed("instagramAccount", { id: "acc1", workspaceId: WS, instagramId: "ig1", username: "jamalxann", accessToken: "t", tokenStatus: "ACTIVE", canPublish: true });
  seedMedia("m1");
  seedMedia("v1", "VIDEO");
});

const draft = (over: Record<string, unknown> = {}) => createPost(WS, "u1", { instagramAccountId: "acc1", type: "FEED_IMAGE", caption: "Salom", media: [{ mediaId: "m1" }], ...over } as never);

describe("createPost", () => {
  it("stores a DRAFT with ordered media rows", async () => {
    seedMedia("m2");
    const p = await createPost(WS, "u1", { instagramAccountId: "acc1", type: "CAROUSEL", caption: "c", media: [{ mediaId: "m2", altText: "two" }, { mediaId: "m1" }] });
    expect(p.status).toBe("DRAFT");
    expect(p.media.map((m) => [m.mediaId, m.position])).toEqual([["m2", 0], ["m1", 1]]);
    expect(p.media[0].altText).toBe("two");
    expect(p.media[0].thumbUrl).toBe("https://b/k/m2.t");
    expect(p.version).toBe(1);
  });

  it("drops the caption of a story", async () => {
    const p = await createPost(WS, "u1", { instagramAccountId: "acc1", type: "STORY", caption: "ignored", media: [{ mediaId: "m1" }] });
    expect(p.caption).toBeNull();
  });

  it("refuses media of another workspace (404) and a foreign account", async () => {
    seedMedia("mx", "IMAGE", "other");
    await expect(draft({ media: [{ mediaId: "mx" }] })).rejects.toMatchObject({ status: 404 });
    await expect(draft({ instagramAccountId: "nope" })).rejects.toMatchObject({ status: 404 });
  });

  it("a draft may be incomplete, but a feed image with a video is refused outright", async () => {
    const empty = await createPost(WS, "u1", { instagramAccountId: "acc1", type: "FEED_IMAGE", media: [] });
    expect(empty.status).toBe("DRAFT");
    await expect(draft({ media: [{ mediaId: "v1" }] })).rejects.toMatchObject({ status: 400 });
  });
});

describe("updatePost", () => {
  it("bumps the version and rejects a stale one with 409", async () => {
    const p = await draft();
    const u = await updatePost(WS, p.id, { caption: "Yangi", version: 1 });
    expect(u.caption).toBe("Yangi");
    expect(u.version).toBe(2);
    await expect(updatePost(WS, p.id, { caption: "x", version: 1 })).rejects.toMatchObject({ status: 409 });
  });

  it("cannot edit a post that is being published", async () => {
    const p = await draft();
    db.rows("scheduledPost")[0].status = "PUBLISHING";
    await expect(updatePost(WS, p.id, { caption: "x", version: 1 })).rejects.toMatchObject({ status: 409 });
  });

  it("replaces the media set", async () => {
    seedMedia("m2");
    const p = await draft();
    const u = await updatePost(WS, p.id, { media: [{ mediaId: "m2" }], version: 1 });
    expect(u.media.map((m) => m.mediaId)).toEqual(["m2"]);
    expect(db.rows("scheduledPostMedia")).toHaveLength(1);
  });
});

describe("schedulePost", () => {
  it("needs five minutes of lead time", async () => {
    const p = await draft();
    await expect(schedulePost(WS, p.id, at(4), { now: NOW })).rejects.toMatchObject({ status: 400 });
  });

  it("refuses an invalid post with the field issues", async () => {
    const p = await draft({ caption: "x".repeat(2300) });
    const err = await schedulePost(WS, p.id, at(10), { now: NOW }).catch((e) => e);
    expect(err.status).toBe(400);
    expect(err.message).toMatch(/Caption/);
  });

  it("queues prepare 30 minutes ahead for an image and 60 for a reel, publish at the slot", async () => {
    const p = await draft();
    const s = await schedulePost(WS, p.id, at(120), { now: NOW });
    expect(s.status).toBe("SCHEDULED");
    expect(s.attempts).toBe(1);
    expect(mocks.schedulePrepare).toHaveBeenCalledWith(p.id, 1, at(90));
    expect(mocks.schedulePublish).toHaveBeenCalledWith(p.id, 1, at(120));

    const r = await createPost(WS, "u1", { instagramAccountId: "acc1", type: "REEL", caption: "r", media: [{ mediaId: "v1" }] });
    // a different slot, so the same-minute spacing rule does not move it
    await schedulePost(WS, r.id, at(240), { now: NOW });
    expect(mocks.schedulePrepare).toHaveBeenLastCalledWith(r.id, 1, at(180));
  });

  it("prepares right away when the slot is closer than the lead time", async () => {
    const p = await draft();
    await schedulePost(WS, p.id, at(10), { now: NOW });
    expect(mocks.schedulePrepare).toHaveBeenCalledWith(p.id, 1, NOW);
  });

  it("moves a second post of the same account two minutes later when it lands in the same minute", async () => {
    const a = await draft();
    await schedulePost(WS, a.id, at(60), { now: NOW });
    const b = await draft();
    const s = await schedulePost(WS, b.id, new Date(at(60).getTime() + 30_000), { now: NOW });
    expect(s.scheduledAt).toEqual(new Date(at(60).getTime() + 30_000 + 120_000));
  });

  it("refuses when the 24-hour quota is full", async () => {
    mocks.accountQuota.mockResolvedValueOnce({ used: 50, total: 50, scheduledNext24h: 0, resetsAt: null, source: "api" });
    const p = await draft();
    const err = await schedulePost(WS, p.id, at(60), { now: NOW }).catch((e) => e);
    expect(err.status).toBe(409);
    expect(err.code).toBe("PUBLISH_QUOTA");
  });

  it("manual posts only get the Telegram notice", async () => {
    const p = await draft({ autoPublish: false });
    await schedulePost(WS, p.id, at(60), { now: NOW });
    expect(mocks.scheduleManualNotify).toHaveBeenCalledWith(p.id, 1, at(60));
    expect(mocks.schedulePrepare).not.toHaveBeenCalled();
  });

  it("publishNow schedules one minute out", async () => {
    const p = await draft();
    const s = await publishNow(WS, p.id, { now: NOW });
    expect(s.status).toBe("SCHEDULED");
    expect(s.scheduledAt).toEqual(at(1));
    expect(mocks.schedulePublish).toHaveBeenCalledWith(p.id, 1, at(1));
  });
});

describe("pause / resume / unschedule / retry / cancel", () => {
  async function scheduled() {
    const p = await draft();
    return schedulePost(WS, p.id, at(120), { now: NOW });
  }

  it("pause removes the jobs, resume re-queues under a new attempt", async () => {
    const p = await scheduled();
    const paused = await pausePost(WS, p.id);
    expect(paused.status).toBe("PAUSED");
    expect(mocks.removePostJobs).toHaveBeenCalledWith(p.id, 1);
    const resumed = await resumePost(WS, p.id, { now: NOW });
    expect(resumed.status).toBe("SCHEDULED");
    expect(resumed.attempts).toBe(2);
    expect(mocks.schedulePublish).toHaveBeenLastCalledWith(p.id, 2, at(120));
  });

  it("resume refuses a slot that is already in the past", async () => {
    const p = await scheduled();
    await pausePost(WS, p.id);
    await expect(resumePost(WS, p.id, { now: at(200) })).rejects.toMatchObject({ status: 400 });
  });

  it("unschedule returns to DRAFT and clears the slot", async () => {
    const p = await scheduled();
    const d = await unschedulePost(WS, p.id);
    expect(d.status).toBe("DRAFT");
    expect(d.scheduledAt).toBeNull();
  });

  it("retry moves FAILED back to SCHEDULED no earlier than a minute from now", async () => {
    const p = await scheduled();
    db.rows("scheduledPost")[0].status = "FAILED";
    const r = await retryPost(WS, p.id, { now: at(300) });
    expect(r.status).toBe("SCHEDULED");
    expect(r.scheduledAt).toEqual(at(301));
    expect(r.attempts).toBe(2);
  });

  it("cancel pauses the linked campaign", async () => {
    db.seed("automation", { id: "au1", workspaceId: WS, instagramAccountId: "acc1", name: "N", keywords: ["x"], dmMessage: "d", isActive: true });
    const p = await draft({ linkCampaign: { automationId: "au1" } });
    await schedulePost(WS, p.id, at(120), { now: NOW });
    const c = await cancelPost(WS, p.id);
    expect(c.status).toBe("CANCELED");
    expect(db.rows("automation")[0].isActive).toBe(false);
  });
});

describe("delete / duplicate / manual / isolation", () => {
  it("soft-deletes, removes jobs and pauses the campaign", async () => {
    db.seed("automation", { id: "au1", workspaceId: WS, instagramAccountId: "acc1", name: "N", keywords: ["x"], dmMessage: "d", isActive: true });
    const p = await draft({ linkCampaign: { automationId: "au1" } });
    await schedulePost(WS, p.id, at(120), { now: NOW });
    await deletePost(WS, p.id);
    expect(db.rows("scheduledPost")[0].deletedAt).toBeInstanceOf(Date);
    expect(mocks.removePostJobs).toHaveBeenCalled();
    expect(db.rows("automation")[0].isActive).toBe(false);
    await expect(getPost(WS, p.id)).rejects.toMatchObject({ status: 404 });
  });

  it("duplicate makes a fresh DRAFT with the same media", async () => {
    const p = await draft({ caption: "orig" });
    const d = await duplicatePost(WS, p.id, {});
    expect(d.id).not.toBe(p.id);
    expect(d).toMatchObject({ status: "DRAFT", caption: "orig", scheduledAt: null });
    expect(d.media.map((m) => m.mediaId)).toEqual(["m1"]);
  });

  it("markPublishedManually only from NEEDS_MANUAL", async () => {
    const p = await draft();
    await schedulePost(WS, p.id, at(120), { now: NOW });
    await expect(markPublishedManually(WS, p.id)).rejects.toMatchObject({ status: 409 });
    db.rows("scheduledPost")[0].status = "NEEDS_MANUAL";
    const m = await markPublishedManually(WS, p.id);
    expect(m.status).toBe("PUBLISHED_MANUAL");
    expect(m.publishedAt).toBeInstanceOf(Date);
  });

  it("another workspace sees 404 everywhere", async () => {
    const p = await draft();
    await expect(getPost("other", p.id)).rejects.toMatchObject({ status: 404 });
    await expect(updatePost("other", p.id, { caption: "x", version: 1 })).rejects.toMatchObject({ status: 404 });
    await expect(schedulePost("other", p.id, at(60))).rejects.toMatchObject({ status: 404 });
    await expect(deletePost("other", p.id)).rejects.toMatchObject({ status: 404 });
  });

  it("listPosts filters by window, account and status", async () => {
    const a = await draft();
    await schedulePost(WS, a.id, at(60), { now: NOW });
    await draft();
    const all = await listPosts(WS, { page: 1, pageSize: 50 });
    expect(all.total).toBe(2);
    const scheduled = await listPosts(WS, { status: "SCHEDULED", page: 1, pageSize: 50 });
    expect(scheduled.items.map((i) => i.id)).toEqual([a.id]);
    expect(scheduled.items[0]).toMatchObject({ accountUsername: "jamalxann", thumbUrl: "https://b/k/m1.t", linked: false });
    const windowed = await listPosts(WS, { from: at(0), to: at(30), page: 1, pageSize: 50 });
    expect(windowed.total).toBe(0);
  });
});
