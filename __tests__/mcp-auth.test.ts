/**
 * ETAP 12 — MCP bearer auth: missing / malformed / unknown / revoked / expired
 * tokens, the per-token rate limit, scope enforcement (READ cannot call write
 * tools), that only the hash is stored, token lifecycle (limit, revoke
 * withdraws proposals, workspace scoping of the token admin functions).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("@/lib/triggers/ingest", () => ({ forgetAccountGate: vi.fn() }));

import { authenticateMcp, bearerOf, resetMcpRateLimitsForTests } from "../lib/mcp/auth";
import { MAX_TOKENS_PER_WORKSPACE, RATE_LIMIT_PER_MIN, TOKEN_PREFIX } from "../lib/mcp/config";
import { createToken, hashToken, listTokens, revokeToken } from "../lib/mcp/tokens";
import { callTool, makeToken, mcpRequest, rpc, seedWorld, WS_A, WS_B } from "./helpers/mcp-world";
import { handleMcpPost } from "../lib/mcp/http";

beforeEach(() => {
  resetDb();
  resetMcpRateLimitsForTests();
  seedWorld();
});

async function post(raw: string | null, header?: string) {
  const request = mcpRequest(raw, { jsonrpc: "2.0", id: 1, method: "ping" });
  if (header !== undefined) request.headers.set("authorization", header);
  return handleMcpPost(request);
}

describe("bearer parsing and rejection", () => {
  it("parses only a Bearer header", () => {
    expect(bearerOf("Bearer abc")).toBe("abc");
    expect(bearerOf("bearer   abc  ")).toBe("abc");
    expect(bearerOf("Basic abc")).toBeNull();
    expect(bearerOf("Bearer a b")).toBeNull();
    expect(bearerOf(null)).toBeNull();
  });

  it("missing header is 401 with WWW-Authenticate", async () => {
    const res = await post(null);
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toMatch(/Bearer/);
    expect((await res.json()).error).toMatch(/Token kerak/);
  });

  it("wrong prefix, unknown token, oversized token are 401 and never reach the db by a secret", async () => {
    for (const header of ["Bearer nothing", `Bearer ${TOKEN_PREFIX}unknown`, `Bearer ${TOKEN_PREFIX}${"a".repeat(500)}`, "Basic abc"]) {
      const res = await post(null, header);
      expect(res.status).toBe(401);
    }
  });

  it("a revoked token is refused with an Uzbek fix", async () => {
    const { raw, id } = await makeToken(WS_A);
    expect((await post(raw)).status).toBe(200);
    await revokeToken(WS_A, id);
    const res = await post(raw);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/bekor qilingan/);
  });

  it("an expired token is refused", async () => {
    const { raw, id } = await makeToken(WS_A);
    const row = db.rows("mcpToken").find((r) => r.id === id)!;
    row.expiresAt = new Date(Date.now() - 1000);
    const res = await post(raw);
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatch(/muddati tugagan/);
  });

  it("a token that has not expired yet works", async () => {
    const created = await createToken(WS_A, { name: "short", scope: "READ", expiresInDays: 1 }, "dev");
    expect((await post(created.token)).status).toBe(200);
  });

  it("defaults to a 90-day expiry when no days are given; unlimited needs noExpiry", async () => {
    const def = await createToken(WS_A, { name: "default" }, "dev");
    const days = (new Date(def.view.expiresAt as unknown as string).getTime() - Date.now()) / 86_400_000;
    expect(days).toBeGreaterThan(89);
    expect(days).toBeLessThanOrEqual(90);
    const forever = await createToken(WS_A, { name: "forever", noExpiry: true }, "dev");
    expect(forever.view.expiresAt).toBeNull();
  });
});

describe("rate limit", () => {
  it("allows RATE_LIMIT_PER_MIN requests per minute per token, then 429 with Retry-After", async () => {
    const { raw } = await makeToken(WS_A);
    const other = await makeToken(WS_A, "READ", "other");
    for (let i = 0; i < RATE_LIMIT_PER_MIN; i++) expect((await post(raw)).status).toBe(200);
    const limited = await post(raw);
    expect(limited.status).toBe(429);
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    // another token has its own budget
    expect((await post(other.raw)).status).toBe(200);
  });

  it("the window slides: a minute later the token works again", async () => {
    const { raw } = await makeToken(WS_A);
    const t0 = new Date("2026-10-20T10:00:00Z");
    for (let i = 0; i < RATE_LIMIT_PER_MIN; i++) expect((await authenticateMcp(`Bearer ${raw}`, t0)).ok).toBe(true);
    expect((await authenticateMcp(`Bearer ${raw}`, t0)).ok).toBe(false);
    expect((await authenticateMcp(`Bearer ${raw}`, new Date(t0.getTime() + 61_000))).ok).toBe(true);
  });
});

describe("scope", () => {
  it("a READ token cannot call write tools or confirm_action (tool error, nothing stored)", async () => {
    const { raw } = await makeToken(WS_A, "READ");
    for (const [name, args] of [
      ["create_keyword_campaign", { name: "X", instagramAccountId: "acA", keywords: ["narx"], dmMessage: "salom" }],
      ["pause_campaign", { campaignId: "cmpA" }],
      ["add_lead_tag", { leadId: "ctA", tag: "vip" }],
      ["confirm_action", { actionId: "x", confirmCode: "AAAA-BBBB" }],
      ["reject_action", { actionId: "x" }],
    ] as const) {
      const result = await callTool(raw, name, args);
      expect(result.isError).toBe(true);
      expect(result.text).toMatch(/faqat o'qish/);
    }
    expect(db.rows("mcpAction")).toHaveLength(0);
    expect(db.rows("triggerCampaign").find((c) => c.id === "cmpA")!.active).toBe(true);
  });

  it("a READ token can read", async () => {
    const { raw } = await makeToken(WS_A, "READ");
    const result = await callTool(raw, "list_campaigns");
    expect(result.isError).toBe(false);
    expect(result.data.campaigns).toHaveLength(1);
  });
});

describe("token storage and lifecycle", () => {
  it("stores only the sha256 and the last 4 characters, never the raw token", async () => {
    const created = await createToken(WS_A, { name: "Claude", scope: "WRITE" }, "dev");
    expect(created.token.startsWith(TOKEN_PREFIX)).toBe(true);
    const row = db.rows("mcpToken").find((r) => r.id === created.view.id)!;
    expect(row.tokenHash).toBe(hashToken(created.token));
    expect(row.tokenHint).toBe(created.token.slice(-4));
    expect(JSON.stringify(row)).not.toContain(created.token);
    // the list view has neither the hash nor the raw value
    const listed = JSON.stringify(await listTokens(WS_A));
    expect(listed).not.toContain(created.token);
    expect(listed).not.toContain(String(row.tokenHash));
    expect(listed).toContain(created.token.slice(-4));
  });

  it("each token is unique", async () => {
    const a = await createToken(WS_A, { name: "a" }, null);
    const b = await createToken(WS_A, { name: "b" }, null);
    expect(a.token).not.toBe(b.token);
  });

  it("validates the name and scope", async () => {
    await expect(createToken(WS_A, { name: "  " }, null)).rejects.toMatchObject({ status: 400 });
    await expect(createToken(WS_A, { name: "x", scope: "ADMIN" }, null)).rejects.toMatchObject({ status: 400 });
    await expect(createToken(WS_A, { name: "x", expiresInDays: 4000 }, null)).rejects.toMatchObject({ status: 400 });
  });

  it("caps the active tokens per workspace; a revoked one frees a slot", async () => {
    const ids: string[] = [];
    for (let i = 0; i < MAX_TOKENS_PER_WORKSPACE; i++) ids.push((await createToken(WS_A, { name: `t${i}` }, null)).view.id);
    await expect(createToken(WS_A, { name: "one more" }, null)).rejects.toMatchObject({ status: 409 });
    await revokeToken(WS_A, ids[0]);
    await expect(createToken(WS_A, { name: "now fine" }, null)).resolves.toBeDefined();
    // the other workspace has its own budget
    await expect(createToken(WS_B, { name: "b" }, null)).resolves.toBeDefined();
  });

  it("revoking another workspace's token is a 404 and does nothing", async () => {
    const { raw, id } = await makeToken(WS_A);
    await expect(revokeToken(WS_B, id)).rejects.toMatchObject({ status: 404 });
    expect((await rpc(raw, "ping")).status).toBe(200);
  });

  it("revoking withdraws that token's unconfirmed proposals", async () => {
    const { raw, id } = await makeToken(WS_A, "WRITE");
    const proposal = await callTool(raw, "pause_campaign", { campaignId: "cmpA" });
    expect(proposal.data.status).toBe("PREVIEW");
    await revokeToken(WS_A, id);
    const action = db.rows("mcpAction")[0];
    expect(action.status).toBe("REJECTED");
    expect(action.confirmCodeHash).toBeNull();
  });

  it("lastUsedAt is recorded on use", async () => {
    const { raw, id } = await makeToken(WS_A);
    expect(db.rows("mcpToken").find((r) => r.id === id)!.lastUsedAt).toBeNull();
    await rpc(raw, "ping");
    expect(db.rows("mcpToken").find((r) => r.id === id)!.lastUsedAt).toBeInstanceOf(Date);
  });
});
