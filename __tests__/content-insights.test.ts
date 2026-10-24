/**
 * ETAP 13 Faza 2 (WP-D) — feed grid preview (FR-V3) and best times (FR-S7),
 * Meta stubbed with a fetch router.
 */
import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({ developerSession: vi.fn(), workspaceContext: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: vi.fn() }));
vi.mock("@/lib/developer/auth", () => ({ getDeveloperSession: mocks.developerSession }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mocks.workspaceContext,
  canManageWorkspace: () => false,
  canManageBilling: () => false,
  hasWorkspaceRole: () => true,
}));
vi.mock("@/lib/meta/oauth", () => ({ decryptToken: (v: string) => `dec:${v}` }));
vi.mock("@/lib/content/storage", () => ({
  getStorage: () => ({ presignGet: async (key: string) => `https://b/${key}` }),
  isStorageConfigured: () => true,
  getStorageDriverName: () => "local",
}));

import { GET as bestTimesRoute } from "@/app/api/developer/content/accounts/[id]/best-times/route";
import { GET as feedRoute } from "@/app/api/developer/content/accounts/[id]/feed/route";
import { clearInsightsCache, gridFromOnlineFollowers, gridFromPosts, topCells, zonedWeekHour } from "@/lib/content/insights";

const WS = "ws1";
const DAY = 86_400_000;
const ctx = (role: string, workspaceId = WS) => ({ userId: "u1", workspaceId, workspace: { id: workspaceId, name: "W", timezone: "Asia/Tashkent" }, role });
const get = (path: string) => new NextRequest(`http://localhost/api/developer/content/${path}`);
const params = (id: string) => ({ params: Promise.resolve({ id }) });

type Handler = (url: URL) => { status?: number; body: unknown };
let routes: Record<string, Handler> = {};
const calls: URL[] = [];

function metaError(code: number, message = "boom") {
  return { status: 400, body: { error: { message, type: "OAuthException", code } } };
}

