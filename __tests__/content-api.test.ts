/**
 * ETAP 13 — the developer content API: guard (dev session, roles, kill
 * switch), the post routes end to end on the in-memory DB, tenant
 * isolation (AC-13, AC-14).
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
}));
vi.mock("@/lib/content/quota", () => ({
  accountQuota: vi.fn(async () => ({ used: 0, total: 50, scheduledNext24h: 0, resetsAt: null, source: "cache" })),
  quotaWindowFull: () => false,
}));
vi.mock("@/lib/content/storage", () => ({
  getStorage: () => ({
    presignGet: async (key: string) => `https://b/${key}`,
    presignPut: async (key: string) => ({ url: `https://b/${key}?put`, headers: {} }),
    headObject: async () => ({ size: 1000 }),
    deleteObject: async () => undefined,
  }),
  mediaKey: (ws: string, ext: string) => `ws/${ws}/2026/10/x.${ext}`,
  isStorageConfigured: () => true,
  getStorageDriverName: () => "local",
}));
vi.mock("@/lib/telegram/notify", () => ({ getWorkspaceChats: async () => [], alertWorkspace: vi.fn() }));
vi.mock("@/lib/telegram/api", () => ({ isTelegramConfigured: () => false }));

import { GET as metaRoute } from "@/app/api/developer/content/meta/route";
import { GET as listRoute, POST as createRoute } from "@/app/api/developer/content/posts/route";
import { DELETE as deleteRoute, GET as getRoute, PATCH as patchRoute } from "@/app/api/developer/content/posts/[id]/route";
import { POST as actionRoute } from "@/app/api/developer/content/posts/[id]/[action]/route";
import { POST as presignRoute } from "@/app/api/developer/content/media/presign/route";

const WS = "ws1";
const ctx = (role: string, workspaceId = WS) => ({ userId: "u1", workspaceId, workspace: { id: workspaceId, name: "W", timezone: "Asia/Tashkent" }, role });
const req = (method: string, path: string, body?: unknown) =>
  new NextRequest(`http://localhost/api/developer/content/${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
const params = (p: Record<string, string>) => ({ params: Promise.resolve(p) });

beforeEach(() => {
  resetDb();
  vi.unstubAllEnvs();
  mocks.developerSession.mockResolvedValue({ email: "dev@x" });
  mocks.workspaceContext.mockResolvedValue(ctx("MANAGER"));
  db.seed("workspace", { id: WS, name: "W", ownerId: "u1" });
  db.seed("instagramAccount", { id: "acc1", workspaceId: WS, instagramId: "ig1", username: "jamalxann", accessToken: "t", tokenStatus: "ACTIVE", canPublish: true });
  db.seed("mediaAsset", { id: "m1", workspaceId: WS, kind: "IMAGE", originalKey: "k/m1", preparedKey: "k/m1.p", thumbKey: "k/m1.t", mimeType: "image/jpeg", sizeBytes: 1000, width: 1080, height: 1350, status: "READY" });
});

const draftBody = { instagramAccountId: "acc1", type: "FEED_IMAGE", caption: "Salom", media: [{ mediaId: "m1" }] };

async function createDraft() {
  const res = await createRoute(req("POST", "posts", draftBody));
  const json = await res.json();
  return { res, post: json.data };
}

describe("guard", () => {
  it("answers 404 without a developer session", async () => {
    mocks.developerSession.mockResolvedValue(null);
    expect((await listRoute(req("GET", "posts"))).status).toBe(404);
  });

  it("answers 404 when the module is switched off", async () => {
    vi.stubEnv("CONTENT_SCHEDULER_DISABLED", "1");
    expect((await listRoute(req("GET", "posts"))).status).toBe(404);
  });

  it("VIEWER may read but not create", async () => {
    mocks.workspaceContext.mockResolvedValue(ctx("VIEWER"));
    expect((await listRoute(req("GET", "posts"))).status).toBe(200);
    expect((await createRoute(req("POST", "posts", draftBody))).status).toBe(403);
  });

  it("OPERATOR creates a draft but cannot schedule it (AC-13)", async () => {
    mocks.workspaceContext.mockResolvedValue(ctx("OPERATOR"));
    const { res, post } = await createDraft();
    expect(res.status).toBe(201);
    const sched = await actionRoute(req("POST", `posts/${post.id}/schedule`, { scheduledAt: new Date(Date.now() + 3_600_000).toISOString() }), params({ id: post.id, action: "schedule" }));
    expect(sched.status).toBe(403);
  });

  it("unknown action is a 404", async () => {
    const { post } = await createDraft();
    expect((await actionRoute(req("POST", `posts/${post.id}/explode`), params({ id: post.id, action: "explode" }))).status).toBe(404);
  });
});

describe("posts", () => {
  it("MANAGER schedules with a wall-clock time in the workspace zone", async () => {
    const { post } = await createDraft();
    // two days ahead, 19:00 Tashkent = 14:00 UTC
    const day = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    const res = await actionRoute(req("POST", `posts/${post.id}/schedule`, { scheduledAt: { date: day, time: "19:00", timezone: "Asia/Tashkent" } }), params({ id: post.id, action: "schedule" }));
    const json = await res.json();
    expect(json.error).toBeUndefined();
    expect(res.status).toBe(200);
    expect(json.data.status).toBe("SCHEDULED");
    expect(json.data.scheduledAt).toBe(`${day}T14:00:00.000Z`);
  });

  it("rejects a bad body with the first issue in Uzbek", async () => {
    const res = await createRoute(req("POST", "posts", { ...draftBody, type: "NOPE" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/type/);
  });

  it("PATCH with a stale version is a 409", async () => {
    const { post } = await createDraft();
    const ok = await patchRoute(req("PATCH", `posts/${post.id}`, { caption: "Yangi", version: 1 }), params({ id: post.id }));
    expect(ok.status).toBe(200);
    const stale = await patchRoute(req("PATCH", `posts/${post.id}`, { caption: "Eski", version: 1 }), params({ id: post.id }));
    expect(stale.status).toBe(409);
  });

  it("another workspace sees 404 on get, patch, action and delete (AC-14)", async () => {
    const { post } = await createDraft();
    mocks.workspaceContext.mockResolvedValue(ctx("OWNER", "other"));
    expect((await getRoute(req("GET", `posts/${post.id}`), params({ id: post.id }))).status).toBe(404);
    expect((await patchRoute(req("PATCH", `posts/${post.id}`, { caption: "x", version: 1 }), params({ id: post.id }))).status).toBe(404);
    expect((await actionRoute(req("POST", `posts/${post.id}/pause`), params({ id: post.id, action: "pause" }))).status).toBe(404);
    expect((await deleteRoute(req("DELETE", `posts/${post.id}`), params({ id: post.id }))).status).toBe(404);
  });

  it("list returns cards and honours filters", async () => {
    await createDraft();
    const res = await listRoute(req("GET", "posts?status=DRAFT"));
    const json = await res.json();
    expect(json.data.total).toBe(1);
    expect(json.data.items[0]).toMatchObject({ status: "DRAFT", accountUsername: "jamalxann" });
    const none = await (await listRoute(req("GET", "posts?status=PUBLISHED"))).json();
    expect(none.data.total).toBe(0);
  });

  it("delete is MANAGER+ and soft", async () => {
    const { post } = await createDraft();
    mocks.workspaceContext.mockResolvedValue(ctx("OPERATOR"));
    expect((await deleteRoute(req("DELETE", `posts/${post.id}`), params({ id: post.id }))).status).toBe(403);
    mocks.workspaceContext.mockResolvedValue(ctx("MANAGER"));
    expect((await deleteRoute(req("DELETE", `posts/${post.id}`), params({ id: post.id }))).status).toBe(200);
    expect(db.rows("scheduledPost")[0].deletedAt).toBeInstanceOf(Date);
  });
});

describe("meta and media", () => {
  it("meta lists accounts with canPublish, the role flags and the limits", async () => {
    const res = await metaRoute();
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.accounts[0]).toMatchObject({ id: "acc1", username: "jamalxann", canPublish: true, tokenStatus: "ACTIVE" });
    expect(json.data.me).toMatchObject({ canCreate: true, canSchedule: true });
    expect(json.data.limits.carouselMax).toBe(10);
    expect(json.data.telegramConnected).toBe(false);
  });

  it("presign is OPERATOR+ and validates the MIME type", async () => {
    mocks.workspaceContext.mockResolvedValue(ctx("OPERATOR"));
    const ok = await presignRoute(req("POST", "media/presign", { fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 1000 }));
    expect(ok.status).toBe(201);
    expect((await ok.json()).data.uploadUrl).toContain("?put");
    const bad = await presignRoute(req("POST", "media/presign", { fileName: "a.gif", mimeType: "image/gif", sizeBytes: 1000 }));
    expect(bad.status).toBe(400);
    mocks.workspaceContext.mockResolvedValue(ctx("VIEWER"));
    expect((await presignRoute(req("POST", "media/presign", { fileName: "a.jpg", mimeType: "image/jpeg", sizeBytes: 1000 }))).status).toBe(403);
  });
});
