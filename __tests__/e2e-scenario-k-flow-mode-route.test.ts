/**
 * Scenario K (route level): PATCH /api/flows/[id].
 * A mode-only body switches simple <-> advanced (200, graph untouched); an empty
 * body is a plain Uzbek 400, never a raw zod message.
 */

import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({ developerSession: vi.fn(), workspaceContext: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("../lib/developer/auth", () => ({ getDeveloperSession: mocks.developerSession }));
vi.mock("../lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mocks.workspaceContext,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));

import { PATCH } from "../app/api/flows/[id]/route";
import { createFlow } from "../lib/flows/service";

const WS = "w1";
const RAW_ZOD = /Invalid input|expected (string|object)|received undefined|ZodError|"code"\s*:|too_small|invalid_type/i;

function patch(id: string, body?: unknown, raw?: string): [NextRequest, { params: Promise<{ id: string }> }] {
  const request = new NextRequest(`http://localhost/api/flows/${id}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: raw ?? (body === undefined ? undefined : JSON.stringify(body)),
  });
  return [request, { params: Promise.resolve({ id }) }];
}

const flowRow = (id: string) => db.rows("flow").find((r) => r.id === id)!;
const versionGraphs = () => JSON.stringify(db.rows("flowVersion").map((v) => v.graph));

let flowId: string;

beforeEach(async () => {
  resetDb();
  mocks.developerSession.mockReset().mockResolvedValue({ ok: true });
  mocks.workspaceContext.mockReset().mockResolvedValue({ workspaceId: WS, userId: "u1", role: "OWNER" });
  db.seed("workspace", { id: WS, ownerId: "u1", name: "Mebel" });
  db.seed("instagramAccount", { id: "a1", workspaceId: WS, username: "mebel", instagramId: "ig1" });
  const created = await createFlow(WS, { instagramAccountId: "a1", fromTemplateKey: "comment_price_lead" }, { userId: "u1" });
  flowId = created.flow.id;
});

describe("PATCH /api/flows/[id] - mode switch", () => {
  it("{mode:'ADVANCED'} then {mode:'SIMPLE'} -> 200 each, graph kept", async () => {
    const before = versionGraphs();
    const nameBefore = flowRow(flowId).name;

    const toAdvanced = await PATCH(...patch(flowId, { mode: "ADVANCED" }));
    expect(toAdvanced.status).toBe(200);
    expect((await toAdvanced.json()).success).toBe(true);
    expect(String(flowRow(flowId).mode).toUpperCase()).toBe("ADVANCED");

    const back = await PATCH(...patch(flowId, { mode: "SIMPLE" }));
    expect(back.status).toBe(200);
    expect(String(flowRow(flowId).mode).toUpperCase()).toBe("SIMPLE");

    expect(flowRow(flowId).name).toBe(nameBefore);
    expect(versionGraphs()).toBe(before);
    expect(db.rows("flowVersion")).toHaveLength(1);
  });

  it("lower-case mode values ('advanced') are rejected with a plain (non-zod) 400 and change nothing", async () => {
    // The API contract is upper-case (the editor sends SIMPLE / ADVANCED).
    const res = await PATCH(...patch(flowId, { mode: "advanced" }));
    expect(res.status).toBe(400);
    const json = await res.json();
    console.info("[scenario K] lower-case mode error text:", json.error);
    expect(json.error).not.toMatch(RAW_ZOD);
    expect(String(flowRow(flowId).mode).toUpperCase()).toBe("SIMPLE");
  });

  it("a rename alone keeps the mode", async () => {
    await PATCH(...patch(flowId, { mode: "ADVANCED" }));
    const res = await PATCH(...patch(flowId, { name: "Yangi nom" }));
    expect(res.status).toBe(200);
    expect(flowRow(flowId)).toMatchObject({ name: "Yangi nom" });
    expect(String(flowRow(flowId).mode).toUpperCase()).toBe("ADVANCED");
  });
});

describe("PATCH /api/flows/[id] - bad bodies", () => {
  it("empty object -> plain Uzbek 400, no raw zod text", async () => {
    const res = await PATCH(...patch(flowId, {}));
    expect(res.status).toBe(400);
    const json = await res.json();
    expect(json.success).toBe(false);
    expect(json.error).toBe("Nom yoki rejim ko'rsatilmagan");
    expect(json.error).not.toMatch(RAW_ZOD);
  });

  it("no body / non-JSON body -> Uzbek 400", async () => {
    for (const [body, raw] of [[undefined, undefined], [undefined, "not json"], [undefined, "[]"]] as const) {
      const res = await PATCH(...patch(flowId, body, raw));
      expect(res.status).toBe(400);
      const json = await res.json();
      expect(json.error).not.toMatch(RAW_ZOD);
      expect(json.error).toMatch(/[A-Za-z']{3,}/);
    }
  });

  it("invalid mode or blank name -> 400 without raw zod text", async () => {
    for (const body of [{ mode: "turbo" }, { mode: 5 }, { name: "   " }, { name: 7 }]) {
      const res = await PATCH(...patch(flowId, body));
      expect(res.status).toBe(400);
      expect((await res.json()).error).not.toMatch(RAW_ZOD);
    }
    expect(String(flowRow(flowId).mode).toUpperCase()).toBe("SIMPLE");
  });

  it("unknown flow -> 404; foreign workspace flow is invisible", async () => {
    expect((await PATCH(...patch("nope", { mode: "ADVANCED" }))).status).toBe(404);
    mocks.workspaceContext.mockResolvedValue({ workspaceId: "w2", userId: "u2", role: "OWNER" });
    expect((await PATCH(...patch(flowId, { mode: "ADVANCED" }))).status).toBe(404);
    expect(String(flowRow(flowId).mode).toUpperCase()).toBe("SIMPLE");
  });

  it("auth: no app session -> 401, VIEWER -> 403, and nothing changes", async () => {
    mocks.workspaceContext.mockResolvedValueOnce(null);
    expect((await PATCH(...patch(flowId, { mode: "ADVANCED" }))).status).toBe(401);
    mocks.workspaceContext.mockResolvedValueOnce({ workspaceId: WS, userId: "u3", role: "VIEWER" });
    expect((await PATCH(...patch(flowId, { mode: "ADVANCED" }))).status).toBe(403);
    expect(String(flowRow(flowId).mode).toUpperCase()).toBe("SIMPLE");
  });
});
