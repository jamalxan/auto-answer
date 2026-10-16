/**
 * ETAP 12 — the developer API (/api/developer/mcp): hidden (404) without the
 * developer login, token creation for OWNER / ADMIN only, the raw token only in
 * the creation answer, revoke (also with the kill switch on), the action log and
 * meta. The services run against the in-memory db.
 */

import { NextRequest } from "next/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  developerSession: vi.fn(),
  workspaceContext: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("@/lib/triggers/ingest", () => ({ forgetAccountGate: vi.fn() }));
vi.mock("../lib/developer/auth", () => ({ getDeveloperSession: mocks.developerSession }));
vi.mock("../lib/workspace-access", () => ({
  getCurrentWorkspaceContext: mocks.workspaceContext,
  canManageWorkspace: (role: string) => role === "OWNER" || role === "ADMIN",
}));

import { GET as metaGet } from "../app/api/developer/mcp/meta/route";
import { GET as tokensGet, POST as tokensPost } from "../app/api/developer/mcp/tokens/route";
import { DELETE as tokenDelete } from "../app/api/developer/mcp/tokens/[id]/route";
import { GET as actionsGet } from "../app/api/developer/mcp/actions/route";
import { resetMcpRateLimitsForTests } from "../lib/mcp/auth";
import { DEVELOPER_MODULES } from "../lib/developer/modules";
import { callTool, rpc, seedWorld, WS_A, WS_B } from "./helpers/mcp-world";

function as(role: string, workspaceId = WS_A) {
  mocks.developerSession.mockResolvedValue({ ok: true });
  mocks.workspaceContext.mockResolvedValue({ workspaceId, userId: "dev-user", role });
}

