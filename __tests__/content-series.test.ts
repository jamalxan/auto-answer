/**
 * ETAP 13 Faza 2 — story series (FR-C9, AC-4), recurrence copies (FR-S8)
 * and posting slots (FR-S9) on the in-memory DB.
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

import { createPost, getPost, listPosts, pausePost, schedulePost, unschedulePost, updatePost, validateDraft } from "@/lib/content/service";
import { applyToSeries, deleteSeriesFuture, recurPost } from "@/lib/content/series";
import { nextFreeSlot, queuePost, replaceSlots, slotInstants } from "@/lib/content/slots";

const WS = "ws1";
const NOW = new Date("2026-10-24T10:00:00Z"); // Saturday, 15:00 Tashkent
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

function seedMedia(id: string, kind: "IMAGE" | "VIDEO" = "IMAGE") {
  return db.seed("mediaAsset", {
    id, workspaceId: WS, kind, originalKey: `k/${id}`, preparedKey: `k/${id}.p`, thumbKey: `k/${id}.t`, mimeType: kind === "IMAGE" ? "image/jpeg" : "video/mp4",
    sizeBytes: 1000, width: 1080, height: kind === "IMAGE" ? 1350 : 1920, durationMs: kind === "VIDEO" ? 20_000 : null, status: "READY",
  });
}

beforeEach(() => {
  resetDb();
  vi.useRealTimers();
  for (const m of Object.values(mocks)) m.mockClear();
  db.seed("workspace", { id: WS, name: "W", ownerId: "u1", timezone: "Asia/Tashkent" });
  db.seed("instagramAccount", { id: "acc1", workspaceId: WS, instagramId: "ig1", username: "jamalxann", accessToken: "t", tokenStatus: "ACTIVE", canPublish: true });
  db.seed("instagramAccount", { id: "acc9", workspaceId: "other", instagramId: "ig9", username: "foreign", accessToken: "t", tokenStatus: "ACTIVE", canPublish: true });
  seedMedia("m1");
  seedMedia("m2");
  seedMedia("v3", "VIDEO");
});

const storyDraft = () => createPost(WS, "u1", { instagramAccountId: "acc1", type: "STORY", media: [{ mediaId: "m1" }, { mediaId: "m2" }, { mediaId: "v3" }] });
const feedDraft = () => createPost(WS, "u1", { instagramAccountId: "acc1", type: "FEED_IMAGE", caption: "Salom", media: [{ mediaId: "m1" }] });
const livePosts = () => db.rows("scheduledPost").filter((r) => !r.deletedAt);

describe("story series (FR-C9, AC-4)", () => {
  it("a multi-media STORY draft is valid; one with more than the series max is not", async () => {
    const p = await storyDraft();
    expect(p.issues).toEqual([]);
    expect(await validateDraft(WS, { instagramAccountId: "acc1", type: "STORY", media: [{ mediaId: "m1" }, { mediaId: "m2" }] })).toEqual([]);
    const ids = Array.from({ length: 11 }, (_, i) => `x${i}`);
    ids.forEach((id) => seedMedia(id));
    const issues = await validateDraft(WS, { instagramAccountId: "acc1", type: "STORY", media: ids.map((mediaId) => ({ mediaId })) });
    expect(issues.map((i) => i.message).join()).toMatch(/seriyasida 1 dan 10/);
  });

  it("scheduling splits it into 3 one-media posts, one minute apart, each with its own jobs", async () => {
    const p = await storyDraft();
    const done = await schedulePost(WS, p.id, at(60), { now: NOW });
    const rows = livePosts().sort((a, b) => (a.seriesIndex as number) - (b.seriesIndex as number));
    expect(rows).toHaveLength(3);
    expect(new Set(rows.map((r) => r.seriesId)).size).toBe(1);
    expect(rows[0].id).toBe(p.id);
    expect(rows.map((r) => r.seriesIndex)).toEqual([0, 1, 2]);
    expect(rows.map((r) => r.status)).toEqual(["SCHEDULED", "SCHEDULED", "SCHEDULED"]);
    expect(rows.map((r) => (r.scheduledAt as Date).toISOString())).toEqual([at(60), at(61), at(62)].map((d) => d.toISOString()));
    for (const r of rows) expect(db.rows("scheduledPostMedia").filter((m) => m.postId === r.id)).toHaveLength(1);
    expect(db.rows("scheduledPostMedia").filter((m) => m.postId === rows[2].id)[0].mediaId).toBe("v3");
    expect(mocks.schedulePublish).toHaveBeenCalledTimes(3);
    expect(mocks.schedulePrepare).toHaveBeenCalledTimes(3);
    expect(done.series).toMatchObject({ position: 1, total: 3 });
    expect(done.media).toHaveLength(1);
  });

  it("refuses the whole series when the 24-hour quota cannot hold every story", async () => {
    mocks.accountQuota.mockResolvedValueOnce({ used: 48, total: 50, scheduledNext24h: 0, resetsAt: null, source: "cache" });
    const p = await storyDraft();
    await expect(schedulePost(WS, p.id, at(60), { now: NOW })).rejects.toMatchObject({ status: 409 });
    expect(livePosts()).toHaveLength(1);
    expect(db.rows("scheduledPostMedia")).toHaveLength(3);
  });

  it("refuses before splitting when the time is too close", async () => {
    const p = await storyDraft();
    await expect(schedulePost(WS, p.id, at(2), { now: NOW })).rejects.toMatchObject({ status: 400 });
    expect(livePosts()).toHaveLength(1);
  });

  it("a later item moves past another post of the account but keeps the order", async () => {
    const other = await feedDraft();
    await schedulePost(WS, other.id, at(61), { now: NOW });
    const p = await storyDraft();
    await schedulePost(WS, p.id, at(60), { now: NOW });
    const series = livePosts().filter((r) => r.seriesId).sort((a, b) => (a.seriesIndex as number) - (b.seriesIndex as number));
    const times = series.map((r) => (r.scheduledAt as Date).getTime());
    expect(times[0]).toBe(at(60).getTime());
    expect(times[1]).toBe(at(63).getTime()); // 61 clashes → +2 min
    expect(times[2]).toBe(at(64).getTime());
  });

  it("actions apply to one item; the detail lists the series", async () => {
    const p = await storyDraft();
    await schedulePost(WS, p.id, at(60), { now: NOW });
    const second = livePosts().find((r) => r.seriesIndex === 1)!;
    await pausePost(WS, second.id as string);
    const third = livePosts().find((r) => r.seriesIndex === 2)!;
    await unschedulePost(WS, third.id as string);
    const d = await getPost(WS, second.id as string);
    expect(d.status).toBe("PAUSED");
    expect(d.series).toMatchObject({ position: 2, total: 3 });
    expect(d.series!.items.map((i) => i.status)).toEqual(["SCHEDULED", "PAUSED", "DRAFT"]);
    expect((await getPost(WS, p.id)).status).toBe("SCHEDULED");
  });

  it("a scheduled story item cannot be edited back to several media", async () => {
    const p = await storyDraft();
    const done = await schedulePost(WS, p.id, at(60), { now: NOW });
    await expect(updatePost(WS, p.id, { media: [{ mediaId: "m1" }, { mediaId: "m2" }], version: done.version })).rejects.toMatchObject({ status: 400 });
  });

  it("list cards carry the series marker", async () => {
    const p = await storyDraft();
    await schedulePost(WS, p.id, at(60), { now: NOW });
    const { items } = await listPosts(WS, { page: 1, pageSize: 50 });
    expect(items.every((c) => c.seriesId)).toBe(true);
    expect(items.map((c) => c.seriesIndex).sort()).toEqual([0, 1, 2]);
  });
});

describe("recurrence (FR-S8)", () => {
  const daily = { frequency: "daily" as const, startDate: "2026-10-25", time: "19:00", until: "2026-10-28" };

  it("turns a draft into 4 scheduled copies sharing a seriesId; the original is index 0", async () => {
    const p = await feedDraft();
    const report = await recurPost(WS, p.id, daily, { now: NOW });
    expect(report.total).toBe(4);
    expect(report.failed).toEqual([]);
    expect(report.scheduled[0].id).toBe(p.id);
    const rows = livePosts().sort((a, b) => (a.seriesIndex as number) - (b.seriesIndex as number));
    expect(rows).toHaveLength(4);
    expect(new Set(rows.map((r) => r.seriesId))).toEqual(new Set([report.seriesId]));
    expect(rows.map((r) => (r.scheduledAt as Date).toISOString())).toEqual(["2026-10-25T14:00:00.000Z", "2026-10-26T14:00:00.000Z", "2026-10-27T14:00:00.000Z", "2026-10-28T14:00:00.000Z"]);
    expect(rows.every((r) => r.caption === "Salom" && r.status === "SCHEDULED")).toBe(true);
  });

  it("reports a copy that cannot be scheduled instead of aborting the rest", async () => {
    mocks.accountQuota
      .mockResolvedValueOnce({ used: 3, total: 50, scheduledNext24h: 0, resetsAt: null, source: "cache" })
      .mockResolvedValueOnce({ used: 50, total: 50, scheduledNext24h: 0, resetsAt: null, source: "cache" });
    const p = await feedDraft();
    const report = await recurPost(WS, p.id, daily, { now: NOW });
    expect(report.scheduled).toHaveLength(3);
    expect(report.failed).toHaveLength(1);
    expect(report.failed[0]).toMatchObject({ seriesIndex: 1 });
    expect(report.failed[0].error).toMatch(/limit/);
    const failed = db.rows("scheduledPost").find((r) => r.id === report.failed[0].id)!;
    expect(failed.status).toBe("DRAFT");
    expect(failed.seriesId).toBe(report.seriesId);
  });

  it("refuses a non-draft, a multi-media story, an invalid rule and a first copy too soon", async () => {
    const p = await feedDraft();
    await expect(recurPost(WS, p.id, { ...daily, until: "2027-06-01" }, { now: NOW })).rejects.toMatchObject({ status: 400 });
    await expect(recurPost(WS, p.id, { ...daily, startDate: "2026-10-24", time: "15:02" }, { now: NOW })).rejects.toMatchObject({ status: 400 });
    const story = await storyDraft();
    await expect(recurPost(WS, story.id, daily, { now: NOW })).rejects.toMatchObject({ status: 400 });
    await schedulePost(WS, p.id, at(60), { now: NOW });
    await expect(recurPost(WS, p.id, daily, { now: NOW })).rejects.toMatchObject({ status: 409 });
    expect(livePosts().filter((r) => r.type === "FEED_IMAGE")).toHaveLength(1);
  });

  it("a foreign post is a 404", async () => {
    db.seed("scheduledPost", { id: "fx", workspaceId: "other", instagramAccountId: "acc9", type: "FEED_IMAGE", status: "DRAFT" });
    await expect(recurPost(WS, "fx", daily, { now: NOW })).rejects.toMatchObject({ status: 404 });
    await expect(deleteSeriesFuture(WS, "fx")).rejects.toMatchObject({ status: 404 });
  });

  it("delete-series-future removes the later copies only and leaves published ones", async () => {
    const p = await feedDraft();
    const report = await recurPost(WS, p.id, daily, { now: NOW });
    const third = report.scheduled.find((s) => s.seriesIndex === 3)!;
    db.rows("scheduledPost").find((r) => r.id === third.id)!.status = "PUBLISHED";
    const second = report.scheduled.find((s) => s.seriesIndex === 1)!;
    const out = await deleteSeriesFuture(WS, second.id);
    expect(out).toEqual({ deleted: 1, skipped: 1 });
    expect(livePosts().map((r) => r.seriesIndex).sort()).toEqual([0, 1, 3]);
    await expect(deleteSeriesFuture(WS, (await feedDraft()).id)).rejects.toMatchObject({ status: 400 });
  });

  it("apply-to-series copies the texts to the unscheduled copies only", async () => {
    mocks.accountQuota
      .mockResolvedValueOnce({ used: 3, total: 50, scheduledNext24h: 0, resetsAt: null, source: "cache" })
      .mockResolvedValueOnce({ used: 50, total: 50, scheduledNext24h: 0, resetsAt: null, source: "cache" });
    const p = await feedDraft();
    const report = await recurPost(WS, p.id, daily, { now: NOW });
    const draftCopy = report.failed[0].id;
    const fresh = await getPost(WS, p.id);
    await updatePost(WS, p.id, { caption: "Yangi matn", version: fresh.version });
    const out = await applyToSeries(WS, p.id);
    expect(out).toMatchObject({ updated: 1, skipped: 2 });
    expect((await getPost(WS, draftCopy)).caption).toBe("Yangi matn");
    expect((await getPost(WS, report.scheduled[1].id)).caption).toBe("Salom");
  });
});

describe("posting slots (FR-S9)", () => {
  // Monday 09:00 and Saturday 18:00 Tashkent; Saturday 16:00 for reels only.
  const SLOTS = [
    { weekday: 0, minuteOfDay: 9 * 60 },
    { weekday: 5, minuteOfDay: 18 * 60 },
    { weekday: 5, minuteOfDay: 16 * 60, postType: "REEL" as const },
  ];

  it("slotInstants walks the weekly set in the zone, skipping slots of another type", () => {
    const list = slotInstants(SLOTS, NOW, "Asia/Tashkent", { postType: "FEED_IMAGE", days: 7 });
    expect(list.map((d) => d.toISOString())).toEqual(["2026-10-24T13:00:00.000Z", "2026-10-26T04:00:00.000Z", "2026-10-31T13:00:00.000Z"]);
    const reels = slotInstants(SLOTS, NOW, "Asia/Tashkent", { postType: "REEL", days: 1 });
    expect(reels[0].toISOString()).toBe("2026-10-24T11:00:00.000Z");
  });

  it("replaceSlots replaces the set and drops duplicates; a foreign account is a 404", async () => {
    await replaceSlots(WS, "acc1", [{ weekday: 1, minuteOfDay: 600 }]);
    const out = await replaceSlots(WS, "acc1", [...SLOTS, { weekday: 0, minuteOfDay: 540 }]);
    expect(out.slots).toHaveLength(3);
    expect(db.rows("postingSlot")).toHaveLength(3);
    expect(out.timezone).toBe("Asia/Tashkent");
    await expect(replaceSlots(WS, "acc9", SLOTS)).rejects.toMatchObject({ status: 404 });
  });

  it("nextFreeSlot skips a slot taken by a queued post, not by a draft", async () => {
    await replaceSlots(WS, "acc1", SLOTS);
    const first = await nextFreeSlot("acc1", at(5), { timezone: "Asia/Tashkent", postType: "FEED_IMAGE" });
    expect(first?.toISOString()).toBe("2026-10-24T13:00:00.000Z");
    db.seed("scheduledPost", { workspaceId: WS, instagramAccountId: "acc1", type: "FEED_IMAGE", status: "DRAFT", scheduledAt: new Date("2026-10-24T13:00:00Z") });
    expect((await nextFreeSlot("acc1", at(5), { timezone: "Asia/Tashkent", postType: "FEED_IMAGE" }))?.toISOString()).toBe("2026-10-24T13:00:00.000Z");
    db.seed("scheduledPost", { workspaceId: WS, instagramAccountId: "acc1", type: "FEED_IMAGE", status: "SCHEDULED", scheduledAt: new Date("2026-10-24T13:00:30Z") });
    expect((await nextFreeSlot("acc1", at(5), { timezone: "Asia/Tashkent", postType: "FEED_IMAGE" }))?.toISOString()).toBe("2026-10-26T04:00:00.000Z");
  });

  it("queuePost schedules into the next free slot at least 5 minutes ahead", async () => {
    await replaceSlots(WS, "acc1", SLOTS);
    const a = await feedDraft();
    const b = await feedDraft();
    const qa = await queuePost(WS, a.id, { now: NOW });
    const qb = await queuePost(WS, b.id, { now: NOW });
    expect(qa.status).toBe("SCHEDULED");
    expect(qa.scheduledAt?.toISOString()).toBe("2026-10-24T13:00:00.000Z");
    expect(qb.scheduledAt?.toISOString()).toBe("2026-10-26T04:00:00.000Z");
    // 17:58 Tashkent: the 18:00 slot is less than 5 minutes away.
    const c = await feedDraft();
    const qc = await queuePost(WS, c.id, { now: new Date("2026-10-24T12:58:00Z") });
    expect(qc.scheduledAt?.toISOString()).toBe("2026-10-31T13:00:00.000Z");
  });

  it("queuePost without slots is a 409", async () => {
    const a = await feedDraft();
    await expect(queuePost(WS, a.id, { now: NOW })).rejects.toMatchObject({ status: 409 });
  });
});
