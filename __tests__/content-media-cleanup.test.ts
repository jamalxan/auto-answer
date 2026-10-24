/**
 * ETAP 13 Faza 2 (WP-E) — spec §7 "Saqlash muddati": the sweeper drops the
 * prepared copy of media whose every live usage was published 30+ days ago,
 * releases its bytes, keeps the original; re-using such an asset prepares it again.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  enqueueMediaProcess: vi.fn(async () => undefined),
  head: vi.fn(async (_key: string): Promise<{ size: number } | null> => ({ size: 300 })),
  deleted: [] as string[],
  failDelete: false,
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/content/queue", () => ({ enqueueMediaProcess: mocks.enqueueMediaProcess }));
vi.mock("@/lib/content/storage", () => ({
  getStorage: () => ({
    headObject: mocks.head,
    deleteObject: async (key: string) => {
      if (mocks.failDelete) throw new Error("S3 down");
      mocks.deleted.push(key);
    },
  }),
  mediaKey: () => "k",
}));

import { cleanupPreparedCopies, reprepareCleanedMedia } from "@/lib/content/media";

const WS = "ws1";
const NOW = new Date("2026-11-30T10:00:00Z");
const daysAgo = (n: number) => new Date(NOW.getTime() - n * 24 * 3_600_000);

function asset(id: string, over: Record<string, unknown> = {}) {
  return db.seed("mediaAsset", { id, workspaceId: WS, kind: "IMAGE", status: "READY", originalKey: `o/${id}.png`, preparedKey: `o/${id}.prepared.jpg`, thumbKey: `o/${id}.thumb.jpg`, preparedBytes: 4000, sizeBytes: BigInt(9000), mimeType: "image/png", ...over });
}
function post(id: string, mediaId: string, over: Record<string, unknown>) {
  db.seed("scheduledPost", { id, workspaceId: WS, instagramAccountId: "acc1", type: "FEED_IMAGE", deletedAt: null, ...over });
  db.seed("scheduledPostMedia", { id: `${id}-${mediaId}`, postId: id, mediaId, position: 0 });
}
const bytes = () => Number(db.rows("workspace")[0].mediaStorageBytes);

beforeEach(() => {
  resetDb();
  mocks.enqueueMediaProcess.mockClear();
  mocks.head.mockReset().mockResolvedValue({ size: 300 });
  mocks.deleted.length = 0;
  mocks.failDelete = false;
  db.seed("workspace", { id: WS, name: "W", ownerId: "u1", mediaStorageBytes: BigInt(20_000) });
});

describe("cleanupPreparedCopies", () => {
  it("drops the prepared copy of media published 31 days ago, releases its bytes, keeps the original", async () => {
    asset("m1");
    post("p1", "m1", { status: "PUBLISHED", publishedAt: daysAgo(31) });
    const r = await cleanupPreparedCopies(NOW);
    expect(r).toEqual({ cleaned: 1, releasedBytes: 4000 });
    expect(mocks.deleted).toEqual(["o/m1.prepared.jpg"]);
    expect(db.rows("mediaAsset")[0]).toMatchObject({ preparedKey: null, preparedBytes: null, originalKey: "o/m1.png", thumbKey: "o/m1.thumb.jpg", status: "READY" });
    expect(bytes()).toBe(16_000);
    // idempotent
    expect(await cleanupPreparedCopies(NOW)).toEqual({ cleaned: 0, releasedBytes: 0 });
    expect(bytes()).toBe(16_000);
  });

  it("covers manual publishes too", async () => {
    asset("m1");
    post("p1", "m1", { status: "PUBLISHED_MANUAL", publishedAt: daysAgo(40) });
    expect((await cleanupPreparedCopies(NOW)).cleaned).toBe(1);
  });

  it("keeps the copy while any live usage needs it", async () => {
    asset("recent");
    post("p1", "recent", { status: "PUBLISHED", publishedAt: daysAgo(10) });
    asset("shared");
    post("p2", "shared", { status: "PUBLISHED", publishedAt: daysAgo(60) });
    post("p3", "shared", { status: "SCHEDULED", publishedAt: null });
    asset("retry");
    post("p4", "retry", { status: "PUBLISHED", publishedAt: daysAgo(60) });
    post("p5", "retry", { status: "FAILED", publishedAt: null });
    asset("unused");
    const r = await cleanupPreparedCopies(NOW);
    expect(r.cleaned).toBe(0);
    expect(mocks.deleted).toEqual([]);
  });

  it("ignores soft-deleted posts on either side", async () => {
    asset("m1");
    post("p1", "m1", { status: "PUBLISHED", publishedAt: daysAgo(31) });
    post("p2", "m1", { status: "DRAFT", deletedAt: daysAgo(1) });
    asset("m2");
    post("p3", "m2", { status: "PUBLISHED", publishedAt: daysAgo(31), deletedAt: daysAgo(2) });
    const r = await cleanupPreparedCopies(NOW);
    expect(r.cleaned).toBe(1);
    expect(db.rows("mediaAsset").find((a) => a.id === "m2")!.preparedKey).toBe("o/m2.prepared.jpg");
  });

  it("a video served from its original only loses the pointer — no delete, no bytes", async () => {
    asset("v1", { kind: "VIDEO", originalKey: "o/v1.mp4", preparedKey: "o/v1.mp4", preparedBytes: 7000 });
    post("p1", "v1", { type: "REEL", status: "PUBLISHED", publishedAt: daysAgo(31) });
    const r = await cleanupPreparedCopies(NOW);
    expect(r).toEqual({ cleaned: 1, releasedBytes: 0 });
    expect(mocks.deleted).toEqual([]);
    expect(db.rows("mediaAsset")[0]).toMatchObject({ preparedKey: null, preparedBytes: 7000 });
    expect(bytes()).toBe(20_000);
  });

  it("works in batches and leaves the row alone when storage refuses", async () => {
    for (let i = 0; i < 3; i++) {
      asset(`m${i}`);
      post(`p${i}`, `m${i}`, { status: "PUBLISHED", publishedAt: daysAgo(31) });
    }
    expect((await cleanupPreparedCopies(NOW, 2)).cleaned).toBe(2);
    mocks.failDelete = true;
    expect((await cleanupPreparedCopies(NOW, 2)).cleaned).toBe(0);
    expect(db.rows("mediaAsset").filter((a) => a.preparedKey)).toHaveLength(1);
    mocks.failDelete = false;
    expect((await cleanupPreparedCopies(NOW, 2)).cleaned).toBe(1);
  });
});

describe("reprepareCleanedMedia", () => {
  it("re-queues processing for a cleaned asset that is used again, releasing the thumb it will rewrite", async () => {
    asset("m1", { preparedKey: null, preparedBytes: null });
    asset("m2");
    asset("v1", { kind: "VIDEO", originalKey: "o/v1.mp4", preparedKey: null, preparedBytes: 7000 });
    expect(await reprepareCleanedMedia(WS, ["m1", "m2", "v1", "m1"])).toBe(1);
    expect(mocks.enqueueMediaProcess).toHaveBeenCalledWith("m1");
    expect(db.rows("mediaAsset").find((a) => a.id === "m1")!.status).toBe("PROCESSING");
    expect(bytes()).toBe(19_700);
    expect(await reprepareCleanedMedia("other", ["m1"])).toBe(0);
  });
});
