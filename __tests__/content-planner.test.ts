/**
 * Content planner in production (2026-10-26): the "Reja" timeline logic, the
 * upload queue's pure helpers, the batch status poll, the atomic quota
 * reservation under parallel uploads, and the stalled-processing sweep.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  enqueueMediaProcess: vi.fn(async () => undefined),
  hasLiveMediaJob: vi.fn(async (_id: string) => false),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/content/queue", () => ({ enqueueMediaProcess: mocks.enqueueMediaProcess, hasLiveMediaJob: mocks.hasLiveMediaJob }));
vi.mock("@/lib/content/storage", () => ({
  getStorage: () => ({
    presignPut: async (key: string) => ({ url: `https://bucket/${key}`, headers: {} }),
    presignGet: async (key: string) => `https://bucket/${key}?get=1`,
    headObject: async () => ({ size: 1000 }),
    deleteObject: async () => undefined,
  }),
  mediaKey: (ws: string, ext: string) => `ws/${ws}/2026/10/${Math.random().toString(36).slice(2)}.${ext}`,
}));

import { failStalledProcessing, mediaStatuses, presignUpload, STALLED_MESSAGE } from "@/lib/content/media";
import { buildTimeline, countsLabel, dayName, emptyRun, entryEnd, gapLabel, nowIndex, relativeTime } from "@/components/content/timeline";
import { precheckFile, queueSummary, releasable } from "@/components/content/upload-queue";
import type { PostCard } from "@/components/content/shared";

const WS = "ws1";
const TZ = "Asia/Tashkent";

function card(id: string, type: PostCard["type"], at: string | null, over: Partial<PostCard> = {}): PostCard {
  return { id, instagramAccountId: "a", accountUsername: "acc", type, status: "SCHEDULED", caption: null, scheduledAt: at, publishedAt: null, permalink: null, thumbUrl: null, mediaCount: 1, linked: false, autoPublish: true, lastErrorCode: null, version: 1, ...over };
}

describe("timeline", () => {
  it("groups by the workspace day, sorts by time and folds a story series", () => {
    const days = buildTimeline(
      [
        card("r", "REEL", "2026-10-26T14:00:00Z"), // 19:00 Tashkent
        card("s2", "STORY", "2026-10-26T15:01:00Z", { seriesId: "S", seriesIndex: 1 }),
        card("s1", "STORY", "2026-10-26T15:00:00Z", { seriesId: "S", seriesIndex: 0 }),
        card("late", "FEED_IMAGE", "2026-10-26T19:30:00Z"), // 00:30 next day in Tashkent
        card("draft", "FEED_IMAGE", null),
      ],
      TZ
    );
    expect(days.map((d) => d.date)).toEqual(["2026-10-26", "2026-10-27"]);
    const [first] = days;
    expect(first.entries.map((e) => e.kind)).toEqual(["post", "series"]);
    const series = first.entries[1];
    expect(series.kind === "series" && series.posts.map((p) => p.id)).toEqual(["s1", "s2"]);
    expect(series.time).toBe("20:00");
    expect(series.kind === "series" && series.endTime).toBe("20:01");
    expect(entryEnd(series)).toBe(Date.parse("2026-10-26T15:01:00Z"));
    expect(countsLabel(first.counts)).toBe("1 Reels · 2 Story");
  });

  it("a lone story or stories of different series stay separate", () => {
    const [day] = buildTimeline([card("a", "STORY", "2026-10-26T15:00:00Z", { seriesId: "A" }), card("b", "STORY", "2026-10-26T15:01:00Z", { seriesId: "B" })], TZ);
    expect(day.entries.map((e) => e.kind)).toEqual(["post", "post"]);
  });

  it("labels, gaps and the now line", () => {
    expect(dayName("2026-10-26", "2026-10-26")).toBe("Bugun");
    expect(dayName("2026-10-27", "2026-10-26")).toBe("Ertaga");
    expect(dayName("2026-10-25", "2026-10-26")).toBe("Kecha");
    expect(dayName("2026-10-29", "2026-10-26")).toBe("Payshanba");
    expect(gapLabel(0, 90 * 60_000)).toBeNull();
    expect(gapLabel(0, 3 * 3_600_000)).toBe("3 soat bo'sh");
    expect(gapLabel(0, 4 * 3_600_000 + 15 * 60_000)).toBe("4 soat 15 daqiqa bo'sh");
    expect(relativeTime(10 * 60_000, 0)).toBe("10 daqiqadan keyin");
    expect(relativeTime(0, 2 * 3_600_000)).toBe("2 soat oldin");
    expect(relativeTime(30_000, 0)).toBe("hozir");
    expect(emptyRun("2026-10-26", "2026-10-30")).toBe(3);
    const [day] = buildTimeline([card("a", "REEL", "2026-10-26T05:00:00Z"), card("b", "REEL", "2026-10-26T14:00:00Z")], TZ);
    expect(nowIndex(day.entries, Date.parse("2026-10-26T10:00:00Z"))).toBe(1);
    expect(nowIndex(day.entries, Date.parse("2026-10-26T20:00:00Z"))).toBe(2);
  });
});

describe("upload queue helpers", () => {
  it("refuses HEIC, unknown types and oversize files before sending anything", () => {
    expect(precheckFile({ name: "a.HEIC", type: "", size: 10 })).toMatch(/HEIC/);
    expect(precheckFile({ name: "a.gif", type: "image/gif", size: 10 })).toMatch(/turi/);
    expect(precheckFile({ name: "a.jpg", type: "image/jpeg", size: 31 * 1024 ** 2 })).toMatch(/30 MB/);
    expect(precheckFile({ name: "a.mp4", type: "video/mp4", size: 1024 ** 3 + 1 })).toMatch(/1 GB/);
    expect(precheckFile({ name: "a.mp4", type: "video/mp4", size: 500 * 1024 ** 2 })).toBeNull();
  });

  it("hands ready files over in pick order; failures do not hold the line", () => {
    const items = [
      { key: "a", batch: 1, index: 0, phase: "process" as const },
      { key: "b", batch: 1, index: 1, phase: "done" as const },
      { key: "c", batch: 2, index: 0, phase: "error" as const },
      { key: "d", batch: 2, index: 1, phase: "done" as const },
    ];
    expect(releasable(items, new Set())).toEqual(["d"]);
    items[0].phase = "done" as never;
    expect(releasable(items, new Set(["d"]))).toEqual(["a", "b"]);
  });

  it("summarises the queue with a byte-weighted percent", () => {
    const s = queueSummary([
      { phase: "done", pct: 100, size: 100 },
      { phase: "upload", pct: 50, size: 100 },
      { phase: "queued", pct: 0, size: 200 },
      { phase: "canceled", pct: 0, size: 999 },
    ]);
    expect(s).toMatchObject({ total: 3, done: 1, uploading: 1, queued: 1, pct: 38, active: true });
  });
});

describe("media service", () => {
  beforeEach(() => {
    resetDb();
    vi.unstubAllEnvs();
    mocks.hasLiveMediaJob.mockReset().mockResolvedValue(false);
    db.seed("workspace", { id: WS, name: "W", ownerId: "u1", mediaStorageBytes: 0 });
  });

  it("parallel presigns cannot overrun the quota together", async () => {
    vi.stubEnv("CONTENT_STORAGE_QUOTA_BYTES", "2500");
    const results = await Promise.allSettled(Array.from({ length: 5 }, (_, i) => presignUpload(WS, "u1", { fileName: `${i}.jpg`, mimeType: "image/jpeg", sizeBytes: 1000 })));
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(2);
    expect(results.filter((r) => r.status === "rejected").every((r) => (r as PromiseRejectedResult).reason.status === 413)).toBe(true);
    expect(Number(db.rows("workspace")[0].mediaStorageBytes)).toBe(2000);
    expect(db.rows("mediaAsset")).toHaveLength(2);
  });

  it("the batch status poll answers only this workspace's assets, thumbnails only when ready", async () => {
    db.seed("mediaAsset", { id: "m1", workspaceId: WS, kind: "IMAGE", originalKey: "k1", thumbKey: "k1.t", mimeType: "image/jpeg", sizeBytes: 1, status: "READY" });
    db.seed("mediaAsset", { id: "m2", workspaceId: WS, kind: "VIDEO", originalKey: "k2", thumbKey: null, mimeType: "video/mp4", sizeBytes: 1, status: "PROCESSING" });
    db.seed("mediaAsset", { id: "x", workspaceId: "other", kind: "IMAGE", originalKey: "k3", mimeType: "image/jpeg", sizeBytes: 1, status: "READY" });
    const rows = await mediaStatuses(WS, ["m1", "m2", "x", "m1"]);
    expect(rows.map((r) => r.id).sort()).toEqual(["m1", "m2"]);
    expect(rows.find((r) => r.id === "m1")!.thumbUrl).toBe("https://bucket/k1.t?get=1");
    expect(rows.find((r) => r.id === "m2")!.thumbUrl).toBeNull();
  });

  it("a PROCESSING row whose job is gone fails after 20 minutes; a queued one is left alone", async () => {
    const now = new Date("2026-10-26T12:00:00Z");
    const old = new Date(now.getTime() - 30 * 60_000);
    db.seed("mediaAsset", { id: "lost", workspaceId: WS, kind: "VIDEO", originalKey: "a", mimeType: "video/mp4", sizeBytes: 1, status: "PROCESSING", updatedAt: old });
    db.seed("mediaAsset", { id: "queued", workspaceId: WS, kind: "VIDEO", originalKey: "b", mimeType: "video/mp4", sizeBytes: 1, status: "PROCESSING", updatedAt: old });
    db.seed("mediaAsset", { id: "fresh", workspaceId: WS, kind: "VIDEO", originalKey: "c", mimeType: "video/mp4", sizeBytes: 1, status: "PROCESSING", updatedAt: now });
    mocks.hasLiveMediaJob.mockImplementation(async (id: string) => id === "queued");
    expect(await failStalledProcessing(now, true)).toBe(1);
    const status = (id: string) => db.rows("mediaAsset").find((r) => r.id === id)!;
    expect(status("lost")).toMatchObject({ status: "FAILED", error: STALLED_MESSAGE });
    expect(status("queued").status).toBe("PROCESSING");
    expect(status("fresh").status).toBe("PROCESSING");
    expect(await failStalledProcessing(now, false)).toBe(0);
  });
});
