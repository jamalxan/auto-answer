/**
 * ETAP 11 — the migration API's route plumbing: the guard matrix (VIEWER /
 * OPERATOR), the kill switch (503 on writes, reads and delete still work),
 * Uzbek 400 / 413 / 422, foreign ids 404, the ManyChat key never in a
 * response, the pure analyze-text route (no DB), and convert / import wiring.
 * The engine (lib/migration/service) is mocked: it has its own tests.
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const SECRET = "mcsecretapikey1234567890";

const mocks = vi.hoisted(() => ({
  developerSession: vi.fn(),
  workspaceContext: vi.fn(),
  findAccounts: vi.fn(),
  connect: vi.fn(),
  list: vi.fn(),
  get: vi.fn(),
  getItem: vi.fn(),
  analyze: vi.fn(),
  patch: vi.fn(),
  submitText: vi.fn(),
  convert: vi.fn(),
  importFlow: vi.fn(),
  importBasics: vi.fn(),
  remove: vi.fn(),
}));

vi.mock("../lib/developer/auth", () => ({ getDeveloperSession: mocks.developerSession }));
vi.mock("../lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mocks.workspaceContext,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));
vi.mock("../lib/db/client", () => ({ prisma: { instagramAccount: { findMany: mocks.findAccounts } } }));
// Real schemas and the real `run` façade; only the DB-touching functions are replaced.
vi.mock("../lib/migration/service", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/migration/service")>()),
  connectManychat: mocks.connect,
  listProjects: mocks.list,
  getProject: mocks.get,
  getItem: mocks.getItem,
  analyzeProject: mocks.analyze,
  patchItem: mocks.patch,
  submitFlowText: mocks.submitText,
  convertFlow: mocks.convert,
  importFlow: mocks.importFlow,
  importBasics: mocks.importBasics,
  deleteProject: mocks.remove,
}));

import { MigrationServiceError } from "../lib/migration/errors";
import { MAX_FLOW_TEXT, MAX_SCREENSHOT_BYTES, MAX_SCREENSHOTS } from "../lib/migration/config";
import { GET as metaGet } from "../app/api/migration/meta/route";
import { GET as listGet, POST as connectPost } from "../app/api/migration/projects/route";
import { DELETE as projectDelete, GET as projectGet } from "../app/api/migration/projects/[id]/route";
import { POST as analyzePost } from "../app/api/migration/projects/[id]/analyze/route";
import { POST as basicsPost } from "../app/api/migration/projects/[id]/import-basics/route";
import { PATCH as itemPatch } from "../app/api/migration/projects/[id]/items/[itemId]/route";
import { PUT as textPut } from "../app/api/migration/projects/[id]/items/[itemId]/text/route";
import { POST as analyzeTextPost } from "../app/api/migration/projects/[id]/items/[itemId]/analyze-text/route";
import { POST as convertPost } from "../app/api/migration/projects/[id]/items/[itemId]/convert/route";
import { POST as importPost } from "../app/api/migration/projects/[id]/items/[itemId]/import/route";

const project = { params: Promise.resolve({ id: "p1" }) };
const item = { params: Promise.resolve({ id: "p1", itemId: "i1" }) };

function req(method: string, body?: unknown, raw?: string): NextRequest {
  return new NextRequest("http://localhost/api/migration/x", {
    method,
    headers: { "content-type": "application/json" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
}

function as(role: string) {
  mocks.developerSession.mockResolvedValue({ ok: true });
  mocks.workspaceContext.mockResolvedValue({ workspaceId: "w1", userId: "u1", role });
}

async function json(res: Response) {
  return (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: string };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.stubEnv("MIGRATION_DISABLED", "");
  as("OWNER");
  mocks.findAccounts.mockResolvedValue([{ id: "a1", username: "shop", tokenStatus: "ACTIVE" }]);
});
afterEach(() => {
  vi.unstubAllEnvs();
});

describe("guard matrix", () => {
  it("answers 401 without an app session", async () => {
    mocks.workspaceContext.mockResolvedValue(null);
    expect((await listGet()).status).toBe(401);
  });

  it("VIEWER reads but every write is refused with an Uzbek 403", async () => {
    as("VIEWER");
    mocks.list.mockResolvedValue([]);
    expect((await listGet()).status).toBe(200);
    const writes = [
      await connectPost(req("POST", { name: "x", apiKey: SECRET })),
      await analyzePost(req("POST"), project),
      await basicsPost(req("POST", { tags: true, customFields: true, botFields: true }), project),
      await itemPatch(req("PATCH", { status: "SKIPPED" }), item),
      await textPut(req("PUT", { text: "a" }), item),
      await analyzeTextPost(req("POST", { text: "a" })),
      await convertPost(req("POST", {}), item),
      await importPost(req("POST", {}), item),
      await projectDelete(req("DELETE"), project),
    ];
    for (const res of writes) {
      expect(res.status).toBe(403);
      expect((await json(res)).error).toContain("VIEWER");
    }
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.convert).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("OPERATOR reads but cannot connect, convert or import", async () => {
    as("OPERATOR");
    mocks.list.mockResolvedValue([]);
    expect((await listGet()).status).toBe(200);
    expect((await metaGet()).status).toBe(200);
    expect((await connectPost(req("POST", { name: "x", apiKey: SECRET }))).status).toBe(403);
    expect((await convertPost(req("POST", {}), item)).status).toBe(403);
    expect((await importPost(req("POST", {}), item)).status).toBe(403);
    expect(mocks.convert).not.toHaveBeenCalled();
    expect(mocks.importFlow).not.toHaveBeenCalled();
  });

  it("MANAGER may convert and import", async () => {
    as("MANAGER");
    mocks.convert.mockResolvedValue({ graph: { nodes: [], edges: [] }, warnings: [], audit: {}, policy: {} });
    mocks.importFlow.mockResolvedValue({ flowId: "f1" });
    expect((await convertPost(req("POST", {}), item)).status).toBe(200);
    const imported = await importPost(req("POST", { instagramAccountId: "a1" }), item);
    expect(imported.status).toBe(201);
    expect((await json(imported)).data).toMatchObject({ flowId: "f1", link: "/flows?flow=f1" });
    expect(mocks.convert).toHaveBeenCalledWith("w1", "p1", "i1", {});
    expect(mocks.importFlow).toHaveBeenCalledWith("w1", "p1", "i1", { instagramAccountId: "a1" }, "u1");
  });

  it("meta reports accounts, limits, the kill switch and the caller's rights", async () => {
    as("MANAGER");
    const body = await json(await metaGet());
    expect(body.data).toMatchObject({
      enabled: true,
      accounts: [{ id: "a1", username: "shop" }],
      limits: { maxFlowText: MAX_FLOW_TEXT, maxScreenshots: MAX_SCREENSHOTS, maxScreenshotBytes: MAX_SCREENSHOT_BYTES },
      me: { role: "MANAGER", canWrite: true },
    });
    expect(Array.isArray(body.data?.catalog)).toBe(true);
    // The catalogue's regular expressions must not leak into the payload.
    expect(JSON.stringify(body.data?.catalog)).not.toContain("patterns");
  });
});

describe("kill switch", () => {
  beforeEach(() => {
    vi.stubEnv("MIGRATION_DISABLED", "1");
  });

  it("answers 503 (Uzbek, with the fix) on write and convert routes", async () => {
    const results = [
      await connectPost(req("POST", { name: "x", apiKey: SECRET })),
      await analyzePost(req("POST"), project),
      await basicsPost(req("POST", { tags: true, customFields: true, botFields: true }), project),
      await itemPatch(req("PATCH", { status: "SKIPPED" }), item),
      await textPut(req("PUT", { text: "a" }), item),
      await convertPost(req("POST", {}), item),
      await importPost(req("POST", {}), item),
    ];
    for (const res of results) {
      expect(res.status).toBe(503);
      expect((await json(res)).error).toContain("MIGRATION_DISABLED");
    }
    expect(mocks.connect).not.toHaveBeenCalled();
    expect(mocks.convert).not.toHaveBeenCalled();
  });

  it("still reads and still deletes (wiping the stored key must always work)", async () => {
    mocks.list.mockResolvedValue([]);
    mocks.remove.mockResolvedValue(undefined);
    expect((await listGet()).status).toBe(200);
    expect((await projectDelete(req("DELETE"), project)).status).toBe(200);
    expect(mocks.remove).toHaveBeenCalledWith("w1", "p1");
    expect((await json(await metaGet())).data?.enabled).toBe(false);
  });
});

describe("validation", () => {
  it("400 for a body that is not JSON and for zod failures (Uzbek)", async () => {
    const bad = await connectPost(req("POST", undefined, "{not json"));
    expect(bad.status).toBe(400);
    expect((await json(bad)).error).toBe("So'rov JSON emas");
    const short = await connectPost(req("POST", { name: "x", apiKey: "abc" }));
    expect(short.status).toBe(400);
    expect((await json(short)).error?.toLowerCase()).toContain("kalit");
    expect((await basicsPost(req("POST", { tags: "yes" }), project)).status).toBe(400);
    expect((await convertPost(req("POST", undefined, "{oops"), item)).status).toBe(400);
  });

  it("maps engine rules to 422 and foreign ids to 404", async () => {
    mocks.patch.mockRejectedValue(new MigrationServiceError(404, "Element topilmadi"));
    const missing = await itemPatch(req("PATCH", { status: "SKIPPED" }), { params: Promise.resolve({ id: "other", itemId: "zzz" }) });
    expect(missing.status).toBe(404);
    expect((await json(missing)).error).toBe("Element topilmadi");
    mocks.convert.mockRejectedValue(new MigrationServiceError(422, "Avval flow matnini kiriting"));
    const rule = await convertPost(req("POST", {}), item);
    expect(rule.status).toBe(422);
    expect((await json(rule)).error).toBe("Avval flow matnini kiriting");
    mocks.get.mockRejectedValue(new MigrationServiceError(404, "Loyiha topilmadi"));
    expect((await projectGet(req("GET"), { params: Promise.resolve({ id: "foreign" }) })).status).toBe(404);
    expect(mocks.get).toHaveBeenCalledWith("w1", "foreign");
  });
});

describe("text route body limits", () => {
  it("rejects more than MAX_SCREENSHOTS images with 422", async () => {
    const images = Array.from({ length: MAX_SCREENSHOTS + 1 }, () => ({ mediaType: "image/png", base64: "AAAA" }));
    const res = await textPut(req("PUT", { images }), item);
    expect(res.status).toBe(422);
    expect((await json(res)).error).toContain(String(MAX_SCREENSHOTS));
    expect(mocks.submitText).not.toHaveBeenCalled();
  });

  it("rejects an image over MAX_SCREENSHOT_BYTES with 413", async () => {
    const huge = "A".repeat(Math.ceil(((MAX_SCREENSHOT_BYTES + 10) * 4) / 3));
    const res = await textPut(req("PUT", { images: [{ mediaType: "image/png", base64: huge }] }), item);
    expect(res.status).toBe(413);
    expect(mocks.submitText).not.toHaveBeenCalled();
  });

  it("rejects an oversized declared body with 413 and a text over MAX_FLOW_TEXT with 422", async () => {
    const declared = new NextRequest("http://localhost/x", {
      method: "PUT",
      headers: { "content-type": "application/json", "content-length": String(500_000_000) },
      body: JSON.stringify({ text: "a" }),
    });
    expect((await textPut(declared, item)).status).toBe(413);
    const long = await textPut(req("PUT", { text: "a".repeat(MAX_FLOW_TEXT + 1) }), item);
    expect(long.status).toBe(422);
  });

  it("passes valid text and images to the engine", async () => {
    mocks.submitText.mockResolvedValue({ id: "i1", sourceText: "salom" });
    const res = await textPut(req("PUT", { text: "salom", images: [{ mediaType: "image/png", base64: "AAAA" }] }), item);
    expect(res.status).toBe(200);
    expect(mocks.submitText).toHaveBeenCalledWith("w1", "p1", "i1", { text: "salom", images: [{ mediaType: "image/png", base64: "AAAA" }] });
  });
});

describe("analyze-text is a pure preview", () => {
  it("returns detected features without touching the database or the engine", async () => {
    const res = await analyzeTextPost(req("POST", { text: "Trigger: comment keyword NARX. Send message with button. Wait 10 minutes. WhatsApp message." }));
    expect(res.status).toBe(200);
    expect((await json(res)).success).toBe(true);
    expect(mocks.findAccounts).not.toHaveBeenCalled();
    for (const fn of [mocks.get, mocks.patch, mocks.submitText, mocks.convert, mocks.importFlow]) expect(fn).not.toHaveBeenCalled();
  });

  it("works while the kill switch is on, and validates the body", async () => {
    vi.stubEnv("MIGRATION_DISABLED", "1");
    expect((await analyzeTextPost(req("POST", { text: "hello" }))).status).toBe(200);
    expect((await analyzeTextPost(req("POST", { text: 5 }))).status).toBe(400);
    expect((await analyzeTextPost(req("POST", { text: "a".repeat(MAX_FLOW_TEXT + 1) }))).status).toBe(400);
    expect((await analyzeTextPost(req("POST", undefined, "nope"))).status).toBe(400);
  });
});

describe("the ManyChat key is never returned", () => {
  it("strips key fields even if the engine leaks them, and never echoes the submitted key", async () => {
    const leaky = { id: "p1", name: "Shop", apiKeyHint: "…7890", apiKey: SECRET, apiKeyEncrypted: "enc:" + SECRET, items: [{ id: "i1", apiKey: SECRET }] };
    mocks.connect.mockResolvedValue(leaky);
    mocks.list.mockResolvedValue([leaky]);
    mocks.get.mockResolvedValue(leaky);
    mocks.analyze.mockResolvedValue(leaky);
    const responses = [
      await connectPost(req("POST", { name: "Shop", apiKey: SECRET })),
      await listGet(),
      await projectGet(req("GET"), project),
      await analyzePost(req("POST"), project),
    ];
    for (const res of responses) {
      const text = await res.text();
      expect(text).not.toContain(SECRET);
      expect(text).not.toContain("apiKeyEncrypted");
      expect(text).not.toContain('"apiKey"');
    }
    expect(JSON.parse(await (await projectGet(req("GET"), project)).text()).data.apiKeyHint).toBe("…7890");
  });

  it("does not put the key into an error response", async () => {
    mocks.connect.mockRejectedValue(new MigrationServiceError(422, "ManyChat kalitni qabul qilmadi"));
    const res = await connectPost(req("POST", { name: "Shop", apiKey: SECRET }));
    expect(res.status).toBe(422);
    expect(await res.text()).not.toContain(SECRET);
    const invalid = await connectPost(req("POST", { name: "", apiKey: SECRET }));
    expect(await invalid.text()).not.toContain(SECRET);
  });
});
