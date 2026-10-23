/**
 * ETAP 13 — media library service: presigned uploads with size and quota
 * limits, upload completion handing off to the processing queue, deletion
 * refused while a live post uses the asset, tenant isolation (FR-M1, FR-M5).
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  enqueueMediaProcess: vi.fn(async () => undefined),
  head: vi.fn(async (_key: string): Promise<{ size: number } | null> => ({ size: 1000 })),
  deleted: [] as string[],
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/content/queue", () => ({ enqueueMediaProcess: mocks.enqueueMediaProcess }));
vi.mock("@/lib/content/storage", () => ({
  getStorage: () => ({
    presignPut: async (key: string, o: { contentType: string }) => ({ url: `https://bucket/${key}?sig=1`, headers: { "Content-Type": o.contentType } }),
    presignGet: async (key: string) => `https://bucket/${key}?get=1`,
    headObject: mocks.head,
    deleteObject: async (key: string) => void mocks.deleted.push(key),
    getObject: async () => Buffer.alloc(0),
    putObject: async () => undefined,
  }),
  mediaKey: (ws: string, ext: string) => `ws/${ws}/2026/10/abc123.${ext}`,
}));

import { ContentError } from "@/lib/content/errors";
import { completeUpload, deleteMedia, listMedia, presignUpload } from "@/lib/content/media";

const WS = "ws1";

beforeEach(() => {
  resetDb();
  mocks.enqueueMediaProcess.mockClear();
  mocks.head.mockReset().mockResolvedValue({ size: 1000 });
  mocks.deleted.length = 0;
  vi.unstubAllEnvs();
  db.seed("workspace", { id: WS, name: "W", ownerId: "u1", mediaStorageBytes: 0 });
});

describe("presignUpload", () => {
  it("creates an UPLOADING asset under the workspace key prefix", async () => {
    const r = await presignUpload(WS, "u1", { fileName: "a.PNG", mimeType: "image/png", sizeBytes: 1000 });
    expect(r.uploadUrl).toContain(`ws/${WS}/`);
    expect(r.headers["Content-Type"]).toBe("image/png");
    expect(r.expiresInSec).toBe(900);
    const asset = db.rows("mediaAsset")[0];
    expect(asset).toMatchObject({ id: r.mediaId, workspaceId: WS, kind: "IMAGE", status: "UPLOADING", originalKey: `ws/${WS}/2026/10/abc123.png` });
  });

  it("refuses HEIC / HEIF with a clear message — the installed sharp cannot decode it (I4)", async () => {
    await expect(presignUpload(WS, "u1", { fileName: "IMG_1.HEIC", mimeType: "image/heic", sizeBytes: 1000 })).rejects.toMatchObject({ status: 400, message: expect.stringMatching(/HEIC/) });
    await expect(presignUpload(WS, "u1", { fileName: "IMG_1.heif", mimeType: "image/heif", sizeBytes: 1000 })).rejects.toMatchObject({ status: 400 });
  });

  it("refuses an image over 30 MB and a video over 1 GB", async () => {
    await expect(presignUpload(WS, "u1", { fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 31 * 1024 ** 2 })).rejects.toMatchObject({ status: 413 });
    await expect(presignUpload(WS, "u1", { fileName: "a.mp4", mimeType: "video/mp4", sizeBytes: 1024 ** 3 + 1 })).rejects.toMatchObject({ status: 413 });
  });

  it("refuses when the workspace storage quota would be exceeded", async () => {
    vi.stubEnv("CONTENT_STORAGE_QUOTA_BYTES", "5000");
    db.rows("workspace")[0].mediaStorageBytes = 4500;
    const err = await presignUpload(WS, "u1", { fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 1000 }).catch((e) => e);
    expect(err).toBeInstanceOf(ContentError);
    expect(err.status).toBe(413);
    expect(err.message).toMatch(/kvota/i);
  });

  it("reserves the upload size in the workspace counter", async () => {
    await presignUpload(WS, "u1", { fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 1000 });
    expect(Number(db.rows("workspace")[0].mediaStorageBytes)).toBe(1000);
  });
});

describe("completeUpload", () => {
  it("moves to PROCESSING and enqueues processing when the object exists", async () => {
    const { mediaId } = await presignUpload(WS, "u1", { fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 1000 });
    const asset = await completeUpload(WS, mediaId);
    expect(asset.status).toBe("PROCESSING");
    expect(mocks.enqueueMediaProcess).toHaveBeenCalledWith(mediaId);
  });

  it("answers 400 and stays UPLOADING when nothing was uploaded", async () => {
    mocks.head.mockResolvedValue(null);
    const { mediaId } = await presignUpload(WS, "u1", { fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 1000 });
    await expect(completeUpload(WS, mediaId)).rejects.toMatchObject({ status: 400 });
    expect(db.rows("mediaAsset")[0].status).toBe("UPLOADING");
    expect(mocks.enqueueMediaProcess).not.toHaveBeenCalled();
  });

  it("answers 400 when the uploaded size differs from the declared one", async () => {
    mocks.head.mockResolvedValue({ size: 999 });
    const { mediaId } = await presignUpload(WS, "u1", { fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 1000 });
    await expect(completeUpload(WS, mediaId)).rejects.toMatchObject({ status: 400 });
  });

  it("is a 404 for another workspace", async () => {
    const { mediaId } = await presignUpload(WS, "u1", { fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 1000 });
    await expect(completeUpload("other", mediaId)).rejects.toMatchObject({ status: 404 });
  });
});

describe("deleteMedia", () => {
  function readyAsset(id: string) {
    return db.seed("mediaAsset", { id, workspaceId: WS, kind: "IMAGE", originalKey: `ws/${WS}/2026/10/${id}.jpg`, preparedKey: `ws/${WS}/2026/10/${id}.prepared.jpg`, thumbKey: `ws/${WS}/2026/10/${id}.thumb.jpg`, mimeType: "image/jpeg", sizeBytes: 100, status: "READY" });
  }

  it("refuses while a scheduled post uses the asset", async () => {
    readyAsset("m1");
    db.seed("scheduledPost", { id: "p1", workspaceId: WS, instagramAccountId: "a", type: "FEED_IMAGE", status: "SCHEDULED" });
    db.seed("scheduledPostMedia", { postId: "p1", mediaId: "m1", position: 0 });
    await expect(deleteMedia(WS, "m1")).rejects.toMatchObject({ status: 409 });
    expect(db.rows("mediaAsset")[0].status).toBe("READY");
  });

  it("deletes the objects and marks DELETED when only published posts use it", async () => {
    readyAsset("m1");
    // original 100 + prepared/thumb as reported by storage (1000 each in this fake)
    db.rows("workspace")[0].mediaStorageBytes = 2400;
    db.seed("scheduledPost", { id: "p1", workspaceId: WS, instagramAccountId: "a", type: "FEED_IMAGE", status: "PUBLISHED" });
    db.seed("scheduledPostMedia", { postId: "p1", mediaId: "m1", position: 0 });
    await deleteMedia(WS, "m1");
    expect(db.rows("mediaAsset")[0].status).toBe("DELETED");
    expect(mocks.deleted.sort()).toEqual([`ws/${WS}/2026/10/m1.jpg`, `ws/${WS}/2026/10/m1.prepared.jpg`, `ws/${WS}/2026/10/m1.thumb.jpg`]);
    expect(Number(db.rows("workspace")[0].mediaStorageBytes)).toBe(300);
  });

  it("is a 404 for another workspace", async () => {
    readyAsset("m1");
    await expect(deleteMedia("other", "m1")).rejects.toMatchObject({ status: 404 });
  });
});

describe("listMedia", () => {
  it("lists the workspace's non-deleted assets newest first with signed thumbs and usages", async () => {
    db.seed("mediaAsset", { id: "m1", workspaceId: WS, kind: "IMAGE", originalKey: "k1", thumbKey: "t1", mimeType: "image/jpeg", sizeBytes: 100, status: "READY" });
    db.seed("mediaAsset", { id: "m2", workspaceId: WS, kind: "IMAGE", originalKey: "k2", mimeType: "image/jpeg", sizeBytes: 100, status: "DELETED" });
    db.seed("mediaAsset", { id: "m3", workspaceId: "other", kind: "IMAGE", originalKey: "k3", mimeType: "image/jpeg", sizeBytes: 100, status: "READY" });
    db.seed("scheduledPost", { id: "p1", workspaceId: WS, instagramAccountId: "a", type: "FEED_IMAGE", status: "DRAFT" });
    db.seed("scheduledPostMedia", { postId: "p1", mediaId: "m1", position: 0 });
    const r = await listMedia(WS, {});
    expect(r.total).toBe(1);
    expect(r.items[0]).toMatchObject({ id: "m1", thumbUrl: "https://bucket/t1?get=1", usedByPostIds: ["p1"], sizeBytes: 100 });
  });
});
