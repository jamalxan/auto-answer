/**
 * ETAP 13 — the publish pipeline (spec §7, §11, AC-8/9/10): container per
 * post type, carousel children in order, status polling, media_publish that
 * can never run twice, campaign activation in the same transaction, first
 * comment, token / late / invalid-media failure paths, and the Meta error →
 * retry policy table.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  createContainer: vi.fn(),
  getContainerStatus: vi.fn(),
  publishContainer: vi.fn(),
  getPublishedMedia: vi.fn(),
  getPublishingLimit: vi.fn(),
  getUserMedia: vi.fn(),
  alertWorkspace: vi.fn(async () => undefined),
  notifyWorkspaceChats: vi.fn(async () => 1),
  scheduleFirstComment: vi.fn(async () => undefined),
  scheduleRetry: vi.fn(async () => undefined),
  schedulePublish: vi.fn(async () => undefined),
  createComment: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/meta/publish", () => ({
  createContainer: mocks.createContainer,
  getContainerStatus: mocks.getContainerStatus,
  publishContainer: mocks.publishContainer,
  getPublishedMedia: mocks.getPublishedMedia,
  getPublishingLimit: mocks.getPublishingLimit,
  createComment: mocks.createComment,
}));
vi.mock("@/lib/meta/client", async (orig) => ({ ...(await orig<object>()), getUserMedia: mocks.getUserMedia }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (v: string) => `dec:${v}` }));
vi.mock("@/lib/telegram/notify", () => ({ alertWorkspace: mocks.alertWorkspace, notifyWorkspaceChats: mocks.notifyWorkspaceChats }));
vi.mock("@/lib/content/queue", () => ({
  scheduleFirstComment: mocks.scheduleFirstComment,
  scheduleRetry: mocks.scheduleRetry,
  schedulePublish: mocks.schedulePublish,
  schedulePrepare: vi.fn(),
  scheduleManualNotify: vi.fn(),
  removePostJobs: vi.fn(),
  enqueueMediaProcess: vi.fn(),
  PREPARE_JOB: "prepare",
  PUBLISH_JOB: "publish",
  FIRST_COMMENT_JOB: "first-comment",
}));
vi.mock("@/lib/content/storage", () => ({
  getStorage: () => ({ presignGet: async (key: string) => `https://cdn/${key}`, headObject: async () => null, deleteObject: async () => undefined }),
  mediaKey: () => "k",
}));

import { MetaApiError, TokenExpiredError } from "@/lib/meta/client";
import { classifyPublishError } from "@/lib/content/errors";
import { postFirstComment, preparePost, publishPost } from "@/lib/content/publish";
import { explainError } from "@/lib/foundation/error-catalog";

const WS = "ws1";
const NOW = new Date("2026-10-24T14:00:00Z");
const deps = () => ({ now: () => NOW, sleep: async () => undefined });

function seedMedia(id: string, kind: "IMAGE" | "VIDEO" = "IMAGE", status = "READY") {
  return db.seed("mediaAsset", {
    id, workspaceId: WS, kind, originalKey: `o/${id}`, preparedKey: `p/${id}`, thumbKey: `t/${id}`, mimeType: kind === "IMAGE" ? "image/jpeg" : "video/mp4",
    sizeBytes: 1000, width: 1080, height: kind === "IMAGE" ? 1350 : 1920, durationMs: kind === "VIDEO" ? 45_000 : null, status,
  });
}

function seedPost(over: Record<string, unknown> = {}, media: Array<{ id: string; kind?: "IMAGE" | "VIDEO"; userTags?: unknown; altText?: string; status?: string }> = [{ id: "m1" }]) {
  const post = db.seed("scheduledPost", {
    id: "p1", workspaceId: WS, instagramAccountId: "acc1", type: "FEED_IMAGE", status: "SCHEDULED", caption: "Salom #a",
    scheduledAt: NOW, attempts: 1, ...over,
  });
  media.forEach((m, position) => {
    seedMedia(m.id, m.kind ?? "IMAGE", m.status ?? "READY");
    db.seed("scheduledPostMedia", { postId: post.id, mediaId: m.id, position, userTags: m.userTags ?? [], altText: m.altText ?? null });
  });
  return post;
}

const containerCalls = () => mocks.createContainer.mock.calls.map((c) => c[2]);

beforeEach(() => {
  resetDb();
  for (const m of Object.values(mocks)) m.mockReset();
  mocks.alertWorkspace.mockResolvedValue(undefined);
  mocks.notifyWorkspaceChats.mockResolvedValue(1);
  mocks.scheduleFirstComment.mockResolvedValue(undefined);
  mocks.scheduleRetry.mockResolvedValue(undefined);
  mocks.schedulePublish.mockResolvedValue(undefined);
  let n = 0;
  mocks.createContainer.mockImplementation(async () => ({ id: `c${++n}` }));
  mocks.getContainerStatus.mockResolvedValue({ status: "FINISHED" });
  mocks.publishContainer.mockResolvedValue({ id: "17890" });
  mocks.getPublishedMedia.mockResolvedValue({ id: "17890", permalink: "https://instagram.com/p/x" });
  mocks.getPublishingLimit.mockResolvedValue({ quotaUsage: 1, quotaTotal: 50 });
  mocks.getUserMedia.mockResolvedValue([]);
  db.seed("workspace", { id: WS, name: "W", ownerId: "u1" });
  db.seed("instagramAccount", { id: "acc1", workspaceId: WS, instagramId: "ig1", username: "jamalxann", accessToken: "enc", tokenStatus: "ACTIVE", canPublish: true });
});

describe("preparePost", () => {
  it("feed image: one container with the signed URL, caption and user tags; FINISHED → READY_TO_PUBLISH", async () => {
    seedPost({}, [{ id: "m1", userTags: [{ username: "ali", x: 0.5, y: 0.25 }] }]);
    const r = await preparePost("p1", 1, deps());
    expect(r).toMatchObject({ status: "READY_TO_PUBLISH" });
    expect(mocks.createContainer).toHaveBeenCalledTimes(1);
    expect(mocks.createContainer.mock.calls[0][0]).toBe("dec:enc");
    expect(mocks.createContainer.mock.calls[0][1]).toBe("ig1");
    expect(containerCalls()[0]).toMatchObject({ imageUrl: "https://cdn/p/m1", caption: "Salom #a", userTags: [{ username: "ali", x: 0.5, y: 0.25 }] });
    expect(containerCalls()[0].mediaType).toBeUndefined();
    const post = db.rows("scheduledPost")[0];
    expect(post).toMatchObject({ status: "READY_TO_PUBLISH", containerId: "c1", containerStatus: "FINISHED" });
    const steps = db.rows("publishAttempt").map((a) => [a.step, a.ok]);
    expect(steps).toEqual([["CONTAINER", true], ["STATUS", true]]);
  });

  it("carousel: children first (in order, with alt text / tags), then the parent with caption and collaborators", async () => {
    seedPost({ type: "CAROUSEL", collaborators: ["friend"] }, [
      { id: "m1", altText: "one", userTags: [{ username: "a", x: 0.1, y: 0.1 }] },
      { id: "v1", kind: "VIDEO" },
      { id: "m2", altText: "three" },
    ]);
    await preparePost("p1", 1, deps());
    const calls = containerCalls();
    expect(calls).toHaveLength(4);
    expect(calls[0]).toMatchObject({ imageUrl: "https://cdn/p/m1", isCarouselItem: true, altText: "one", userTags: [{ username: "a", x: 0.1, y: 0.1 }] });
    expect(calls[0].caption).toBeUndefined();
    expect(calls[1]).toMatchObject({ videoUrl: "https://cdn/p/v1", isCarouselItem: true });
    expect(calls[2]).toMatchObject({ imageUrl: "https://cdn/p/m2", isCarouselItem: true, altText: "three" });
    expect(calls[3]).toMatchObject({ mediaType: "CAROUSEL", children: ["c1", "c2", "c3"], caption: "Salom #a", collaborators: ["friend"] });
    expect(db.rows("scheduledPostMedia").map((m) => m.containerId)).toEqual(["c1", "c2", "c3"]);
    expect(db.rows("scheduledPost")[0].containerId).toBe("c4");
  });

  it("reel: REELS media type, cover URL, share_to_feed off, collaborators", async () => {
    seedMedia("cover");
    seedPost({ type: "REEL", shareToFeed: false, coverMediaId: "cover", collaborators: ["x"] }, [{ id: "v1", kind: "VIDEO" }]);
    await preparePost("p1", 1, deps());
    expect(containerCalls()[0]).toMatchObject({ videoUrl: "https://cdn/p/v1", mediaType: "REELS", coverUrl: "https://cdn/p/cover", shareToFeed: false, collaborators: ["x"], caption: "Salom #a" });
  });

  it("trial reel adds trial_params", async () => {
    seedPost({ type: "TRIAL_REEL", trialStrategy: "SS_PERFORMANCE" }, [{ id: "v1", kind: "VIDEO" }]);
    await preparePost("p1", 1, deps());
    expect(containerCalls()[0]).toMatchObject({ mediaType: "REELS", trialStrategy: "SS_PERFORMANCE" });
  });

  it("story: STORIES media type and no caption", async () => {
    seedPost({ type: "STORY", caption: null }, [{ id: "m1" }]);
    await preparePost("p1", 1, deps());
    expect(containerCalls()[0]).toMatchObject({ imageUrl: "https://cdn/p/m1", mediaType: "STORIES" });
    expect(containerCalls()[0].caption).toBeUndefined();
  });

  it("media still PROCESSING → FAILED PUBLISH_MEDIA_INVALID without calling Meta (review focus 1)", async () => {
    seedPost({}, [{ id: "m1", status: "PROCESSING" }]);
    await preparePost("p1", 1, deps());
    expect(mocks.createContainer).not.toHaveBeenCalled();
    expect(db.rows("scheduledPost")[0]).toMatchObject({ status: "FAILED", lastErrorCode: "PUBLISH_MEDIA_INVALID" });
    expect(String(db.rows("scheduledPost")[0].lastErrorMessage)).toMatch(/tayyor emas/);
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(1);
  });

  it("token BROKEN → stays SCHEDULED, owner alerted, no Meta call (AC-10)", async () => {
    db.rows("instagramAccount")[0].tokenStatus = "BROKEN";
    seedPost();
    const r = await preparePost("p1", 1, deps());
    expect(r).toMatchObject({ waiting: "token" });
    expect(mocks.createContainer).not.toHaveBeenCalled();
    expect(db.rows("scheduledPost")[0]).toMatchObject({ status: "SCHEDULED", lastErrorCode: "PUBLISH_TOKEN_EXPIRED" });
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(1);
  });

  it("no publish scope → FAILED PUBLISH_NO_PERMISSION, canPublish stays false", async () => {
    db.rows("instagramAccount")[0].canPublish = false;
    seedPost();
    await preparePost("p1", 1, deps());
    expect(db.rows("scheduledPost")[0]).toMatchObject({ status: "FAILED", lastErrorCode: "PUBLISH_NO_PERMISSION" });
  });

  it("container ERROR with an aspect-ratio reason → FAILED PUBLISH_MEDIA_INVALID with the reason", async () => {
    seedPost();
    mocks.getContainerStatus.mockResolvedValue({ status: "ERROR", statusText: "Media aspect ratio is not supported" });
    await preparePost("p1", 1, deps());
    const post = db.rows("scheduledPost")[0];
    expect(post).toMatchObject({ status: "FAILED", lastErrorCode: "PUBLISH_MEDIA_INVALID" });
    expect(String(post.lastErrorMessage)).toMatch(/aspect ratio/);
  });

  it("container EXPIRED → a second container is created and used", async () => {
    seedPost();
    mocks.getContainerStatus.mockResolvedValueOnce({ status: "EXPIRED" }).mockResolvedValue({ status: "FINISHED" });
    await preparePost("p1", 1, deps());
    expect(mocks.createContainer).toHaveBeenCalledTimes(2);
    expect(db.rows("scheduledPost")[0]).toMatchObject({ status: "READY_TO_PUBLISH", containerId: "c2" });
  });

  it("IN_PROGRESS forever → one more container, then FAILED PUBLISH_CONTAINER_TIMEOUT", async () => {
    seedPost({ type: "REEL" }, [{ id: "v1", kind: "VIDEO" }]);
    mocks.getContainerStatus.mockResolvedValue({ status: "IN_PROGRESS" });
    let t = NOW.getTime();
    await preparePost("p1", 1, { now: () => new Date(t), sleep: async (ms: number) => void (t += ms) });
    expect(mocks.createContainer).toHaveBeenCalledTimes(2);
    expect(db.rows("scheduledPost")[0]).toMatchObject({ status: "FAILED", lastErrorCode: "PUBLISH_CONTAINER_TIMEOUT" });
  });

  it("a 190 from Meta marks the token BROKEN and leaves the post SCHEDULED", async () => {
    seedPost();
    mocks.createContainer.mockRejectedValue(new TokenExpiredError("Error validating access token [code=190 sub=463]"));
    await preparePost("p1", 1, deps());
    expect(db.rows("instagramAccount")[0].tokenStatus).toBe("BROKEN");
    expect(db.rows("scheduledPost")[0]).toMatchObject({ status: "SCHEDULED", lastErrorCode: "PUBLISH_TOKEN_EXPIRED" });
  });

  it("a rate limit on container creation backs off with a retry job and stays SCHEDULED", async () => {
    seedPost();
    mocks.createContainer.mockRejectedValue(new MetaApiError(4, undefined, undefined, "Application request limit reached [code=4 sub=-]"));
    await preparePost("p1", 1, deps());
    expect(db.rows("scheduledPost")[0].status).toBe("SCHEDULED");
    expect(mocks.scheduleRetry).toHaveBeenCalledWith("prepare", "p1", 1, 1, 60_000);
  });

  it("a stale attempt number is ignored", async () => {
    seedPost({ attempts: 2 });
    const r = await preparePost("p1", 1, deps());
    expect(r).toMatchObject({ skipped: "stale" });
    expect(mocks.createContainer).not.toHaveBeenCalled();
  });
});

describe("publishPost", () => {
  function ready(over: Record<string, unknown> = {}) {
    return seedPost({ status: "READY_TO_PUBLISH", containerId: "c1", containerStatus: "FINISHED", containerCreatedAt: NOW, firstComment: "Birinchi!", ...over });
  }

  it("publishes, stores id + permalink, activates the linked campaign and queues the first comment", async () => {
    ready();
    db.seed("automation", { id: "au1", workspaceId: WS, instagramAccountId: "acc1", name: "N", keywords: ["narx"], dmMessage: "d", isActive: false, scheduledPostId: "p1", postId: null });
    db.seed("triggerCampaign", { id: "tc1", workspaceId: WS, instagramAccountId: "acc1", name: "T", triggerType: "COMMENT", keywords: ["x"], responseMessage: "r", active: false, scheduledPostId: "p1", mediaScope: "SPECIFIC", mediaIds: [] });
    const r = await publishPost("p1", 1, deps());
    expect(r).toMatchObject({ status: "PUBLISHED", igMediaId: "17890" });
    expect(mocks.publishContainer).toHaveBeenCalledWith("dec:enc", "ig1", "c1");
    const post = db.rows("scheduledPost")[0];
    expect(post).toMatchObject({ status: "PUBLISHED", igMediaId: "17890", permalink: "https://instagram.com/p/x", publishedAt: NOW });
    expect(db.rows("automation")[0]).toMatchObject({ postId: "17890", isActive: true });
    expect(db.rows("triggerCampaign")[0]).toMatchObject({ mediaIds: ["17890"], active: true });
    expect(mocks.scheduleFirstComment).toHaveBeenCalledWith("p1", 10_000);
    expect(mocks.notifyWorkspaceChats).toHaveBeenCalledTimes(1);
    expect(db.rows("publishAttempt").map((a) => a.step)).toEqual(["PUBLISH", "LINK_CAMPAIGN"]);
  });

  it("media_publish times out but Meta published: binds the newest media, never publishes twice (review focus 2, AC-9)", async () => {
    ready();
    mocks.publishContainer.mockRejectedValue(new Error("fetch failed: ETIMEDOUT"));
    mocks.getContainerStatus.mockResolvedValue({ status: "PUBLISHED" });
    mocks.getUserMedia.mockResolvedValue([{ id: "17999", media_type: "IMAGE", timestamp: NOW.toISOString(), permalink: "https://instagram.com/p/y" }]);
    const r = await publishPost("p1", 1, deps());
    expect(r).toMatchObject({ status: "PUBLISHED", igMediaId: "17999" });
    expect(mocks.publishContainer).toHaveBeenCalledTimes(1);
    expect(mocks.scheduleRetry).not.toHaveBeenCalled();
    expect(db.rows("scheduledPost")[0]).toMatchObject({ status: "PUBLISHED", igMediaId: "17999", permalink: "https://instagram.com/p/y" });
  });

  it("media_publish network error with the container still FINISHED: back to READY_TO_PUBLISH with a retry job", async () => {
    ready();
    mocks.publishContainer.mockRejectedValue(new Error("fetch failed: ECONNRESET"));
    mocks.getContainerStatus.mockResolvedValue({ status: "FINISHED" });
    await publishPost("p1", 1, deps());
    expect(db.rows("scheduledPost")[0].status).toBe("READY_TO_PUBLISH");
    expect(mocks.scheduleRetry).toHaveBeenCalledWith("publish", "p1", 1, 1, 30_000);
  });

  it("after the last retry a transient error becomes FAILED PUBLISH_UNKNOWN", async () => {
    ready();
    mocks.publishContainer.mockRejectedValue(new Error("fetch failed: ECONNRESET"));
    mocks.getContainerStatus.mockResolvedValue({ status: "FINISHED" });
    await publishPost("p1", 1, deps(), 3);
    expect(db.rows("scheduledPost")[0]).toMatchObject({ status: "FAILED", lastErrorCode: "PUBLISH_UNKNOWN" });
    expect(mocks.scheduleRetry).not.toHaveBeenCalled();
  });

  it("more than 15 minutes late → FAILED with the late message, nothing published", async () => {
    ready({ scheduledAt: new Date(NOW.getTime() - 16 * 60_000) });
    await publishPost("p1", 1, deps());
    expect(mocks.publishContainer).not.toHaveBeenCalled();
    const post = db.rows("scheduledPost")[0];
    expect(post).toMatchObject({ status: "FAILED", lastErrorCode: "PUBLISH_LATE" });
    expect(String(post.lastErrorMessage)).toMatch(/Vaqt o'tib ketdi/);
  });

  it("quota code 9 reschedules into the next window instead of failing", async () => {
    ready();
    mocks.publishContainer.mockRejectedValue(new MetaApiError(9, 2207051, undefined, "Application request limit reached [code=9 sub=2207051]"));
    await publishPost("p1", 1, deps());
    const post = db.rows("scheduledPost")[0];
    expect(post.status).toBe("SCHEDULED");
    expect(post.lastErrorCode).toBe("PUBLISH_QUOTA");
    expect((post.scheduledAt as Date).getTime()).toBeGreaterThan(NOW.getTime());
    expect(mocks.schedulePublish).toHaveBeenCalled();
  });

  it("a SCHEDULED post whose prepare job never ran is prepared inline", async () => {
    seedPost({ status: "SCHEDULED" });
    const r = await publishPost("p1", 1, deps());
    expect(r).toMatchObject({ status: "PUBLISHED" });
    expect(mocks.createContainer).toHaveBeenCalledTimes(1);
    expect(mocks.publishContainer).toHaveBeenCalledWith("dec:enc", "ig1", "c1");
  });

  it("two concurrent publish runs: exactly one media_publish", async () => {
    ready();
    const [a, b] = await Promise.all([publishPost("p1", 1, deps()), publishPost("p1", 1, deps())]);
    expect(mocks.publishContainer).toHaveBeenCalledTimes(1);
    expect([a, b].filter((r) => (r as { status?: string }).status === "PUBLISHED")).toHaveLength(1);
    // The loser either lost the account lock (and re-queues itself) or lost the status CAS.
    expect([a, b].filter((r) => "skipped" in (r as object) || (r as { waiting?: string }).waiting === "lock")).toHaveLength(1);
  });
});

describe("postFirstComment", () => {
  it("writes the comment and records SENT", async () => {
    seedPost({ status: "PUBLISHED", igMediaId: "17890", firstComment: "Birinchi!" });
    mocks.createComment.mockResolvedValue({ id: "cm1" });
    await postFirstComment("p1", deps());
    expect(mocks.createComment).toHaveBeenCalledWith("dec:enc", "17890", "Birinchi!");
    expect(db.rows("scheduledPost")[0]).toMatchObject({ firstCommentStatus: "SENT", firstCommentId: "cm1", status: "PUBLISHED" });
  });

  it("retries twice, then records FAILED and alerts, post stays PUBLISHED", async () => {
    seedPost({ status: "PUBLISHED", igMediaId: "17890", firstComment: "Birinchi!" });
    mocks.createComment.mockRejectedValue(new Error("fetch failed"));
    await postFirstComment("p1", deps(), 0);
    expect(mocks.scheduleFirstComment).toHaveBeenLastCalledWith("p1", 30_000, 1);
    await postFirstComment("p1", deps(), 2);
    const post = db.rows("scheduledPost")[0];
    expect(post).toMatchObject({ status: "PUBLISHED", firstCommentStatus: "FAILED", lastErrorCode: "FIRST_COMMENT_FAILED" });
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(1);
  });
});

describe("classifyPublishError", () => {
  it("maps Meta codes to catalog codes and retry policies", () => {
    expect(classifyPublishError(new MetaApiError(4, undefined, undefined, "x [code=4 sub=-]"))).toEqual({ code: "PUBLISH_RATE_LIMIT", retry: "backoff", delaysMs: [60_000, 120_000, 240_000, 480_000] });
    expect(classifyPublishError(new MetaApiError(9, undefined, undefined, "x [code=9 sub=-]")).code).toBe("PUBLISH_QUOTA");
    expect(classifyPublishError(new TokenExpiredError("x [code=190 sub=-]"))).toMatchObject({ code: "PUBLISH_TOKEN_EXPIRED", retry: "none" });
    expect(classifyPublishError(new MetaApiError(10, undefined, undefined, "x [code=10 sub=-]")).code).toBe("PUBLISH_NO_PERMISSION");
    expect(classifyPublishError(new MetaApiError(200, undefined, undefined, "x [code=200 sub=-]")).code).toBe("PUBLISH_NO_PERMISSION");
    expect(classifyPublishError(new MetaApiError(36000, undefined, undefined, "Page publishing authorization [code=36000 sub=-]")).code).toBe("PUBLISH_PPA_REQUIRED");
    expect(classifyPublishError(new MetaApiError(9007, undefined, undefined, "Media download failed [code=9007 sub=2207008]"))).toMatchObject({ code: "PUBLISH_MEDIA_FETCH", retry: "new-url" });
    expect(classifyPublishError(new MetaApiError(100, 2207026, undefined, "Unsupported video format [code=100 sub=2207026]")).code).toBe("PUBLISH_MEDIA_INVALID");
    expect(classifyPublishError(new MetaApiError(100, 2207032, undefined, "Invalid user tag [code=100 sub=2207032]")).code).toBe("PUBLISH_INVALID_USER_TAG");
    expect(classifyPublishError(new MetaApiError(100, 2207042, undefined, "collaborator not found [code=100 sub=2207042]")).code).toBe("PUBLISH_INVALID_COLLABORATOR");
    expect(classifyPublishError(new MetaApiError(100, 2207050, undefined, "Instagram user restricted [code=100 sub=2207050]")).code).toBe("PUBLISH_ACCOUNT_RESTRICTED");
    expect(classifyPublishError(new Error("fetch failed: ETIMEDOUT"))).toEqual({ code: "PUBLISH_UNKNOWN", retry: "backoff", delaysMs: [30_000, 120_000, 600_000] });
    expect(classifyPublishError(new MetaApiError(1, undefined, undefined, "An unknown error [code=1 sub=-]")).code).toBe("PUBLISH_UNKNOWN");
  });

  it("the error catalog explains each publish code in Uzbek", () => {
    const e = explainError("PUBLISH_QUOTA: 24 soatlik limit");
    expect(e.code).toBe("PUBLISH_QUOTA");
    expect(e.problem).toMatch(/limit/i);
    expect(explainError("PUBLISH_NO_PERMISSION").action.kind).toBe("reconnect");
    expect(explainError("CAMPAIGN_LINK_FAILED").severity).toBe("critical");
  });
});
