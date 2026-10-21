/**
 * ETAP 12 — OAuth 2.1 for MCP clients: discovery documents, dynamic client
 * registration, the authorization request, code exchange with PKCE (single use,
 * replay revokes), refresh-token rotation, the 401 hint on /api/mcp, and that an
 * OAuth token is an ordinary McpToken (scope, revoke, list).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("@/lib/triggers/ingest", () => ({ forgetAccountGate: vi.fn() }));

import { resetMcpRateLimitsForTests } from "../lib/mcp/auth";
import { MAX_TOKENS_PER_WORKSPACE } from "../lib/mcp/config";
import { handleMcpPost } from "../lib/mcp/http";
import {
  ACCESS_TOKEN_TTL_MS,
  AUTH_CODE_TTL_MS,
  authorizationServerMetadata,
  basicClientOf,
  denyAuthorization,
  handleTokenRequest,
  isAllowedRedirectUri,
  issueAuthorizationCode,
  parseAuthorizeRequest,
  pkceChallengeOf,
  protectedResourceMetadata,
  registerClient,
  resetOauthLimitsForTests,
  resetOauthPruneForTests,
  TOKEN_LIMIT_MESSAGE,
  wwwAuthenticate,
} from "../lib/mcp/oauth";
import { handleRegisterPost, handleTokenPost } from "../lib/mcp/oauth-http";
import { createToken, listTokens, revokeToken } from "../lib/mcp/tokens";
import { callTool, mcpRequest, rpc, seedWorld, WS_A } from "./helpers/mcp-world";

const REDIRECT = "https://claude.ai/api/mcp/auth_callback";
const VERIFIER = "v".repeat(43) + "erifier-0123456789";

beforeEach(() => {
  resetDb();
  resetMcpRateLimitsForTests();
  resetOauthLimitsForTests();
  resetOauthPruneForTests();
  seedWorld();
});

async function register(extra: Record<string, unknown> = {}) {
  return registerClient({ client_name: "Claude", redirect_uris: [REDIRECT], ...extra }, "1.2.3.4");
}

function authorizeParams(clientId: string, extra: Record<string, string> = {}) {
  return new URLSearchParams({ response_type: "code", client_id: clientId, redirect_uri: REDIRECT, code_challenge: pkceChallengeOf(VERIFIER), code_challenge_method: "S256", state: "xyz", ...extra });
}

/** Full happy path up to a code for WS_A. */
async function codeFor(clientId: string, scope: "READ" | "WRITE" = "WRITE", requireHumanApproval = false) {
  const parsed = await parseAuthorizeRequest(authorizeParams(clientId, { scope: scope === "WRITE" ? "read write" : "read" }));
  if (!parsed.ok) throw new Error(parsed.description);
  const { redirectTo } = await issueAuthorizationCode(parsed.request, { workspaceId: WS_A, userId: "uA", scope, requireHumanApproval });
  const url = new URL(redirectTo);
  return { code: url.searchParams.get("code")!, state: url.searchParams.get("state"), redirectTo };
}

async function exchange(clientId: string, code: string, verifier = VERIFIER, extra: Record<string, string> = {}) {
  return handleTokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id: clientId, code_verifier: verifier, ...extra }, null, "9.9.9.9");
}

