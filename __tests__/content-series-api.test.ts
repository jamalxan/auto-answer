/**
 * ETAP 13 Faza 2 — routes of series and slots: `recur`, `queue`,
 * `delete-series-future`, `apply-to-series`, GET/PUT accounts/[id]/slots —
 * roles (OPERATOR cannot recur / queue / edit slots) and tenant isolation.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  developerSession: vi.fn(),
  workspaceContext: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: vi.fn() }));
vi.mock("@/lib/developer/auth", () => ({ getDeveloperSession: mocks.developerSession }));
vi.mock("@/lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mocks.workspaceContext,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
  canManageBilling: (role: string) => role === "OWNER",
  hasWorkspaceRole: () => true,
}));
vi.mock("@/lib/content/queue", () => ({
  schedulePrepare: vi.fn(async () => undefined),
  schedulePublish: vi.fn(async () => undefined),
  scheduleManualNotify: vi.fn(async () => undefined),
  removePostJobs: vi.fn(async () => undefined),
  enqueueMediaProcess: vi.fn(async () => undefined),
  contentQueueCounts: vi.fn(async () => null),
}));
vi.mock("@/lib/content/quota", () => ({
  accountQuota: vi.fn(async () => ({ used: 0, total: 50, scheduledNext24h: 0, resetsAt: null, source: "cache" })),
  quotaWindowFull: () => false,
}));
vi.mock("@/lib/content/storage", () => ({
  getStorage: () => ({ presignGet: async (key: string) => `https://b/${key}`, headObject: async () => ({ size: 1000 }), deleteObject: async () => undefined }),
  mediaKey: (ws: string, ext: string) => `ws/${ws}/2026/10/x.${ext}`,
  isStorageConfigured: () => true,
  getStorageDriverName: () => "local",
}));

import { POST as actionRoute } from "@/app/api/content/posts/[id]/[action]/route";
import { GET as slotsGet, PUT as slotsPut } from "@/app/api/content/accounts/[id]/slots/route";

const WS = "ws1";
const ctx = (role: string, workspaceId = WS) => ({ userId: "u1", workspaceId, workspace: { id: workspaceId, name: "W", timezone: "Asia/Tashkent" }, role });
const req = (method: string, path: string, body?: unknown) =>
  new NextRequest(`http://localhost/api/content/${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const act = (id: string, action: string, body: unknown = {}) => actionRoute(req("POST", `posts/${id}/${action}`, body), params({ id, action }));

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);
const rule = () => ({ frequency: "daily", startDate: day(2), time: "19:00", until: day(4) });

beforeEach(() => {
  resetDb();
  mocks.developerSession.mockResolvedValue({ email: "dev@x" });
  mocks.workspaceContext.mockResolvedValue(ctx("MANAGER"));
  db.seed("workspace", { id: WS, name: "W", ownerId: "u1" });
  db.seed("workspace", { id: "other", name: "O", ownerId: "u9" });
  db.seed("instagramAccount", { id: "acc1", workspaceId: WS, instagramId: "ig1", username: "jamalxann", accessToken: "t", tokenStatus: "ACTIVE", canPublish: true });
  db.seed("instagramAccount", { id: "acc9", workspaceId: "other", instagramId: "ig9", username: "foreign", accessToken: "t", tokenStatus: "ACTIVE", canPublish: true });
  db.seed("mediaAsset", { id: "m1", workspaceId: WS, kind: "IMAGE", originalKey: "k/m1", preparedKey: "k/m1.p", thumbKey: "k/m1.t", mimeType: "image/jpeg", sizeBytes: 1000, width: 1080, height: 1350, status: "READY" });
  db.seed("scheduledPost", { id: "p1", workspaceId: WS, instagramAccountId: "acc1", type: "FEED_IMAGE", status: "DRAFT", caption: "Salom" });
  db.seed("scheduledPostMedia", { postId: "p1", mediaId: "m1", position: 0 });
  db.seed("scheduledPost", { id: "fx", workspaceId: "other", instagramAccountId: "acc9", type: "FEED_IMAGE", status: "DRAFT" });
});

describe("recur and series actions", () => {
  it("MANAGER recurs a draft: 3 copies scheduled, a report comes back", async () => {
    const res = await act("p1", "recur", rule());
    const json = await res.json();
    expect(json.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(json.data.total).toBe(3);
    expect(json.data.failed).toEqual([]);
    expect(db.rows("scheduledPost").filter((r) => r.seriesId === json.data.seriesId)).toHaveLength(3);
  });

  it("a bad rule is a 400 with the Uzbek reason", async () => {
    const res = await act("p1", "recur", { ...rule(), until: day(400) });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/180 kun/);
    expect((await act("p1", "recur", { frequency: "hourly" })).status).toBe(400);
  });

  it("OPERATOR cannot recur, queue or delete future copies; may apply texts to the series", async () => {
    mocks.workspaceContext.mockResolvedValue(ctx("OPERATOR"));
    expect((await act("p1", "recur", rule())).status).toBe(403);
    expect((await act("p1", "queue")).status).toBe(403);
    expect((await act("p1", "delete-series-future")).status).toBe(403);
    // p1 is not in a series: allowed through the guard, refused by the service.
    expect((await act("p1", "apply-to-series")).status).toBe(400);
  });

  it("a foreign post is a 404 for every series action", async () => {
    for (const action of ["recur", "queue", "delete-series-future", "apply-to-series"]) {
      const res = await act("fx", action, action === "recur" ? rule() : {});
      expect(res.status, action).toBe(404);
    }
  });

  it("queue without slots is a 409, with a slot it schedules", async () => {
    expect((await act("p1", "queue")).status).toBe(409);
    const put = await slotsPut(req("PUT", "accounts/acc1/slots", { slots: [0, 1, 2, 3, 4, 5, 6].map((weekday) => ({ weekday, minuteOfDay: 19 * 60 })) }), params({ id: "acc1" }));
    expect(put.status).toBe(200);
    const res = await act("p1", "queue");
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.status).toBe("SCHEDULED");
    expect(new Date(json.data.scheduledAt).getUTCHours()).toBe(14);
  });
});

describe("slots routes", () => {
  const body = { slots: [{ weekday: 0, minuteOfDay: 540 }, { weekday: 4, minuteOfDay: 1140, postType: "REEL" }] };

  it("PUT replaces and GET reads back in the workspace zone", async () => {
    const put = await slotsPut(req("PUT", "accounts/acc1/slots", body), params({ id: "acc1" }));
    expect(put.status).toBe(200);
    const res = await slotsGet(req("GET", "accounts/acc1/slots"), params({ id: "acc1" }));
    const json = await res.json();
    expect(json.data.timezone).toBe("Asia/Tashkent");
    expect(json.data.slots.map((s: { weekday: number; minuteOfDay: number; postType: string | null }) => [s.weekday, s.minuteOfDay, s.postType])).toEqual([
      [0, 540, null],
      [4, 1140, "REEL"],
    ]);
  });

  it("validates the body", async () => {
    expect((await slotsPut(req("PUT", "accounts/acc1/slots", { slots: [{ weekday: 7, minuteOfDay: 0 }] }), params({ id: "acc1" }))).status).toBe(400);
    expect((await slotsPut(req("PUT", "accounts/acc1/slots", { slots: [{ weekday: 0, minuteOfDay: 1440 }] }), params({ id: "acc1" }))).status).toBe(400);
  });

  it("OPERATOR reads but cannot PUT; VIEWER reads", async () => {
    mocks.workspaceContext.mockResolvedValue(ctx("OPERATOR"));
    expect((await slotsGet(req("GET", "accounts/acc1/slots"), params({ id: "acc1" }))).status).toBe(200);
    expect((await slotsPut(req("PUT", "accounts/acc1/slots", body), params({ id: "acc1" }))).status).toBe(403);
    mocks.workspaceContext.mockResolvedValue(ctx("VIEWER"));
    expect((await slotsGet(req("GET", "accounts/acc1/slots"), params({ id: "acc1" }))).status).toBe(200);
  });

  it("a foreign account is a 404 on GET and PUT", async () => {
    expect((await slotsGet(req("GET", "accounts/acc9/slots"), params({ id: "acc9" }))).status).toBe(404);
    expect((await slotsPut(req("PUT", "accounts/acc9/slots", body), params({ id: "acc9" }))).status).toBe(404);
    expect(db.rows("postingSlot")).toHaveLength(0);
  });
});