function req(method: string, body?: unknown, raw?: string, url = "http://localhost/api/developer/mcp/tokens"): NextRequest {
  return new NextRequest(url, { method, headers: { "content-type": "application/json" }, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
}

const idParams = (id: string) => ({ params: Promise.resolve({ id }) });

beforeEach(() => {
  resetDb();
  resetMcpRateLimitsForTests();
  vi.unstubAllEnvs();
  mocks.developerSession.mockReset();
  mocks.workspaceContext.mockReset();
  seedWorld();
});

afterEach(() => vi.unstubAllEnvs());

describe("guards", () => {
  it("answers 404 without the developer session, on every route", async () => {
    mocks.developerSession.mockResolvedValue(null);
    expect((await metaGet(req("GET"))).status).toBe(404);
    expect((await tokensGet()).status).toBe(404);
    expect((await tokensPost(req("POST", { name: "x" }))).status).toBe(404);
    expect((await tokenDelete(req("DELETE"), idParams("x"))).status).toBe(404);
    expect((await actionsGet(req("GET"))).status).toBe(404);
  });

  it("401 when the app session is missing", async () => {
    mocks.developerSession.mockResolvedValue({ ok: true });
    mocks.workspaceContext.mockResolvedValue(null);
    expect((await tokensGet()).status).toBe(401);
  });

  it("a MEMBER can read but not create or revoke tokens", async () => {
    as("MEMBER");
    expect((await tokensGet()).status).toBe(200);
    expect((await metaGet(req("GET"))).status).toBe(200);
    expect((await actionsGet(req("GET"))).status).toBe(200);
    expect((await tokensPost(req("POST", { name: "x" }))).status).toBe(403);
    expect((await tokenDelete(req("DELETE"), idParams("x"))).status).toBe(403);
    expect(db.rows("mcpToken")).toHaveLength(0);
  });
});

describe("tokens", () => {
  it("creates a token (201), shows the raw value once, never lists it", async () => {
    as("OWNER");
    const created = await tokensPost(req("POST", { name: "Claude Desktop", scope: "WRITE", expiresInDays: 30 }));
    expect(created.status).toBe(201);
    const body = await created.json();
    expect(body.data.token).toMatch(/^sa_mcp_/);
    expect(body.data.view).toMatchObject({ name: "Claude Desktop", scope: "WRITE", tokenHint: body.data.token.slice(-4) });
    expect(body.data.view.tokenHash).toBeUndefined();

    const listed = await (await tokensGet()).json();
    expect(listed.data).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain(body.data.token);
    expect(JSON.stringify(listed)).not.toMatch(/tokenHash/);

    // and the new token really works against /api/mcp
    expect((await rpc(body.data.token, "tools/list")).status).toBe(200);
  });

  it("validates the body: 400 Uzbek, 413 when huge, 400 when not JSON", async () => {
    as("ADMIN");
    const bad = await tokensPost(req("POST", { name: "" }));
    expect(bad.status).toBe(400);
    expect((await bad.json()).error).toMatch(/nomini/);
    expect((await tokensPost(req("POST", undefined, "{nope"))).status).toBe(400);
    expect((await tokensPost(req("POST", { name: "x".repeat(10_000) }))).status).toBe(413);
  });

  it("lists only the signed-in workspace's tokens", async () => {
    as("OWNER", WS_A);
    await tokensPost(req("POST", { name: "A token" }));
    as("OWNER", WS_B);
    await tokensPost(req("POST", { name: "B token" }));
    const listedB = await (await tokensGet()).json();
    expect(listedB.data.map((t: { name: string }) => t.name)).toEqual(["B token"]);
  });

  it("the kill switch blocks creating (503) but never revoking", async () => {
    as("OWNER");
    const created = await (await tokensPost(req("POST", { name: "x" }))).json();
    vi.stubEnv("MCP_DISABLED", "1");
    const blocked = await tokensPost(req("POST", { name: "y" }));
    expect(blocked.status).toBe(503);
    expect((await blocked.json()).error).toMatch(/MCP_DISABLED/);
    expect((await tokensGet()).status).toBe(200);
    expect((await tokenDelete(req("DELETE"), idParams(created.data.view.id))).status).toBe(200);
    expect(db.rows("mcpToken")[0].revokedAt).toBeInstanceOf(Date);
  });

  it("revokes a token (it stops working at once); a foreign workspace's id is 404", async () => {
    as("OWNER", WS_A);
    const created = await (await tokensPost(req("POST", { name: "x" }))).json();
    expect((await rpc(created.data.token, "ping")).status).toBe(200);
    as("OWNER", WS_B);
    expect((await tokenDelete(req("DELETE"), idParams(created.data.view.id))).status).toBe(404);
    expect((await rpc(created.data.token, "ping")).status).toBe(200);
    as("OWNER", WS_A);
    expect((await tokenDelete(req("DELETE"), idParams(created.data.view.id))).status).toBe(200);
    expect((await rpc(created.data.token, "ping")).status).toBe(401);
  });
});

describe("actions log and meta", () => {
  it("lists this workspace's proposals with a status / tool filter and no secrets", async () => {
    as("OWNER", WS_A);
    const created = await (await tokensPost(req("POST", { name: "w", scope: "WRITE" }))).json();
    const raw = created.data.token as string;
    const p1 = await callTool(raw, "pause_campaign", { campaignId: "cmpA" });
    await callTool(raw, "confirm_action", { actionId: p1.data.actionId, confirmCode: p1.data.confirmCode });
    await callTool(raw, "add_lead_tag", { leadId: "ctA", tag: "vip" });

    const all = await (await actionsGet(req("GET", undefined, undefined, "http://localhost/api/developer/mcp/actions"))).json();
    expect(all.data).toHaveLength(2);
    const executed = await (await actionsGet(req("GET", undefined, undefined, "http://localhost/api/developer/mcp/actions?status=EXECUTED"))).json();
    expect(executed.data.map((a: { tool: string }) => a.tool)).toEqual(["pause_campaign"]);
    const byTool = await (await actionsGet(req("GET", undefined, undefined, "http://localhost/api/developer/mcp/actions?tool=add_lead_tag"))).json();
    expect(byTool.data[0]).toMatchObject({ status: "PROPOSED", tokenName: "w" });
    expect(JSON.stringify(all)).not.toMatch(/confirmCodeHash|tokenHash/);

    as("OWNER", WS_B);
    expect((await (await actionsGet(req("GET", undefined, undefined, "http://localhost/api/developer/mcp/actions"))).json()).data).toHaveLength(0);
  });

  it("meta carries the endpoint, limits, tools and the caller's rights", async () => {
    as("OWNER");
    vi.stubEnv("NEXTAUTH_URL", "https://app.example.com/");
    const body = await (await metaGet(req("GET"))).json();
    expect(body.data.enabled).toBe(true);
    expect(body.data.endpoint).toBe("https://app.example.com/api/mcp");
    expect(body.data.workspace.name).toBe("Mebel A");
    expect(body.data.tools.length).toBeGreaterThan(15);
    expect(body.data.me.canManage).toBe(true);
    as("MEMBER");
    expect((await (await metaGet(req("GET"))).json()).data.me.canManage).toBe(false);
  });
});

describe("module registry", () => {
  it("lists MCP as ETAP 12, TESTING, with its screen", () => {
    expect(DEVELOPER_MODULES.find((m) => m.key === "mcp")).toMatchObject({ etap: 12, status: "TESTING", href: "/developer/mcp" });
  });
});
