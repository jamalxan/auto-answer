/** Statistics across every network (lib/analytics/network-stats). */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  usableCredentials: vi.fn(async (_ws: string, id: string) => ({ accessToken: "t", externalAccountId: `ext-${id}`, channel: "facebook", credentialId: id, label: null })),
  facebookPostCounts: vi.fn(async () => ({ likes: 5, comments: 2, shares: 1 })),
  fetchInsights: vi.fn(async (_c: unknown, id: string) => ({ externalId: id, metrics: { views: 100, likes: 10, replies: 3, reposts: 1, quotes: 1 }, fetchedAt: new Date() })),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/channels/access", () => ({ usableCredentials: mocks.usableCredentials }));
vi.mock("@/lib/channels/facebook", () => ({ facebookPostCounts: mocks.facebookPostCounts }));
vi.mock("@/lib/channels/registry", () => ({ adapterFor: () => ({ fetchInsights: mocks.fetchInsights }) }));

import { getNetworkDetail, getNetworkStats, permalinkOf } from "@/lib/analytics/network-stats";
import { ChannelError } from "@/lib/channels/types";

const WS = "ws1";
const NOW = new Date("2026-11-05T12:00:00Z");
const ago = (days: number) => new Date(NOW.getTime() - days * 86_400_000);

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  db.seed("workspace", { id: WS, name: "W", ownerId: "u1" });
});