describe("discovery", () => {
  it("publishes RFC 9728 + RFC 8414 documents built from the origin", () => {
    const prm = protectedResourceMetadata("https://socialauto.uz");
    expect(prm.resource).toBe("https://socialauto.uz/api/mcp");
    expect(prm.authorization_servers).toEqual(["https://socialauto.uz"]);
    const as = authorizationServerMetadata("https://socialauto.uz");
    expect(as.issuer).toBe("https://socialauto.uz");
    expect(as.authorization_endpoint).toBe("https://socialauto.uz/developer/mcp/authorize");
    expect(as.token_endpoint).toBe("https://socialauto.uz/api/mcp/oauth/token");
    expect(as.registration_endpoint).toBe("https://socialauto.uz/api/mcp/oauth/register");
    expect(as.code_challenge_methods_supported).toEqual(["S256"]);
    expect(as.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
  });

  it("a 401 from /api/mcp names the resource metadata (how clients find OAuth)", async () => {
    const res = await handleMcpPost(mcpRequest(null, { jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(res.status).toBe(401);
    expect(res.headers.get("www-authenticate")).toBe(wwwAuthenticate("http://localhost"));
    expect(res.headers.get("www-authenticate")).toMatch(/resource_metadata="http:\/\/localhost\/\.well-known\/oauth-protected-resource"/);
    const bad = await handleMcpPost(mcpRequest("sa_mcp_nope", { jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(bad.headers.get("www-authenticate")).toMatch(/error="invalid_token"/);
  });
});

describe("dynamic client registration", () => {
  it("registers a public client and never stores a secret for it", async () => {
    const client = await register();
    expect(client.client_id).toBeTruthy();
    expect(client.client_secret).toBeUndefined();
    expect(client.token_endpoint_auth_method).toBe("none");
    expect(client.grant_types).toEqual(["authorization_code", "refresh_token"]);
    const row = db.rows("mcpOAuthClient")[0];
    expect(row.clientSecretHash).toBeNull();
  });

  it("returns a secret once for confidential clients and stores only its hash", async () => {
    const client = await register({ token_endpoint_auth_method: "client_secret_post" });
    expect(client.client_secret).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    const row = db.rows("mcpOAuthClient")[0];
    expect(row.clientSecretHash).not.toContain(client.client_secret);
  });

  it("refuses bad redirect URIs, unknown grant types and a missing list", async () => {
    await expect(register({ redirect_uris: ["http://evil.example/cb"] })).rejects.toMatchObject({ error: "invalid_redirect_uri" });
    await expect(register({ redirect_uris: ["https://x.example/cb#frag"] })).rejects.toMatchObject({ error: "invalid_redirect_uri" });
    await expect(register({ redirect_uris: [] })).rejects.toMatchObject({ error: "invalid_client_metadata" });
    await expect(register({ grant_types: ["implicit"] })).rejects.toMatchObject({ error: "invalid_client_metadata" });
    expect(isAllowedRedirectUri("http://localhost:1234/cb")).toBe(true);
    expect(isAllowedRedirectUri("http://127.0.0.1/cb")).toBe(true);
    expect(isAllowedRedirectUri("myapp://callback")).toBe(false);
  });

  it("names a nameless client after its URI and throttles registrations per IP", async () => {
    const client = await registerClient({ redirect_uris: ["http://localhost:5555/cb"] }, "8.8.8.8");
    expect(client.client_name).toBe("localhost");
    for (let i = 0; i < 19; i++) await registerClient({ redirect_uris: [REDIRECT] }, "8.8.8.8");
    await expect(registerClient({ redirect_uris: [REDIRECT] }, "8.8.8.8")).rejects.toMatchObject({ status: 429 });
    await expect(registerClient({ redirect_uris: [REDIRECT] }, "8.8.4.4")).resolves.toBeTruthy();
  });

  it("the HTTP route answers 201 JSON and 400 for junk", async () => {
    const ok = await handleRegisterPost(new Request("http://localhost/api/mcp/oauth/register", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "c", redirect_uris: [REDIRECT] }) }));
    expect(ok.status).toBe(201);
    expect((await ok.json()).client_id).toBeTruthy();
    const junk = await handleRegisterPost(new Request("http://localhost/api/mcp/oauth/register", { method: "POST", body: "{nope" }));
    expect(junk.status).toBe(400);
    expect((await junk.json()).error).toBe("invalid_client_metadata");
  });
});

describe("authorization request", () => {
  it("accepts a valid PKCE request and pre-selects the asked scope", async () => {
    const { client_id } = await register();
    const parsed = await parseAuthorizeRequest(authorizeParams(client_id, { scope: "read write" }));
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request.clientName).toBe("Claude");
    expect(parsed.request.requestedScope).toBe("WRITE");
    expect(parsed.request.state).toBe("xyz");
  });

  it("unknown client or unregistered redirect_uri is shown on our page, never redirected", async () => {
    const { client_id } = await register();
    const unknown = await parseAuthorizeRequest(authorizeParams("nope"));
    expect(unknown.ok).toBe(false);
    if (!unknown.ok) expect(unknown.redirectTo).toBeUndefined();
    const badRedirect = await parseAuthorizeRequest(authorizeParams(client_id, { redirect_uri: "https://attacker.example/cb" }));
    expect(badRedirect.ok).toBe(false);
    if (!badRedirect.ok) expect(badRedirect.redirectTo).toBeUndefined();
  });

  it("missing PKCE, plain method, wrong response_type or unknown scope go back to the client with error + state", async () => {
    const { client_id } = await register();
    for (const [extra, error] of [
      [{ code_challenge_method: "plain" }, "invalid_request"],
      [{ code_challenge: "short" }, "invalid_request"],
      [{ response_type: "token" }, "unsupported_response_type"],
      [{ scope: "admin" }, "invalid_scope"],
    ] as const) {
      const parsed = await parseAuthorizeRequest(authorizeParams(client_id, extra));
      expect(parsed.ok).toBe(false);
      if (parsed.ok) continue;
      expect(parsed.error).toBe(error);
      const url = new URL(parsed.redirectTo!);
      expect(url.origin + url.pathname).toBe(REDIRECT);
      expect(url.searchParams.get("error")).toBe(error);
      expect(url.searchParams.get("state")).toBe("xyz");
    }
  });

  it("deny redirects with access_denied and the state", async () => {
    const { client_id } = await register();
    const parsed = await parseAuthorizeRequest(authorizeParams(client_id));
    if (!parsed.ok) throw new Error();
    const url = new URL(denyAuthorization(parsed.request).redirectTo);
    expect(url.searchParams.get("error")).toBe("access_denied");
    expect(url.searchParams.get("state")).toBe("xyz");
    expect(url.searchParams.get("code")).toBeNull();
  });

  it("stores only the hash of the code, bound to client, redirect, workspace and scope", async () => {
    const { client_id } = await register();
    const { code, state } = await codeFor(client_id, "WRITE", true);
    expect(state).toBe("xyz");
    const row = db.rows("mcpAuthCode")[0];
    expect(row.codeHash).not.toBe(code);
    expect(JSON.stringify(row)).not.toContain(code);
    expect(row).toMatchObject({ clientId: client_id, redirectUri: REDIRECT, workspaceId: WS_A, scope: "WRITE", requireHumanApproval: true });
    expect(row.usedAt ?? null).toBeNull();
  });

  it("READ grants always require human approval (the flag only matters for WRITE)", async () => {
    const { client_id } = await register();
    await codeFor(client_id, "READ", false);
    expect(db.rows("mcpAuthCode")[0].requireHumanApproval).toBe(true);
  });

  it("refuses consent at the token cap unless the same client is re-connecting", async () => {
    const { client_id } = await register();
    for (let i = 0; i < MAX_TOKENS_PER_WORKSPACE; i++) await createToken(WS_A, { name: `t${i}` }, "dev");
    await expect(codeFor(client_id)).rejects.toThrow(TOKEN_LIMIT_MESSAGE);
  });
});

describe("token exchange (authorization_code + PKCE)", () => {
  it("issues a working McpToken with refresh token, scope and expiry", async () => {
    const { client_id } = await register();
    const { code } = await codeFor(client_id, "WRITE");
    const out = await exchange(client_id, code);
    expect(out.status).toBe(200);
    const body = out.body as { access_token: string; refresh_token: string; token_type: string; expires_in: number; scope: string };
    expect(body.token_type).toBe("Bearer");
    expect(body.access_token).toMatch(/^sa_mcp_/);
    expect(body.refresh_token).toMatch(/^sa_mcpr_/);
    expect(body.scope).toBe("read write");
    expect(body.expires_in).toBe(ACCESS_TOKEN_TTL_MS / 1000);

    expect((await rpc(body.access_token, "ping")).status).toBe(200);
    const tools = await rpc(body.access_token, "tools/list");
    expect(tools.json.result.tools.map((t: { name: string }) => t.name)).toContain("create_keyword_campaign");

    const [token] = await listTokens(WS_A);
    expect(token).toMatchObject({ name: "Claude (OAuth)", scope: "WRITE", source: "OAUTH", requireHumanApproval: false });
    const row = db.rows("mcpToken")[0];
    expect(JSON.stringify(row)).not.toContain(body.access_token);
    expect(JSON.stringify(row)).not.toContain(body.refresh_token);
    expect(row.oauthClientId).toBe(client_id);
    expect(db.rows("mcpAuthCode")[0].issuedTokenId).toBe(row.id);
  });

  it("a READ grant gives a READ token that cannot propose writes", async () => {
    const { client_id } = await register();
    const { code } = await codeFor(client_id, "READ");
    const out = await exchange(client_id, code);
    const token = (out.body as { access_token: string }).access_token;
    const call = await callTool(token, "pause_campaign", { campaignId: "cmpA" });
    expect(call.isError).toBe(true);
    expect(call.text).toMatch(/faqat o'qish/);
  });

  it("wrong verifier, wrong redirect_uri, other client, unknown code: invalid_grant and the code stays usable only for the right exchange", async () => {
    const { client_id } = await register();
    const other = await register({ client_name: "Other" });
    const { code } = await codeFor(client_id);
    expect((await exchange(client_id, code, "w".repeat(50))).body.error).toBe("invalid_grant");
    expect((await exchange(client_id, code, VERIFIER, { redirect_uri: "https://claude.ai/other" })).body.error).toBe("invalid_grant");
    expect((await exchange(other.client_id, code)).body.error).toBe("invalid_grant");
    expect((await exchange(client_id, "nope")).body.error).toBe("invalid_grant");
    expect((await exchange(client_id, code)).status).toBe(200);
  });

  it("a code is single use; replaying it revokes the token it produced", async () => {
    const { client_id } = await register();
    const { code } = await codeFor(client_id);
    const first = await exchange(client_id, code);
    const token = (first.body as { access_token: string }).access_token;
    expect((await rpc(token, "ping")).status).toBe(200);
    const replay = await exchange(client_id, code);
    expect(replay.status).toBe(400);
    expect(replay.body.error).toBe("invalid_grant");
    expect((await rpc(token, "ping")).status).toBe(401);
    expect(db.rows("mcpToken")[0].revokedAt).toBeTruthy();
  });

  it("an expired code is refused", async () => {
    const { client_id } = await register();
    const { code } = await codeFor(client_id);
    const later = new Date(Date.now() + AUTH_CODE_TTL_MS + 1000);
    const out = await handleTokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id, code_verifier: VERIFIER }, null, null, later);
    expect(out.body.error).toBe("invalid_grant");
    expect(String(out.body.error_description)).toMatch(/muddati/);
  });

  it("confidential clients must present their secret (body or Basic)", async () => {
    const client = await register({ token_endpoint_auth_method: "client_secret_post" });
    const { code } = await codeFor(client.client_id);
    expect((await exchange(client.client_id, code)).status).toBe(401);
    const basic = `Basic ${Buffer.from(`${client.client_id}:${client.client_secret}`).toString("base64")}`;
    const ok = await handleTokenRequest({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, code_verifier: VERIFIER }, basic, null);
    expect(ok.status).toBe(200);
    expect(basicClientOf("Basic !!!")).toBeNull();
    expect(basicClientOf(basic)?.clientId).toBe(client.client_id);
  });

  it("re-connecting at the token cap replaces the client's oldest token", async () => {
    const { client_id } = await register();
    const first = await exchange(client_id, (await codeFor(client_id)).code);
    const firstToken = (first.body as { access_token: string }).access_token;
    for (let i = 0; i < MAX_TOKENS_PER_WORKSPACE - 1; i++) await createToken(WS_A, { name: `t${i}` }, "dev");
    const second = await exchange(client_id, (await codeFor(client_id)).code);
    expect(second.status).toBe(200);
    expect((await rpc(firstToken, "ping")).status).toBe(401);
    expect(db.rows("mcpToken").filter((r) => !r.revokedAt).length).toBe(MAX_TOKENS_PER_WORKSPACE);
  });

  it("unsupported grant types and a junk body are RFC 6749 errors; failures are throttled per IP", async () => {
    expect((await handleTokenRequest({ grant_type: "password" }, null, "5.5.5.5")).body.error).toBe("unsupported_grant_type");
    for (let i = 0; i < 29; i++) await handleTokenRequest({ grant_type: "authorization_code", code: "x", client_id: "y", code_verifier: VERIFIER, redirect_uri: REDIRECT }, null, "5.5.5.5");
    const blocked = await handleTokenRequest({ grant_type: "authorization_code" }, null, "5.5.5.5");
    expect(blocked.status).toBe(429);
    const junk = await handleTokenPost(new Request("http://localhost/api/mcp/oauth/token", { method: "POST", headers: { "content-type": "application/json" }, body: "{" }));
    expect(junk.status).toBe(400);
    expect((await junk.json()).error).toBe("invalid_request");
  });

  it("the HTTP route reads form-urlencoded bodies", async () => {
    const { client_id } = await register();
    const { code } = await codeFor(client_id);
    const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: REDIRECT, client_id, code_verifier: VERIFIER });
    const res = await handleTokenPost(new Request("http://localhost/api/mcp/oauth/token", { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: form.toString() }));
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect((await res.json()).access_token).toMatch(/^sa_mcp_/);
  });
});

