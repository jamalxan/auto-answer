/**
 * Comment reconciliation — ad copies of a boosted post.
 *
 * Comments left on an ad carry the ad's own media id, so the sweep has to look
 * at those media too or a webhook Meta never delivers is lost for good.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const { mockPrisma, mockQueueAdd, mockGetComments } = vi.hoisted(() => ({
  mockPrisma: {
    $queryRaw: vi.fn(),
    automation: { findMany: vi.fn() },
    dmLog: { findMany: vi.fn() },
    operationalEvent: { create: vi.fn() },
  },
  mockQueueAdd: vi.fn(),
  mockGetComments: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mockPrisma }));
vi.mock("@/lib/queue/client", () => ({ getDMQueue: () => ({ add: mockQueueAdd }) }));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (value: string) => value }));
vi.mock("@/lib/meta/client", () => ({
  getRecentMediaComments: mockGetComments,
  getUserMedia: vi.fn(async () => []),
  MetaApiError: class MetaApiError extends Error {},
}));

import { adMediaFor, reconcileComments } from "../lib/polling/comment-reconciler";

const POST = "18023946917554990";
const AD = "17899788633163100";

describe("adMediaFor", () => {
  beforeEach(() => {
    mockPrisma.$queryRaw.mockReset();
  });

  it("returns the ad media ids seen for the post", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ mediaId: AD }]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("never returns the post itself, so it is not swept twice", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ mediaId: AD }, { mediaId: POST }]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("drops rows without a media id", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([{ mediaId: null }, { mediaId: AD }]);
    await expect(adMediaFor(POST)).resolves.toEqual([AD]);
  });

  it("returns nothing when the post was never boosted", async () => {
    mockPrisma.$queryRaw.mockResolvedValue([]);
    await expect(adMediaFor(POST)).resolves.toEqual([]);
  });

  it("swallows a query failure, leaving the post itself still swept", async () => {
    mockPrisma.$queryRaw.mockRejectedValue(new Error("connection lost"));
    await expect(adMediaFor(POST)).resolves.toEqual([]);
  });
});

describe("reconcileComments", () => {
  const automation = {
    id: "auto_1",
    name: "Promo",
    postId: POST,
    matchAnyPost: false,
    matchAnyWord: true,
    keywords: [],
    wholeWordMatch: false,
    publicReplyEnabled: true,
    publicReplyMessage: null,
    publicReplyMessages: [] as string[],
    workspaceId: "w1",
    instagramAccount: { id: "acc", instagramId: "ig_owner", username: "shop", accessToken: "tok" },
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.$queryRaw.mockResolvedValue([]);
    mockPrisma.automation.findMany.mockResolvedValue([automation]);
    mockPrisma.dmLog.findMany.mockResolvedValue([]);
    mockPrisma.operationalEvent.create.mockResolvedValue({});
    mockGetComments.mockResolvedValue([
      { id: "c1", text: "link", timestamp: new Date().toISOString(), from: { id: "fan", username: "fan" } },
    ]);
  });

  it("skips accounts with a broken or missing token", async () => {
    await reconcileComments();
    expect(mockPrisma.automation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          isActive: true,
          instagramAccount: { tokenStatus: { not: "BROKEN" }, accessToken: { not: "" } },
        },
      })
    );
  });

  it("treats a SENT DM as done when public replies are on but have no text", async () => {
    await reconcileComments();
    const where = mockPrisma.dmLog.findMany.mock.calls[0][0].where;
    expect(where.OR[0]).toEqual({ status: "SENT" });
  });

  it("leaves FAILED comments alone while cooling down or after the attempts cap", async () => {
    await reconcileComments();
    const where = mockPrisma.dmLog.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(
      expect.arrayContaining([
        { status: "FAILED", updatedAt: { gt: expect.any(Date) } },
        { status: "FAILED", attempts: { gte: expect.any(Number) } },
      ])
    );
  });

  it("does not re-enqueue a comment the DmLog guard reports as handled", async () => {
    mockPrisma.dmLog.findMany.mockResolvedValue([{ commentId: "c1" }]);
    await reconcileComments();
    expect(mockQueueAdd).not.toHaveBeenCalled();

    mockPrisma.dmLog.findMany.mockResolvedValue([]);
    await reconcileComments();
    expect(mockQueueAdd).toHaveBeenCalledTimes(1);
  });
});