describe("getNetworkStats", () => {
  it("one row per connected account on every network, with counts in the range only", async () => {
    db.seed("instagramAccount", { id: "ig1", workspaceId: WS, instagramId: "1", username: "shop", connectedAt: ago(100), tokenLastError: null });
    db.seed("instagramAccount", { id: "ig2", workspaceId: WS, instagramId: "2", username: "gone", connectedAt: ago(100), tokenLastError: "Disconnected by user" });
    db.seed("channelCredential", { id: "fb1", workspaceId: WS, channel: "facebook", label: "Do'kon sahifa", externalAccountId: "p1", status: "ACTIVE", createdAt: ago(50) });
    db.seed("channelCredential", { id: "th0", workspaceId: WS, channel: "threads", label: "old", externalAccountId: "t0", status: "REVOKED", createdAt: ago(50) });
    db.seed("telegramChannel", { id: "tg1", workspaceId: WS, chatId: "-100", title: "Kanal", status: "ACTIVE", createdAt: ago(10) });

    db.seed("scheduledPost", { id: "s1", workspaceId: WS, instagramAccountId: "ig1", status: "PUBLISHED", publishedAt: ago(3), deletedAt: null });
    db.seed("scheduledPost", { id: "s2", workspaceId: WS, instagramAccountId: "ig1", status: "PUBLISHED", publishedAt: ago(40), deletedAt: null });
    db.seed("contentPostStat", { id: "c1", workspaceId: WS, instagramAccountId: "ig1", igMediaId: "m1", publishedAt: ago(3), views: 500, likes: 40, comments: 4, shares: 2 });
    db.seed("dmLog", { id: "d1", workspaceId: WS, automationId: "a", instagramAccountId: "ig1", commentId: "c", commenterId: "x", commentText: "?", status: "SENT", createdAt: ago(1) });
    db.seed("dmLog", { id: "d2", workspaceId: WS, automationId: "a", instagramAccountId: "ig1", commentId: "c2", commenterId: "x", commentText: "?", status: "FAILED", createdAt: ago(1) });

    db.seed("channelPostTarget", { id: "t1", workspaceId: WS, postId: "s1", channel: "facebook", accountRef: "fb1", status: "PUBLISHED", externalIds: ["p1_9"], publishedAt: ago(2), updatedAt: ago(2) });
    db.seed("channelPostTarget", { id: "t2", workspaceId: WS, postId: "s2", channel: "telegram", accountRef: "tg1", status: "FAILED", externalIds: [], publishedAt: null, updatedAt: ago(1) });
    db.seed("channelMessage", { id: "m1", workspaceId: WS, channel: "facebook", accountRef: "fb1", direction: "IN", createdAt: ago(1) });
    db.seed("channelMessage", { id: "m2", workspaceId: WS, channel: "facebook", accountRef: "fb1", direction: "OUT", createdAt: ago(1) });

    const s = await getNetworkStats(WS, { days: 30, now: NOW });
    expect(s.accounts.map((a) => `${a.network}:${a.id}`)).toEqual(["instagram:ig1", "facebook:fb1", "telegram:tg1"]);

    const ig = s.accounts[0];
    expect(ig).toMatchObject({ published: 1, inbound: 2, replies: 1, metrics: { views: 500, likes: 40, comments: 4, shares: 2 }, note: null });

    const fb = s.accounts[1];
    expect(fb).toMatchObject({ label: "Do'kon sahifa", published: 1, inbound: 1, replies: 1, metrics: { views: null, likes: 5, comments: 2, shares: 1 }, metricsPosts: 1 });
    expect(mocks.facebookPostCounts).toHaveBeenCalledWith(expect.anything(), "p1_9");

    expect(s.accounts[2]).toMatchObject({ failed: 1, metrics: null, note: expect.stringContaining("Telegram") });
    expect(s.totals.threads.accounts).toBe(0);
    expect(s.totals.facebook.published).toBe(1);
  });

  it("maps Threads replies/reposts onto comments/shares", async () => {
    db.seed("channelCredential", { id: "th1", workspaceId: WS, channel: "threads", label: "@me", externalAccountId: "t1", status: "ACTIVE", createdAt: ago(5) });
    db.seed("channelPostTarget", { id: "t1", workspaceId: WS, postId: "p", channel: "threads", accountRef: "th1", status: "PUBLISHED", externalIds: ["thr1"], publishedAt: ago(1), updatedAt: ago(1) });
    const s = await getNetworkStats(WS, { days: 7, now: NOW });
    expect(s.accounts[0].metrics).toEqual({ views: 100, likes: 10, comments: 3, shares: 2 });
  });

  it("a dead connection keeps the counts and explains the missing numbers", async () => {
    db.seed("channelCredential", { id: "yt1", workspaceId: WS, channel: "youtube", label: "Kanal", externalAccountId: "y", status: "ACTIVE", createdAt: ago(5) });
    db.seed("channelPostTarget", { id: "t1", workspaceId: WS, postId: "p", channel: "youtube", accountRef: "yt1", status: "PUBLISHED", externalIds: ["vid-auth-test"], publishedAt: ago(1), updatedAt: ago(1) });
    mocks.usableCredentials.mockRejectedValueOnce(new ChannelError("auth", "x"));
    const s = await getNetworkStats(WS, { days: 7, now: NOW });
    expect(s.accounts[0]).toMatchObject({ published: 1, metrics: null, note: expect.stringContaining("qayta ulang") });
  });

  it("live=false never calls a platform", async () => {
    db.seed("channelCredential", { id: "fb1", workspaceId: WS, channel: "facebook", label: "P", externalAccountId: "p", status: "ACTIVE", createdAt: ago(5) });
    db.seed("channelPostTarget", { id: "t1", workspaceId: WS, postId: "p", channel: "facebook", accountRef: "fb1", status: "PUBLISHED", externalIds: ["x_1"], publishedAt: ago(1), updatedAt: ago(1) });
    await getNetworkStats(WS, { days: 7, now: NOW, live: false });
    expect(mocks.usableCredentials).not.toHaveBeenCalled();
  });
});