describe("refresh tokens", () => {
  async function pair() {
    const { client_id } = await register();
    const out = await exchange(client_id, (await codeFor(client_id)).code);
    return { client_id, ...(out.body as { access_token: string; refresh_token: string }) };
  }

  it("rotates both tokens on the same row; the old pair stops working", async () => {
    const { client_id, access_token, refresh_token } = await pair();
    const out = await handleTokenRequest({ grant_type: "refresh_token", refresh_token, client_id }, null, null);
    expect(out.status).toBe(200);
    const next = out.body as { access_token: string; refresh_token: string; scope: string };
    expect(next.access_token).not.toBe(access_token);
    expect(next.refresh_token).not.toBe(refresh_token);
    expect(next.scope).toBe("read write");
    expect((await rpc(access_token, "ping")).status).toBe(401);
    expect((await rpc(next.access_token, "ping")).status).toBe(200);
    expect(db.rows("mcpToken").length).toBe(1);
    const again = await handleTokenRequest({ grant_type: "refresh_token", refresh_token, client_id }, null, null);
    expect(again.body.error).toBe("invalid_grant");
  });

  it("another client, a revoked token or an expired refresh token cannot refresh", async () => {
    const { client_id, refresh_token } = await pair();
    const other = await register({ client_name: "Other" });
    expect((await handleTokenRequest({ grant_type: "refresh_token", refresh_token, client_id: other.client_id }, null, null)).body.error).toBe("invalid_grant");
    const far = new Date(Date.now() + 91 * 86_400_000);
    expect((await handleTokenRequest({ grant_type: "refresh_token", refresh_token, client_id }, null, null, far)).body.error).toBe("invalid_grant");
    await revokeToken(WS_A, db.rows("mcpToken")[0].id as string);
    const revoked = await handleTokenRequest({ grant_type: "refresh_token", refresh_token, client_id }, null, null);
    expect(revoked.body.error).toBe("invalid_grant");
    expect(db.rows("mcpToken")[0].refreshTokenHash).toBeNull();
  });
});
