/**
 * ETAP 13 Faza 2 — the import / AI routes: permissions (import = schedule
 * permission, AI caption = create), kill switch, the template download, and
 * the preview → commit round trip through the routes.
 */
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({ developerSession: vi.fn(), workspaceContext: vi.fn() }));

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
vi.mock("@/lib/content/quota", () => ({ accountQuota: vi.fn(async () => ({ used: 0, total: 50, scheduledNext24h: 0, resetsAt: null, source: "cache" })), quotaWindowFull: () => false }));
vi.mock("@/lib/content/storage", () => ({
  getStorage: () => ({ presignGet: async (key: string) => `https://b/${key}`, putObject: async () => undefined, headObject: async () => null, deleteObject: async () => undefined }),
  mediaKey: (ws: string, ext: string) => `ws/${ws}/x.${ext}`,
}));

import { POST as previewRoute } from "@/app/api/developer/content/import/csv/route";
import { POST as commitRoute } from "@/app/api/developer/content/import/csv/commit/route";
import { GET as templateRoute } from "@/app/api/developer/content/import/csv/template/route";
import { POST as captionRoute } from "@/app/api/developer/content/ai/caption/route";
import { type LLMProvider, setLlmProviderForTests } from "@/lib/assistant/llm/provider";

const WS = "ws1";
const ctx = (role: string) => ({ userId: "u1", workspaceId: WS, workspace: { id: WS, name: "W", timezone: "Asia/Tashkent" }, role });
const req = (path: string, body?: unknown) => new NextRequest(`http://localhost/api/developer/content/${path}`, { method: body === undefined ? "GET" : "POST", ...(body !== undefined ? { body: JSON.stringify(body), headers: { "content-type": "application/json" } } : {}) });
// A date a few days ahead in Tashkent (the time rules need now + 5 min … now + 1 year).
const DAY = new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10);
const CSV = `text,date,time,account,type,media_url_1,draft\nSalom,${DAY},19:00,jamalxann,POST,https://x.uz/a.jpg,0\nBad,${DAY},19:00,nobody,POST,https://x.uz/a.jpg,0\n`;

beforeEach(() => {
  resetDb();
  vi.unstubAllEnvs();
  setLlmProviderForTests(undefined);
  mocks.developerSession.mockResolvedValue({ email: "dev@x" });
  mocks.workspaceContext.mockResolvedValue(ctx("MANAGER"));
  db.seed("workspace", { id: WS, name: "W", ownerId: "u1", timezone: "Asia/Tashkent" });
  db.seed("instagramAccount", { id: "acc1", workspaceId: WS, instagramId: "ig1", username: "jamalxann", accessToken: "t", tokenStatus: "ACTIVE", canPublish: true });
});

describe("CSV import routes", () => {
  it("preview answers rows with errors and writes nothing", async () => {
    const res = await previewRoute(req("import/csv", { csv: CSV }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.rows.map((r: { row: number; errors: string[] }) => [r.row, r.errors.length > 0])).toEqual([[2, false], [3, true]]);
    expect(db.rows("scheduledPost")).toHaveLength(0);
  });

  it("commit refuses a ticked row that still has an error (400) and imports nothing", async () => {
    const res = await commitRoute(req("import/csv/commit", { csv: CSV, rows: [2, 3] }));
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/Xatoli qatorlar import qilinmaydi: 3/);
    expect(db.rows("scheduledPost")).toHaveLength(0);
  });

  it("OPERATOR and VIEWER cannot import (schedule permission); OPERATOR may download the template", async () => {
    mocks.workspaceContext.mockResolvedValue(ctx("OPERATOR"));
    expect((await previewRoute(req("import/csv", { csv: CSV }))).status).toBe(403);
    expect((await commitRoute(req("import/csv/commit", { csv: CSV, rows: [2] }))).status).toBe(403);
    const tpl = await templateRoute();
    expect(tpl.status).toBe(200);
    expect(tpl.headers.get("content-type")).toMatch(/text\/csv/);
    const bytes = new Uint8Array(await tpl.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]); // UTF-8 BOM for Excel
    const text = new TextDecoder().decode(bytes);
    expect(text).toMatch(/@jamalxann/);
    mocks.workspaceContext.mockResolvedValue(ctx("VIEWER"));
    expect((await previewRoute(req("import/csv", { csv: CSV }))).status).toBe(403);
  });

  it("non-JSON and empty bodies are 400", async () => {
    const bad = new NextRequest("http://localhost/api/developer/content/import/csv", { method: "POST", body: "text,date", headers: { "content-type": "text/csv" } });
    expect((await previewRoute(bad)).status).toBe(400);
    expect((await previewRoute(req("import/csv", { csv: "" }))).status).toBe(400);
  });

  it("kill switch: 404", async () => {
    vi.stubEnv("CONTENT_SCHEDULER_DISABLED", "1");
    expect((await previewRoute(req("import/csv", { csv: CSV }))).status).toBe(404);
    expect((await templateRoute()).status).toBe(404);
    expect((await captionRoute(req("ai/caption", { topic: "Yangi divan" }))).status).toBe(404);
  });
});

describe("AI caption route", () => {
  const fake: LLMProvider = {
    name: "fake",
    model: "fake",
    costUsd: () => 0,
    complete: async () => ({ json: { variants: ["A", "B", "C"], hashtags: ["mebel"] }, inputTokens: 1, outputTokens: 1, model: "fake", latencyMs: 1 }),
  };

  it("OPERATOR may generate; VIEWER may not", async () => {
    setLlmProviderForTests(fake);
    mocks.workspaceContext.mockResolvedValue(ctx("OPERATOR"));
    const ok = await captionRoute(req("ai/caption", { topic: "Yangi divan", tone: "sales", language: "ru" }));
    expect(ok.status).toBe(200);
    expect((await ok.json()).data).toMatchObject({ variants: ["A", "B", "C"], hashtags: ["mebel"] });
    mocks.workspaceContext.mockResolvedValue(ctx("VIEWER"));
    expect((await captionRoute(req("ai/caption", { topic: "Yangi divan" }))).status).toBe(403);
  });

  it("bad input is a 400 before any model call", async () => {
    expect((await captionRoute(req("ai/caption", { topic: "x" }))).status).toBe(400);
    expect((await captionRoute(req("ai/caption", { topic: "Yangi divan", tone: "angry" }))).status).toBe(400);
  });
});
