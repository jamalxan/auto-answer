/**
 * ETAP 13 — the minute sweeper (spec §7 "Aniqlik va ishonchlilik", AC-8):
 * due posts without a live job are re-queued, posts past the late window
 * fail, manual posts get their notice, stuck PREPARING rows fail, stale
 * containers go back to SCHEDULED, manual posts get bound to a media id.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  hasLivePublishJob: vi.fn(async () => false),
  schedulePublish: vi.fn(async () => undefined),
  sendManualNotice: vi.fn(async () => ({ delivered: "telegram" as const })),
  bindManualPost: vi.fn(async () => true),
  failPost: vi.fn(async () => undefined),
  recoverStuckPublishing: vi.fn(async () => ({ status: "PUBLISHED" })),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/content/queue", () => ({
  hasLivePublishJob: mocks.hasLivePublishJob,
  schedulePublish: mocks.schedulePublish,
  schedulePrepare: vi.fn(async () => undefined),
  scheduleManualNotify: vi.fn(async () => undefined),
  removePostJobs: vi.fn(async () => undefined),
}));
vi.mock("@/lib/content/manual", () => ({ sendManualNotice: mocks.sendManualNotice, bindManualPost: mocks.bindManualPost }));
vi.mock("@/lib/content/publish", () => ({ failPost: mocks.failPost, recoverStuckPublishing: mocks.recoverStuckPublishing }));

import { sweepContent } from "@/lib/content/sweep";

const WS = "ws1";
const NOW = new Date("2026-10-24T14:00:00Z");
const min = (n: number) => new Date(NOW.getTime() + n * 60_000);

function post(id: string, over: Record<string, unknown>) {
  return db.seed("scheduledPost", { id, workspaceId: WS, instagramAccountId: "acc1", type: "FEED_IMAGE", status: "SCHEDULED", scheduledAt: NOW, attempts: 1, ...over });
}

beforeEach(() => {
  resetDb();
  for (const m of Object.values(mocks)) m.mockClear();
  mocks.hasLivePublishJob.mockResolvedValue(false);
  mocks.bindManualPost.mockResolvedValue(true);
});

describe("sweepContent", () => {
  it("re-queues a due SCHEDULED post whose job is gone (AC-8)", async () => {
    post("p1", { scheduledAt: min(-1) });
    const r = await sweepContent(NOW);
    expect(r.requeued).toBe(1);
    expect(mocks.schedulePublish).toHaveBeenCalledWith("p1", 1, NOW);
  });

  it("leaves a due post alone when its job is still live", async () => {
    post("p1", { scheduledAt: min(-1) });
    mocks.hasLivePublishJob.mockResolvedValue(true);
    const r = await sweepContent(NOW);
    expect(r.requeued).toBe(0);
    expect(mocks.schedulePublish).not.toHaveBeenCalled();
  });

  it("ignores posts that are not due yet", async () => {
    post("p1", { scheduledAt: min(5) });
    const r = await sweepContent(NOW);
    expect(r.requeued).toBe(0);
  });

  it("fails a post more than 15 minutes late instead of publishing it", async () => {
    post("p1", { scheduledAt: min(-16), status: "READY_TO_PUBLISH" });
    const r = await sweepContent(NOW);
    expect(r.late).toBe(1);
    expect(mocks.failPost).toHaveBeenCalledWith("p1", "PUBLISH_LATE", expect.stringMatching(/Vaqt o'tib ketdi/), expect.anything());
    expect(mocks.schedulePublish).not.toHaveBeenCalled();
  });

  it("sends the manual notice for a due manual post", async () => {
    post("p1", { scheduledAt: min(-1), autoPublish: false });
    post("p2", { scheduledAt: min(-1), manualReason: "STORY_STICKER" });
    const r = await sweepContent(NOW);
    expect(r.manual).toBe(2);
    expect(mocks.sendManualNotice).toHaveBeenCalledTimes(2);
    expect(mocks.schedulePublish).not.toHaveBeenCalled();
  });

  it("fails a PREPARING row stuck for more than 25 minutes", async () => {
    const stuck = post("p1", { status: "PREPARING", scheduledAt: min(30) });
    stuck.updatedAt = min(-26);
    const r = await sweepContent(NOW);
    expect(r.stale).toBe(1);
    expect(mocks.failPost).toHaveBeenCalledWith("p1", "PUBLISH_CONTAINER_TIMEOUT", expect.any(String), expect.anything());
  });

  it("recovers a PUBLISHING row untouched for more than 5 minutes and leaves a fresh one alone (I1)", async () => {
    const old = post("p1", { status: "PUBLISHING", containerId: "c1" });
    old.updatedAt = min(-6);
    const fresh = post("p2", { status: "PUBLISHING", containerId: "c2" });
    fresh.updatedAt = min(-1);
    const r = await sweepContent(NOW);
    expect(r.recovered).toBe(1);
    expect(mocks.recoverStuckPublishing).toHaveBeenCalledTimes(1);
    expect(mocks.recoverStuckPublishing.mock.calls[0][0]).toBe("p1");
  });

  it("returns a READY_TO_PUBLISH post with a 23-hour-old container to SCHEDULED", async () => {
    post("p1", { status: "READY_TO_PUBLISH", scheduledAt: min(60), containerId: "c1", containerCreatedAt: new Date(NOW.getTime() - 23.5 * 3_600_000) });
    const r = await sweepContent(NOW);
    expect(r.expiredContainers).toBe(1);
    expect(db.rows("scheduledPost")[0]).toMatchObject({ status: "SCHEDULED", containerId: null });
  });

  it("binds recently confirmed manual posts", async () => {
    post("p1", { status: "PUBLISHED_MANUAL", publishedAt: min(-10), igMediaId: null });
    post("p2", { status: "PUBLISHED_MANUAL", publishedAt: min(-45), igMediaId: null });
    post("p3", { status: "PUBLISHED_MANUAL", publishedAt: min(-5), igMediaId: "already" });
    const r = await sweepContent(NOW);
    expect(r.bound).toBe(1);
    expect(mocks.bindManualPost).toHaveBeenCalledWith("p1");
  });

  it("skips deleted posts", async () => {
    post("p1", { scheduledAt: min(-1), deletedAt: NOW });
    const r = await sweepContent(NOW);
    expect(r.requeued).toBe(0);
  });
});