beforeEach(() => {
  resetDb();
  clearInsightsCache();
  calls.length = 0;
  routes = {};
  mocks.developerSession.mockResolvedValue({ email: "dev@x" });
  mocks.workspaceContext.mockResolvedValue(ctx("VIEWER"));
  db.seed("workspace", { id: WS, name: "W", ownerId: "u1", timezone: "Asia/Tashkent" });
  db.seed("instagramAccount", { id: "acc1", workspaceId: WS, instagramId: "ig1", username: "jamalxann", accessToken: "t", tokenStatus: "ACTIVE", canPublish: true });
  db.seed("mediaAsset", { id: "m1", workspaceId: WS, kind: "IMAGE", originalKey: "k/m1", thumbKey: "k/m1.t", mimeType: "image/jpeg", sizeBytes: 1000, status: "READY" });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string | URL) => {
      const url = new URL(String(input));
      calls.push(url);
      const key = `${url.pathname.replace(/^\/v[\d.]+/, "")}${url.searchParams.get("metric") ? `?${url.searchParams.get("metric")}` : ""}`;
      const handler = routes[key] ?? routes[url.pathname.replace(/^\/v[\d.]+/, "")];
      const { status = 200, body } = handler ? handler(url) : metaError(100, `no route ${key}`);
      return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function seedPost(id: string, status: string, scheduledAt: Date | null, extra: Record<string, unknown> = {}) {
  db.seed("scheduledPost", { id, workspaceId: WS, instagramAccountId: "acc1", type: "FEED_IMAGE", status, scheduledAt, shareToFeed: true, timezone: "Asia/Tashkent", version: 1, createdAt: new Date(), ...extra });
  db.seed("scheduledPostMedia", { id: `pm-${id}`, postId: id, mediaId: "m1", position: 0, userTags: [] });
}

const igMedia = (n: number) =>
  Array.from({ length: n }, (_, i) => ({ id: `ig${i}`, media_type: i % 3 === 0 ? "VIDEO" : "IMAGE", media_url: `https://cdn/${i}.jpg`, thumbnail_url: `https://cdn/${i}.thumb.jpg`, permalink: `https://instagram.com/p/${i}`, timestamp: new Date(Date.now() - (i + 1) * DAY).toISOString() }));

describe("feed grid (FR-V3)", () => {
  it("puts planned posts (furthest future first, drafts flagged) above the last 12 published", async () => {
    routes["/ig1/media"] = () => ({ body: { data: igMedia(12) } });
    seedPost("near", "SCHEDULED", new Date(Date.now() + DAY));
    seedPost("far", "SCHEDULED", new Date(Date.now() + 3 * DAY));
    seedPost("draft", "DRAFT", new Date(Date.now() + 2 * DAY));
    seedPost("noplan", "DRAFT", null);
    seedPost("story", "SCHEDULED", new Date(Date.now() + DAY), { type: "STORY" });
    seedPost("reel-off", "SCHEDULED", new Date(Date.now() + DAY), { type: "REEL", shareToFeed: false });
    seedPost("reel-on", "SCHEDULED", new Date(Date.now() + 4 * DAY), { type: "REEL", shareToFeed: true });
    seedPost("trial", "SCHEDULED", new Date(Date.now() + DAY), { type: "TRIAL_REEL" });
    const res = await feedRoute(get("accounts/acc1/feed"), params("acc1"));
    const json = await res.json();
    expect(res.status).toBe(200);
    const items = json.data.items as Array<{ key: string; source: string; draft: boolean; imageUrl: string | null }>;
    expect(items.slice(0, 4).map((i) => i.key)).toEqual(["post:reel-on", "post:far", "post:draft", "post:near"]);
    expect(items[2].draft).toBe(true);
    expect(items.slice(4)).toHaveLength(12);
    expect(items[4]).toMatchObject({ key: "ig:ig0", source: "instagram", imageUrl: "https://cdn/0.thumb.jpg" });
    expect(items[5].imageUrl).toBe("https://cdn/1.jpg");
    expect(json.data.notice).toBeNull();
    const media = calls.find((c) => c.pathname.endsWith("/ig1/media"))!;
    expect(media.searchParams.get("fields")).toContain("thumbnail_url");
    expect(media.searchParams.get("access_token")).toBe("dec:t");
  });

  it("caches the Meta part for ten minutes", async () => {
    routes["/ig1/media"] = () => ({ body: { data: igMedia(2) } });
    await feedRoute(get("accounts/acc1/feed"), params("acc1"));
    await feedRoute(get("accounts/acc1/feed"), params("acc1"));
    expect(calls.filter((c) => c.pathname.endsWith("/media"))).toHaveLength(1);
  });

  it("degrades to our own published posts with an explanation when Meta fails", async () => {
    routes["/ig1/media"] = () => metaError(190, "expired");
    seedPost("pub", "PUBLISHED", new Date(Date.now() - DAY), { publishedAt: new Date(Date.now() - DAY), permalink: "https://instagram.com/p/x" });
    const json = await (await feedRoute(get("accounts/acc1/feed"), params("acc1"))).json();
    expect(json.data.publishedSource).toBe("local");
    expect(json.data.notice).toMatch(/qayta ulang/);
    expect(json.data.items).toEqual([expect.objectContaining({ key: "post:pub", permalink: "https://instagram.com/p/x", imageUrl: "https://b/k/m1.t" })]);
  });

  it("another workspace's account is 404", async () => {
    mocks.workspaceContext.mockResolvedValue(ctx("OWNER", "other"));
    expect((await feedRoute(get("accounts/acc1/feed"), params("acc1"))).status).toBe(404);
    expect((await bestTimesRoute(get("accounts/acc1/best-times"), params("acc1"))).status).toBe(404);
  });
});

describe("best times (FR-S7)", () => {
  it("≥ 100 followers → online_followers averaged into the workspace zone", async () => {
    routes["/me"] = () => ({ body: { id: "app1", username: "jamalxann", followers_count: 250 } });
    // Two days; hour 7 (Pacific day start) is the peak. end_time 07:00 UTC = midnight PDT.
    routes["/ig1/insights?online_followers"] = () => ({
      body: {
        data: [
          {
            name: "online_followers",
            values: [
              { end_time: "2026-10-20T07:00:00+0000", value: { ...Object.fromEntries(Array.from({ length: 24 }, (_, h) => [String(h), 10])), "7": 90 } },
              { end_time: "2026-10-21T07:00:00+0000", value: { ...Object.fromEntries(Array.from({ length: 24 }, (_, h) => [String(h), 10])), "7": 30 } },
            ],
          },
        ],
      },
    });
    const res = await bestTimesRoute(get("accounts/acc1/best-times"), params("acc1"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ source: "online_followers", sample: 2, followers: 250, timezone: "Asia/Tashkent" });
    expect(json.data.scores).toHaveLength(7);
    expect(json.data.scores[0]).toHaveLength(24);
    // Day 1 starts 2026-10-19T07:00Z (Monday); hour 7 → 14:00Z → 19:00 Tashkent Monday.
    expect(json.data.top[0]).toEqual({ weekday: 0, hour: 19, score: 1 });
    const insight = calls.find((c) => c.searchParams.get("metric") === "online_followers")!;
    expect(insight.hostname).toBe("graph.instagram.com");
    expect(insight.searchParams.get("period")).toBe("lifetime");
    expect(Number(insight.searchParams.get("until")) - Number(insight.searchParams.get("since"))).toBe(29 * 86_400);
  });

  it("< 100 followers → own posts of the last 90 days by reach", async () => {
    routes["/me"] = () => ({ body: { id: "app1", username: "jamalxann", followers_count: 40 } });
    // 6 posts at 19:00 Tashkent on Fridays (14:00Z), one low post at 09:00, one 120 days ago (ignored).
    const friday = Date.parse("2026-10-23T14:00:00Z");
    const media = [
      ...Array.from({ length: 5 }, (_, i) => ({ id: `f${i}`, media_type: "IMAGE", timestamp: new Date(friday - i * 7 * DAY).toISOString(), like_count: 1, comments_count: 0 })),
      { id: "low", media_type: "IMAGE", timestamp: "2026-10-21T04:00:00Z", like_count: 1, comments_count: 0 },
      { id: "old", media_type: "IMAGE", timestamp: new Date(friday - 120 * DAY).toISOString(), like_count: 999, comments_count: 0 },
    ];
    routes["/ig1/media"] = () => ({ body: { data: media } });
    for (const m of media) routes[`/${m.id}/insights?reach`] = () => ({ body: { data: [{ name: "reach", values: [{ value: m.id === "low" ? 10 : 500 }] }] } });
    const json = await (await bestTimesRoute(get("accounts/acc1/best-times?fresh=1"), params("acc1"))).json();
    expect(json.data).toMatchObject({ source: "own_posts", metric: "reach", sample: 6 });
    expect(json.data.top[0]).toMatchObject({ weekday: 4, hour: 19, score: 1 });
    expect(calls.some((c) => c.searchParams.get("metric") === "online_followers")).toBe(false);
  });

  it("falls back to likes + comments when reach is not allowed", async () => {
    routes["/me"] = () => ({ body: { id: "app1", username: "jamalxann", followers_count: 40 } });
    routes["/ig1/media"] = () => ({ body: { data: Array.from({ length: 5 }, (_, i) => ({ id: `p${i}`, media_type: "IMAGE", timestamp: new Date(Date.now() - (i + 1) * DAY).toISOString(), like_count: 3, comments_count: 1 })) } });
    const json = await (await bestTimesRoute(get("accounts/acc1/best-times"), params("acc1"))).json();
    expect(json.data).toMatchObject({ source: "own_posts", metric: "engagement", sample: 5 });
  });

  it("too little data → source none with \"Ma'lumot yetarli emas\", and the answer is cached", async () => {
    routes["/me"] = () => ({ body: { id: "app1", username: "jamalxann", followers_count: 12 } });
    routes["/ig1/media"] = () => ({ body: { data: igMedia(2) } });
    const json = await (await bestTimesRoute(get("accounts/acc1/best-times"), params("acc1"))).json();
    expect(json.data).toMatchObject({ source: "none", scores: null, top: [] });
    expect(json.data.reason).toMatch(/Ma'lumot yetarli emas/);
    const before = calls.length;
    await bestTimesRoute(get("accounts/acc1/best-times"), params("acc1"));
    expect(calls.length).toBe(before);
  });

  it("a broken token is explained, not a 500", async () => {
    routes["/me"] = () => metaError(190, "expired");
    routes["/ig1/media"] = () => metaError(190, "expired");
    const res = await bestTimesRoute(get("accounts/acc1/best-times"), params("acc1"));
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ source: "none" });
    expect(json.data.reason).toMatch(/qayta ulang/);
  });
});

describe("grid helpers", () => {
  it("zonedWeekHour is Monday-first in the zone", () => {
    expect(zonedWeekHour(new Date("2026-10-25T20:00:00Z"), "Asia/Tashkent")).toEqual({ weekday: 0, hour: 1 }); // Mon 01:00
    expect(zonedWeekHour(new Date("2026-10-25T20:00:00Z"), "UTC")).toEqual({ weekday: 6, hour: 20 });
  });

  it("gridFromPosts spreads half weight to the neighbouring hours, wrapping the day", () => {
    const grid = gridFromPosts([{ at: new Date("2026-10-25T23:30:00Z"), value: 10 }], "UTC"); // Sunday 23:xx
    expect(grid[6][23]).toBe(1);
    expect(grid[6][22]).toBe(0.5);
    expect(grid[0][0]).toBe(0.5);
    expect(topCells(grid, 5)).toHaveLength(3);
  });

  it("gridFromOnlineFollowers ignores empty days", () => {
    expect(gridFromOnlineFollowers([], "UTC")).toBeNull();
    expect(gridFromOnlineFollowers([{ endTime: "2026-10-20T07:00:00+0000", hours: {} }], "UTC")).toBeNull();
  });
});