describe("getNetworkDetail", () => {
  const seedYoutube = () => {
    db.seed("channelCredential", { id: "yt1", workspaceId: WS, channel: "youtube", label: "Kanal A", externalAccountId: "a", status: "ACTIVE", createdAt: ago(20) });
    db.seed("channelCredential", { id: "yt2", workspaceId: WS, channel: "youtube", label: "Kanal B", externalAccountId: "b", status: "ACTIVE", createdAt: ago(20) });
    db.seed("scheduledPost", { id: "p1", workspaceId: WS, caption: "  Yangi video  ", status: "PUBLISHED", deletedAt: null });
    db.seed("scheduledPost", { id: "p2", workspaceId: WS, caption: null, status: "PUBLISHED", deletedAt: null });
    db.seed("channelPostTarget", { id: "t1", workspaceId: WS, postId: "p1", channel: "youtube", accountRef: "yt1", status: "PUBLISHED", externalIds: ["vidA"], publishedAt: ago(2), updatedAt: ago(2) });
    db.seed("channelPostTarget", { id: "t2", workspaceId: WS, postId: "p2", channel: "youtube", accountRef: "yt2", status: "FAILED", externalIds: [], lastError: "quota", publishedAt: null, updatedAt: ago(1) });
    db.seed("channelPostTarget", { id: "t3", workspaceId: WS, postId: "p2", channel: "youtube", accountRef: "yt1", status: "PUBLISHED", externalIds: ["old"], publishedAt: ago(60), updatedAt: ago(60) });
    db.seed("channelMessage", { id: "m1", workspaceId: WS, channel: "youtube", accountRef: "yt1", direction: "IN", createdAt: ago(2) });
  };

  it("lists the network's posts newest first with metrics, links and a zero-filled daily series", async () => {
    seedYoutube();
    const d = await getNetworkDetail(WS, "youtube", { days: 7, now: NOW });
    expect(d).not.toBeNull();
    expect(d!.allAccounts.map((a) => a.id)).toEqual(["yt1", "yt2"]);
    expect(d!.posts.map((p) => p.id)).toEqual(["t2", "t1"]);
    expect(d!.posts[1]).toMatchObject({ caption: "Yangi video", permalink: "https://www.youtube.com/watch?v=vidA", metrics: { views: 100, likes: 10 } });
    expect(d!.posts[0]).toMatchObject({ status: "FAILED", error: "quota", permalink: null, caption: null });
    expect(d!.daily).toHaveLength(8);
    expect(d!.daily.reduce((n, p) => n + p.published, 0)).toBe(1);
    expect(d!.daily.reduce((n, p) => n + p.failed, 0)).toBe(1);
    expect(d!.daily.reduce((n, p) => n + p.inbound, 0)).toBe(1);
    expect(d!.totals).toMatchObject({ accounts: 2, published: 1, failed: 1, inbound: 1 });
  });

  it("narrows to one account of the workspace and refuses anyone else's", async () => {
    seedYoutube();
    db.seed("channelCredential", { id: "other", workspaceId: "ws2", channel: "youtube", label: "X", externalAccountId: "x", status: "ACTIVE", createdAt: ago(5) });
    const one = await getNetworkDetail(WS, "youtube", { days: 7, now: NOW, accountId: "yt2", live: false });
    expect(one!.accountId).toBe("yt2");
    expect(one!.posts.map((p) => p.id)).toEqual(["t2"]);
    expect(one!.allAccounts).toHaveLength(2);
    expect(await getNetworkDetail(WS, "youtube", { days: 7, now: NOW, accountId: "other" })).toBeNull();
  });

  it("an unconnected network is empty, not an error", async () => {
    const d = await getNetworkDetail(WS, "threads", { days: 30, now: NOW });
    expect(d).toMatchObject({ allAccounts: [], posts: [], postsTotal: 0 });
  });

  it("builds safe post links per network", () => {
    expect(permalinkOf("facebook", "1_2")).toBe("https://www.facebook.com/1_2");
    expect(permalinkOf("telegram", "15,16", { chatId: "-100123", username: "shop_uz" })).toBe("https://t.me/shop_uz/15");
    expect(permalinkOf("telegram", "15", { chatId: "-100123", username: null })).toBe("https://t.me/c/123/15");
    expect(permalinkOf("telegram", "x", { chatId: "-100123", username: "a" })).toBeNull();
    expect(permalinkOf("threads", "999")).toBeNull();
  });
});
