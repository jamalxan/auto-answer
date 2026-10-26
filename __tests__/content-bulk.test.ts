/**
 * ETAP 13 Faza 2 (WP-D) — calendar drag-and-drop moves (FR-S6) and bulk
 * actions (FR-V4) through the API on the in-memory DB.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  developerSession: vi.fn(),
  workspaceContext: vi.fn(),
  quotaFull: vi.fn(() => false),
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
  quotaWindowFull: mocks.quotaFull,
}));
vi.mock("@/lib/content/storage", () => ({
  getStorage: () => ({ presignGet: async (key: string) => `https://b/${key}` }),
  isStorageConfigured: () => true,
  getStorageDriverName: () => "local",
}));
vi.mock("@/lib/telegram/notify", () => ({ getWorkspaceChats: async () => [], alertWorkspace: vi.fn() }));
vi.mock("@/lib/telegram/api", () => ({ isTelegramConfigured: () => false, sendTelegramMessage: vi.fn() }));
vi.mock("@/lib/email", () => ({ sendEmail: vi.fn(async () => undefined) }));

import { POST as actionRoute } from "@/app/api/content/posts/[id]/[action]/route";
import { POST as bulkRoute } from "@/app/api/content/posts/bulk/route";
import { shiftInstant } from "@/lib/content/bulk";

const WS = "ws1";
const HOUR = 3_600_000;
const ctx = (role: string, workspaceId = WS) => ({ userId: "u1", workspaceId, workspace: { id: workspaceId, name: "W", timezone: "Asia/Tashkent" }, role });
const req = (path: string, body: unknown) =>
  new NextRequest(`http://localhost/api/content/${path}`, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
const params = <T extends Record<string, string>>(p: T) => ({ params: Promise.resolve(p) });

function seedPost(id: string, status: string, scheduledAt: Date | null, extra: Record<string, unknown> = {}) {
  db.seed("scheduledPost", { id, workspaceId: WS, instagramAccountId: "acc1", type: "FEED_IMAGE", status, scheduledAt, caption: "Salom", timezone: "Asia/Tashkent", autoPublish: true, attempts: status === "SCHEDULED" ? 1 : 0, version: 1, ...extra });
  db.seed("scheduledPostMedia", { id: `pm-${id}`, postId: id, mediaId: "m1", position: 0, userTags: [] });
}

const move = (id: string, scheduledAt: string) => actionRoute(req(`posts/${id}/move`, { scheduledAt }), params({ id, action: "move" }));

beforeEach(() => {
  resetDb();
  mocks.quotaFull.mockReturnValue(false);
  mocks.developerSession.mockResolvedValue({ email: "dev@x" });
  mocks.workspaceContext.mockResolvedValue(ctx("MANAGER"));
  db.seed("workspace", { id: WS, name: "W", ownerId: "u1", timezone: "Asia/Tashkent" });
  db.seed("instagramAccount", { id: "acc1", workspaceId: WS, instagramId: "ig1", username: "jamalxann", accessToken: "t", tokenStatus: "ACTIVE", canPublish: true });
  db.seed("mediaAsset", { id: "m1", workspaceId: WS, kind: "IMAGE", originalKey: "k/m1", preparedKey: "k/m1.p", thumbKey: "k/m1.t", mimeType: "image/jpeg", sizeBytes: 1000, width: 1080, height: 1350, status: "READY" });
});

describe("move (FR-S6)", () => {
  it("re-schedules a SCHEDULED post through schedulePost and re-arms its jobs", async () => {
    seedPost("p1", "SCHEDULED", new Date(Date.now() + 2 * HOUR));
    const to = new Date(Date.now() + 26 * HOUR);
    const res = await move("p1", to.toISOString());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.status).toBe("SCHEDULED");
    expect(new Date(json.data.scheduledAt).getTime()).toBe(to.getTime());
    expect(db.rows("scheduledPost")[0].attempts).toBe(2);
  });

  it("keeps the 5-minute lead rule and the quota for SCHEDULED posts", async () => {
    seedPost("p1", "SCHEDULED", new Date(Date.now() + 2 * HOUR));
    const tooSoon = await move("p1", new Date(Date.now() + 60_000).toISOString());
    expect(tooSoon.status).toBe(400);
    expect((await tooSoon.json()).error).toMatch(/5 daqiqa/);
    mocks.quotaFull.mockReturnValue(true);
    const full = await move("p1", new Date(Date.now() + 5 * HOUR).toISOString());
    expect(full.status).toBe(409);
  });

  it("moves a SCHEDULED post two minutes on when the minute is taken (FR-S4)", async () => {
    const slot = new Date(Math.ceil((Date.now() + 3 * HOUR) / 60_000) * 60_000);
    seedPost("p1", "SCHEDULED", new Date(Date.now() + 2 * HOUR));
    seedPost("p2", "SCHEDULED", slot);
    const json = await (await move("p1", slot.toISOString())).json();
    expect(new Date(json.data.scheduledAt).getTime()).toBe(slot.getTime() + 2 * 60_000);
  });

  it("moves only the plan of a DRAFT — it stays a draft", async () => {
    seedPost("d1", "DRAFT", new Date(Date.now() + 2 * HOUR));
    const to = new Date(Date.now() + 50 * HOUR);
    mocks.workspaceContext.mockResolvedValue(ctx("OPERATOR"));
    const res = await move("d1", to.toISOString());
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data.status).toBe("DRAFT");
    expect(new Date(json.data.scheduledAt).getTime()).toBe(to.getTime());
    expect(json.data.version).toBe(2);
  });

  it("OPERATOR cannot move a SCHEDULED post; VIEWER cannot move anything", async () => {
    seedPost("p1", "SCHEDULED", new Date(Date.now() + 2 * HOUR));
    mocks.workspaceContext.mockResolvedValue(ctx("OPERATOR"));
    expect((await move("p1", new Date(Date.now() + 5 * HOUR).toISOString())).status).toBe(403);
    mocks.workspaceContext.mockResolvedValue(ctx("VIEWER"));
    expect((await move("p1", new Date(Date.now() + 5 * HOUR).toISOString())).status).toBe(403);
  });

  it("refuses in-flight and published posts, and foreign ids are 404", async () => {
    seedPost("x1", "PUBLISHED", new Date(Date.now() - HOUR));
    expect((await move("x1", new Date(Date.now() + 5 * HOUR).toISOString())).status).toBe(409);
    mocks.workspaceContext.mockResolvedValue(ctx("OWNER", "other"));
    seedPost("p1", "SCHEDULED", new Date(Date.now() + 2 * HOUR));
    expect((await move("p1", new Date(Date.now() + 5 * HOUR).toISOString())).status).toBe(404);
  });
});

describe("shiftInstant", () => {
  it("days keep the wall-clock time; minutes and hours are exact", () => {
    const at = new Date("2026-11-03T14:00:00.000Z"); // 19:00 Tashkent
    expect(shiftInstant(at, 2, "days", "Asia/Tashkent").toISOString()).toBe("2026-11-05T14:00:00.000Z");
    expect(shiftInstant(at, -30, "minutes", "Asia/Tashkent").toISOString()).toBe("2026-11-03T13:30:00.000Z");
    expect(shiftInstant(at, 3, "hours", "Asia/Tashkent").toISOString()).toBe("2026-11-03T17:00:00.000Z");
    // New York DST ends 2026-11-01: 09:00 local stays 09:00 local.
    expect(shiftInstant(new Date("2026-10-31T13:00:00.000Z"), 2, "days", "America/New_York").toISOString()).toBe("2026-11-02T14:00:00.000Z");
  });
});

describe("bulk (FR-V4)", () => {
  const bulk = (body: unknown) => bulkRoute(req("posts/bulk", body));

  it("shifts several posts, reports each one, and partial failures are listed", async () => {
    const base = Math.ceil((Date.now() + 3 * HOUR) / 60_000) * 60_000;
    seedPost("a", "SCHEDULED", new Date(base));
    seedPost("b", "SCHEDULED", new Date(base + 60 * 60_000));
    seedPost("c", "DRAFT", null);
    seedPost("d", "PUBLISHED", new Date(Date.now() - HOUR));
    const res = await bulk({ action: "shift", ids: ["a", "b", "c", "d", "nope"], amount: 1, unit: "hours" });
    const json = await res.json();
    expect(res.status).toBe(200);
    expect(json.data).toMatchObject({ action: "shift", done: 2, failed: 3 });
    const byId = Object.fromEntries(json.data.results.map((r: { id: string }) => [r.id, r]));
    expect(new Date(byId.a.scheduledAt).getTime()).toBe(base + HOUR);
    // b moved first (forward shift = far end first), so a lands on b's old slot without a spacing bump.
    expect(new Date(byId.b.scheduledAt).getTime()).toBe(base + 2 * HOUR);
    expect(byId.c).toMatchObject({ ok: false, error: expect.stringMatching(/vaqt yo'q/) });
    expect(byId.d).toMatchObject({ ok: false });
    expect(byId.nope).toMatchObject({ ok: false, error: "Post topilmadi" });
  });

  it("an OPERATOR's shift moves drafts but reports SCHEDULED posts as forbidden", async () => {
    seedPost("a", "SCHEDULED", new Date(Date.now() + 3 * HOUR));
    seedPost("d", "DRAFT", new Date(Date.now() + 3 * HOUR));
    mocks.workspaceContext.mockResolvedValue(ctx("OPERATOR"));
    const json = await (await bulk({ action: "shift", ids: ["a", "d"], amount: 1, unit: "days" })).json();
    expect(json.data.done).toBe(1);
    expect(json.data.results.find((r: { id: string }) => r.id === "a").error).toMatch(/Ruxsat/);
  });

  it("pause and delete are MANAGER+; other workspaces' ids are not found", async () => {
    seedPost("a", "SCHEDULED", new Date(Date.now() + 3 * HOUR));
    seedPost("b", "DRAFT", null);
    db.seed("scheduledPost", { id: "f", workspaceId: "other", instagramAccountId: "acc9", type: "FEED_IMAGE", status: "SCHEDULED", scheduledAt: new Date(Date.now() + HOUR), version: 1 });
    mocks.workspaceContext.mockResolvedValue(ctx("OPERATOR"));
    expect((await bulk({ action: "pause", ids: ["a"] })).status).toBe(403);
    expect((await bulk({ action: "delete", ids: ["a"] })).status).toBe(403);
    mocks.workspaceContext.mockResolvedValue(ctx("MANAGER"));
    const paused = await (await bulk({ action: "pause", ids: ["a", "b", "f"] })).json();
    expect(paused.data).toMatchObject({ done: 1, failed: 2 });
    expect(paused.data.results.find((r: { id: string }) => r.id === "f").error).toBe("Post topilmadi");
    const deleted = await (await bulk({ action: "delete", ids: ["a", "b", "f"] })).json();
    expect(deleted.data).toMatchObject({ done: 2, failed: 1 });
    expect(db.rows("scheduledPost").find((r) => r.id === "f")?.deletedAt).toBeFalsy();
  });

  it("sends drafts with a planned time to review, reports those without one", async () => {
    db.seed("workspaceMember", { id: "wm2", workspaceId: WS, userId: "u2", role: "MANAGER" });
    db.seed("user", { id: "u2", email: "boss@x", name: "Boss" });
    seedPost("a", "DRAFT", new Date(Date.now() + 5 * HOUR));
    seedPost("b", "DRAFT", null);
    mocks.workspaceContext.mockResolvedValue(ctx("OPERATOR"));
    const json = await (await bulk({ action: "review", ids: ["a", "b"], reviewerUserIds: ["u2"] })).json();
    expect(json.data).toMatchObject({ done: 1, failed: 1 });
    expect(db.rows("scheduledPost").find((r) => r.id === "a")?.status).toBe("PENDING_REVIEW");
  });

  it("validates the body: unknown action, empty or > 100 ids", async () => {
    expect((await bulk({ action: "explode", ids: ["a"] })).status).toBe(400);
    expect((await bulk({ action: "pause", ids: [] })).status).toBe(400);
    const many = Array.from({ length: 101 }, (_, i) => `id${i}`);
    const res = await bulk({ action: "pause", ids: many });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/100/);
  });

  it("answers 401 without an app session", async () => {
    mocks.workspaceContext.mockResolvedValue(null);
    expect((await bulk({ action: "pause", ids: ["a"] })).status).toBe(401);
  });
});
