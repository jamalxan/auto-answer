/**
 * ETAP 13 Faza 2 — approval routes: posts/[id]/review · decision · notes,
 * GET reviews?tab=, the meta reviewer list, and the sessionless
 * /api/content/reviews/[token] (404 on a bad token or the module off).
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  developerSession: vi.fn(),
  workspaceContext: vi.fn(),
  sendEmail: vi.fn<(input: { to: string; subject: string; text: string }) => Promise<void>>(async () => undefined),
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
vi.mock("@/lib/telegram/notify", () => ({ getWorkspaceChats: async () => [], alertWorkspace: vi.fn() }));
vi.mock("@/lib/telegram/api", () => ({ isTelegramConfigured: () => false, sendMessage: vi.fn(), esc: (v: string) => v }));
vi.mock("@/lib/email", () => ({ sendEmail: mocks.sendEmail }));

import { GET as publicGet, POST as publicPost } from "@/app/api/content/reviews/[token]/route";
import { GET as metaRoute } from "@/app/api/content/meta/route";
import { GET as actionGet, POST as actionRoute } from "@/app/api/content/posts/[id]/[action]/route";
import { POST as createRoute } from "@/app/api/content/posts/route";
import { GET as reviewsRoute } from "@/app/api/content/reviews/route";

const WS = "ws1";
const ctx = (role: string, userId = "op", workspaceId = WS) => ({ userId, workspaceId, workspace: { id: workspaceId, name: "W", timezone: "Asia/Tashkent" }, role });
const req = (method: string, path: string, body?: unknown) =>
  new NextRequest(`http://localhost/api/${path}`, { method, ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });
const as = (role: string, userId: string, ws = WS) => mocks.workspaceContext.mockResolvedValue(ctx(role, userId, ws));
const future = () => new Date(Date.now() + 3 * 3_600_000).toISOString();

beforeEach(() => {
  resetDb();
  vi.unstubAllEnvs();
  mocks.sendEmail.mockClear();
  mocks.developerSession.mockResolvedValue({ email: "dev@x" });
  as("OPERATOR", "op");
  db.seed("workspace", { id: WS, name: "W", ownerId: "owner" });
  db.seed("instagramAccount", { id: "acc1", workspaceId: WS, instagramId: "ig1", username: "jamalxann", accessToken: "t", tokenStatus: "ACTIVE", canPublish: true });
  db.seed("mediaAsset", { id: "m1", workspaceId: WS, kind: "IMAGE", originalKey: "k/m1", preparedKey: "k/m1.p", thumbKey: "k/m1.t", mimeType: "image/jpeg", sizeBytes: 1000, width: 1080, height: 1350, status: "READY" });
  for (const [userId, role] of [["op", "OPERATOR"], ["mgr", "MANAGER"]] as const) {
    db.seed("user", { id: userId, name: userId.toUpperCase(), email: `${userId}@x.uz` });
    db.seed("workspaceMember", { workspaceId: WS, userId, role });
  }
});

async function draftId(): Promise<string> {
  const res = await createRoute(req("POST", "developer/content/posts", { instagramAccountId: "acc1", type: "FEED_IMAGE", caption: "Salom", media: [{ mediaId: "m1" }] }));
  return (await res.json()).data.id;
}
const action = (id: string, name: string, body: unknown = {}) => actionRoute(req("POST", `developer/content/posts/${id}/${name}`, body), params({ id, action: name }));

describe("member flow", () => {
  it("OPERATOR submits, cannot decide; MANAGER approves → SCHEDULED", async () => {
    const id = await draftId();
    const sub = await action(id, "review", { reviewerUserIds: ["mgr"], externalEmails: [], rule: "ANY", scheduledAt: future() });
    expect(sub.status).toBe(200);
    expect((await sub.json()).data.status).toBe("PENDING_REVIEW");

    expect((await action(id, "decision", { decision: "APPROVED" })).status).toBe(403);

    as("MANAGER", "mgr");
    const mine = await (await reviewsRoute(req("GET", "developer/content/reviews?tab=mine"))).json();
    expect(mine.data.map((i: { id: string }) => i.id)).toEqual([id]);
    expect(mine.data[0].myReviewId).toBeTruthy();

    const res = await action(id, "decision", { decision: "APPROVED" });
    expect(res.status).toBe(200);
    expect((await res.json()).data.status).toBe("SCHEDULED");

    const summary = await (await actionGet(req("GET", `developer/content/posts/${id}/review`), params({ id, action: "review" }))).json();
    expect(summary.data.reviews).toHaveLength(1);
    expect(summary.data.reviews[0]).toMatchObject({ decision: "APPROVED", reviewerLabel: "MGR", current: true });
  });

  it("rejecting without a comment is 400; a VIEWER cannot submit", async () => {
    const id = await draftId();
    const date = new Date(Date.now() + 2 * 86_400_000).toISOString().slice(0, 10);
    expect((await action(id, "review", { reviewerUserIds: ["mgr"], rule: "ALL", scheduledAt: { date, time: "10:00", timezone: "Asia/Tashkent" } })).status).toBe(200);
    as("MANAGER", "mgr");
    expect((await action(id, "decision", { decision: "REJECTED" })).status).toBe(400);
    expect((await action(id, "decision", { decision: "REJECTED", comment: "Matnni qisqartiring" })).status).toBe(200);
    as("VIEWER", "v");
    expect((await action(id, "review", { reviewerUserIds: ["mgr"], scheduledAt: future() })).status).toBe(403);
  });

  it("another workspace gets 404 on every approval route", async () => {
    const id = await draftId();
    as("OWNER", "x", "ws2");
    expect((await action(id, "review", { reviewerUserIds: ["mgr"], scheduledAt: future() })).status).toBe(404);
    expect((await action(id, "decision", { decision: "APPROVED" })).status).toBe(404);
    expect((await action(id, "notes", { body: "x" })).status).toBe(404);
    expect((await actionGet(req("GET", `developer/content/posts/${id}/notes`), params({ id, action: "notes" }))).status).toBe(404);
    expect((await actionGet(req("GET", `developer/content/posts/${id}/review`), params({ id, action: "review" }))).status).toBe(404);
  });

  it("notes: POST then GET, unknown GET action 404", async () => {
    const id = await draftId();
    const created = await action(id, "notes", { body: "Rasm yorqinroq bo'lsin" });
    expect(created.status).toBe(201);
    const list = await (await actionGet(req("GET", `developer/content/posts/${id}/notes`), params({ id, action: "notes" }))).json();
    expect(list.data).toEqual([expect.objectContaining({ body: "Rasm yorqinroq bo'lsin", authorId: "op", authorLabel: "OP" })]);
    expect((await actionGet(req("GET", `developer/content/posts/${id}/schedule`), params({ id, action: "schedule" }))).status).toBe(404);
  });

  it("meta lists the approvers as reviewer candidates", async () => {
    const meta = await (await metaRoute()).json();
    expect(meta.data.reviewers.map((r: { userId: string }) => r.userId)).toEqual(["mgr"]);
  });
});

describe("public /api/content/reviews/[token]", () => {
  async function externalToken(): Promise<{ id: string; token: string }> {
    const id = await draftId();
    await action(id, "review", { reviewerUserIds: [], externalEmails: ["client@mail.uz"], rule: "ANY", scheduledAt: future() });
    const text = mocks.sendEmail.mock.calls.at(-1)?.[0].text ?? "";
    return { id, token: /review\/([A-Za-z0-9_-]+)/.exec(text)![1] };
  }

  it("previews and decides without a session", async () => {
    const { id, token } = await externalToken();
    mocks.developerSession.mockResolvedValue(null);
    mocks.workspaceContext.mockResolvedValue(null);
    const view = await publicGet(req("GET", `content/reviews/${token}`), params({ token }));
    expect(view.status).toBe(200);
    expect(view.headers.get("cache-control")).toBe("no-store");
    expect((await view.json()).data).toMatchObject({ state: "open", post: { caption: "Salom" } });
    const res = await publicPost(req("POST", `content/reviews/${token}`, { decision: "APPROVED" }), params({ token }));
    expect(res.status).toBe(200);
    expect((await res.json()).data.state).toBe("decided");
    expect(db.rows("scheduledPost").find((p) => p.id === id)!.status).toBe("SCHEDULED");
  });

  it("answers 404 for an unknown token and when the module is off", async () => {
    const { token } = await externalToken();
    expect((await publicGet(req("GET", "content/reviews/x"), params({ token: "x" }))).status).toBe(404);
    expect((await publicPost(req("POST", "content/reviews/x", { decision: "APPROVED" }), params({ token: "x" }))).status).toBe(404);
    vi.stubEnv("CONTENT_SCHEDULER_DISABLED", "1");
    expect((await publicGet(req("GET", `content/reviews/${token}`), params({ token }))).status).toBe(404);
  });
});
