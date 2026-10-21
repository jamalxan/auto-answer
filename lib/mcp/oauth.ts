/**
 * ETAP 12 — OAuth 2.1 for MCP clients, so Claude.ai / Claude Desktop connectors,
 * ChatGPT, Claude Code and any other MCP client can connect to /api/mcp directly
 * (no mcp-remote, no pasted token):
 *
 *   RFC 9728  protected-resource metadata   GET /.well-known/oauth-protected-resource
 *   RFC 8414  authorization-server metadata GET /.well-known/oauth-authorization-server
 *   RFC 7591  dynamic client registration   POST /api/mcp/oauth/register
 *   RFC 6749  authorization code (+ PKCE S256, RFC 7636, mandatory)
 *             consent screen                GET  /developer/mcp/authorize  (developer login + app session, OWNER / ADMIN)
 *             token endpoint                POST /api/mcp/oauth/token (authorization_code, refresh_token)
 *
 * The access token IS an McpToken (`sa_mcp_…`): same hash lookup in auth.ts, same
 * scope / human-approval rules, same list and revoke in /developer/mcp. Refresh
 * tokens rotate the SAME row (new token hash, new refresh hash, extended expiry),
 * so the audit log stays attached to one token and a stolen old pair stops working.
 *
 * Nothing here widens tenant access: the workspace comes from the person who
 * approves the consent screen, never from the client.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { McpScope } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { firstIssue } from "@/lib/crm/result";
import { MAX_TOKENS_PER_WORKSPACE } from "./config";
import { conflict, describeError, McpServiceError } from "./errors";
import { generateRawToken, hashToken } from "./tokens";

// ─── Constants ────────────────────────────────────────────────────────────────

/** OAuth scope strings (the McpScope enum is READ / WRITE; `write` implies `read`). */
export const OAUTH_SCOPES = ["read", "write"] as const;
/** An authorization code can be exchanged for this long. */
export const AUTH_CODE_TTL_MS = 5 * 60 * 1000;
/** Access tokens issued over OAuth; the client refreshes them (REFRESH_TOKEN_TTL_MS). */
export const ACCESS_TOKEN_TTL_MS = 30 * 86_400_000;
export const REFRESH_TOKEN_TTL_MS = 90 * 86_400_000;
/** Redirect URIs a client may register. */
export const MAX_REDIRECT_URIS = 10;
/** Dynamic registrations per client IP per minute (the endpoint is anonymous). */
export const REGISTRATIONS_PER_IP_PER_MIN = 20;
/** Failed token-endpoint calls per client IP per minute. */
export const TOKEN_FAILURES_PER_IP_PER_MIN = 30;

export const RESOURCE_PATH = "/api/mcp";
export const AUTHORIZE_PATH = "/developer/mcp/authorize";
export const TOKEN_PATH = "/api/mcp/oauth/token";
export const REGISTER_PATH = "/api/mcp/oauth/register";
export const PROTECTED_RESOURCE_METADATA_PATH = "/.well-known/oauth-protected-resource";
export const AUTHORIZATION_SERVER_METADATA_PATH = "/.well-known/oauth-authorization-server";

export const TOKEN_LIMIT_MESSAGE = `Bu workspace'da faol tokenlar ko'pi bilan ${MAX_TOKENS_PER_WORKSPACE} ta. Yechim: /developer/mcp da keraksiz tokenni bekor qiling.`;

// ─── Origin ───────────────────────────────────────────────────────────────────

/** The public origin every absolute URL in the metadata is built from: NEXTAUTH_URL in prod, the request's origin otherwise. */
export function publicOrigin(request: Request): string {
  const configured = process.env.NEXTAUTH_URL?.trim().replace(/\/+$/, "");
  if (configured && /^https?:\/\//i.test(configured)) return configured;
  return new URL(request.url).origin;
}

// ─── Metadata documents ───────────────────────────────────────────────────────

export function protectedResourceMetadata(origin: string) {
  return {
    resource: `${origin}${RESOURCE_PATH}`,
    authorization_servers: [origin],
    bearer_methods_supported: ["header"],
    scopes_supported: [...OAUTH_SCOPES],
    resource_name: "SocialAuto MCP",
    resource_documentation: `${origin}/developer/mcp`,
  };
}

export function authorizationServerMetadata(origin: string) {
  return {
    issuer: origin,
    authorization_endpoint: `${origin}${AUTHORIZE_PATH}`,
    token_endpoint: `${origin}${TOKEN_PATH}`,
    registration_endpoint: `${origin}${REGISTER_PATH}`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [...OAUTH_SCOPES],
    service_documentation: `${origin}/developer/mcp`,
  };
}

/** The WWW-Authenticate value of a 401 from /api/mcp: tells an MCP client where the OAuth metadata is (RFC 9728 §5.1). */
export function wwwAuthenticate(origin: string, error?: "invalid_token"): string {
  const base = `Bearer realm="socialauto", resource_metadata="${origin}${PROTECTED_RESOURCE_METADATA_PATH}"`;
  return error ? `${base}, error="${error}"` : base;
}

// ─── In-memory IP throttles (per process, like auth.ts) ───────────────────────

const WINDOW_MS = 60_000;
const MAX_TRACKED_IPS = 5000;
const registrations = new Map<string, number[]>();
const tokenFailures = new Map<string, number[]>();

export function resetOauthLimitsForTests() {
  registrations.clear();
  tokenFailures.clear();
}

function note(map: Map<string, number[]>, ip: string | null, nowMs: number, limit: number): boolean {
  if (!ip) return true;
  const recent = (map.get(ip) ?? []).filter((t) => t > nowMs - WINDOW_MS);
  if (recent.length >= limit) {
    map.set(ip, recent);
    return false;
  }
  recent.push(nowMs);
  map.delete(ip);
  map.set(ip, recent);
  if (map.size > MAX_TRACKED_IPS) {
    for (const key of map.keys()) {
      if (map.size <= MAX_TRACKED_IPS) break;
      map.delete(key);
    }
  }
  return true;
}

function blocked(map: Map<string, number[]>, ip: string | null, nowMs: number, limit: number): boolean {
  if (!ip) return false;
  return (map.get(ip) ?? []).filter((t) => t > nowMs - WINDOW_MS).length >= limit;
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** An RFC 6749 §5.2 error: `error` is the protocol code, `description` the human (Uzbek) text. */
export class OAuthError extends Error {
  constructor(
    public readonly error: string,
    public readonly description: string,
    public readonly status = 400
  ) {
    super(description);
    this.name = "OAuthError";
  }
}

const oauthError = (error: string, description: string, status = 400) => new OAuthError(error, description, status);

function sameHash(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

const sha256 = (value: string) => createHash("sha256").update(value, "utf8").digest("hex");

/** PKCE S256: BASE64URL(SHA256(verifier)) (RFC 7636 §4.2). */
export function pkceChallengeOf(verifier: string): string {
  return createHash("sha256").update(verifier, "ascii").digest("base64url");
}

const PKCE_CHARS = /^[A-Za-z0-9\-._~]{43,128}$/;

/** Loopback redirects may be plain http (RFC 8252 §7.3); everything else must be https. */
export function isAllowedRedirectUri(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.hash) return false;
  if (url.username || url.password) return false;
  if (url.protocol === "https:") return true;
  if (url.protocol === "http:") return ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  return false;
}

export function scopeToEnum(scope: string): McpScope {
  return scope.split(/\s+/).includes("write") ? "WRITE" : "READ";
}

export function enumToScope(scope: McpScope): string {
  return scope === "WRITE" ? "read write" : "read";
}

function now(): Date {
  return new Date();
}

// ─── Dynamic client registration (RFC 7591) ───────────────────────────────────

const registerSchema = z
  .object({
    client_name: z.string().trim().max(80, "client_name 80 belgidan oshmasin").optional(),
    redirect_uris: z
      .array(z.string().trim().min(1).max(2000), "redirect_uris ro'yxat bo'lishi kerak")
      .min(1, "redirect_uris kamida bitta bo'lsin")
      .max(MAX_REDIRECT_URIS, `redirect_uris ko'pi bilan ${MAX_REDIRECT_URIS} ta`),
    token_endpoint_auth_method: z.enum(["none", "client_secret_post", "client_secret_basic"]).default("none"),
    grant_types: z.array(z.string()).optional(),
    response_types: z.array(z.string()).optional(),
    client_uri: z.string().trim().url().max(2000).optional(),
    scope: z.string().max(200).optional(),
  })
  .passthrough();

export interface RegisteredClient {
  client_id: string;
  client_id_issued_at: number;
  client_name: string;
  redirect_uris: string[];
  token_endpoint_auth_method: string;
  grant_types: string[];
  response_types: string[];
  client_secret?: string;
  client_secret_expires_at?: number;
  scope: string;
}

export async function registerClient(input: unknown, clientIp: string | null, at: Date = now()): Promise<RegisteredClient> {
  if (!note(registrations, clientIp, at.getTime(), REGISTRATIONS_PER_IP_PER_MIN)) {
    throw oauthError("invalid_client_metadata", "Ro'yxatdan o'tish so'rovlari juda ko'p. Birozdan keyin qayta urinib ko'ring.", 429);
  }
  const parsed = registerSchema.safeParse(input);
  if (!parsed.success) throw oauthError("invalid_client_metadata", firstIssue(parsed.error));
  const body = parsed.data;
  const redirectUris = Array.from(new Set(body.redirect_uris));
  const bad = redirectUris.find((u) => !isAllowedRedirectUri(u));
  if (bad) throw oauthError("invalid_redirect_uri", `redirect_uri ruxsat etilmagan: ${bad.slice(0, 120)} (https yoki http://localhost bo'lsin, fragmentsiz)`);
  const grantTypes = body.grant_types?.length ? body.grant_types : ["authorization_code", "refresh_token"];
  const unknownGrant = grantTypes.find((g) => g !== "authorization_code" && g !== "refresh_token");
  if (unknownGrant) throw oauthError("invalid_client_metadata", `grant_type qo'llab-quvvatlanmaydi: ${unknownGrant.slice(0, 40)}`);
  const responseTypes = body.response_types?.length ? body.response_types : ["code"];
  if (responseTypes.some((r) => r !== "code")) throw oauthError("invalid_client_metadata", "response_types faqat ['code'] bo'lishi mumkin");

  const clientName = body.client_name?.trim() || clientNameFromUri(body.client_uri, redirectUris[0]);
  let secret: string | undefined;
  if (body.token_endpoint_auth_method !== "none") secret = randomBytes(32).toString("base64url");
  const row = await prisma.mcpOAuthClient.create({
    data: {
      clientName,
      redirectUris,
      tokenEndpointAuthMethod: body.token_endpoint_auth_method,
      clientSecretHash: secret ? sha256(secret) : null,
      clientUri: body.client_uri ?? null,
    },
  });
  return {
    client_id: row.id,
    client_id_issued_at: Math.floor(row.createdAt.getTime() / 1000),
    client_name: row.clientName,
    redirect_uris: row.redirectUris,
    token_endpoint_auth_method: row.tokenEndpointAuthMethod,
    grant_types: grantTypes,
    response_types: ["code"],
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    scope: OAUTH_SCOPES.join(" "),
  };
}

function clientNameFromUri(clientUri: string | undefined, redirect: string): string {
  for (const candidate of [clientUri, redirect]) {
    if (!candidate) continue;
    try {
      return new URL(candidate).hostname.slice(0, 80) || "MCP client";
    } catch {
      /* next candidate */
    }
  }
  return "MCP client";
}

// ─── Authorization request (consent screen) ───────────────────────────────────

export interface AuthorizeRequest {
  clientId: string;
  clientName: string;
  redirectUri: string;
  codeChallenge: string;
  state: string | null;
  /** The scope the client asked for (what the consent screen pre-selects). */
  requestedScope: McpScope;
  resource: string | null;
}

export type ParsedAuthorize =
  | { ok: true; request: AuthorizeRequest }
  | {
      ok: false;
      error: string;
      description: string;
      /** Set when the error may be sent back to the client (redirect_uri is known-good); otherwise it is shown on our page. */
      redirectTo?: string;
    };

function withQuery(base: string, params: Record<string, string | null | undefined>): string {
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) if (v !== null && v !== undefined) url.searchParams.set(k, v);
  return url.toString();
}

/** Validates the query of GET /developer/mcp/authorize (RFC 6749 §4.1.1 + PKCE). */
export async function parseAuthorizeRequest(params: URLSearchParams): Promise<ParsedAuthorize> {
  const clientId = (params.get("client_id") ?? "").trim();
  const redirectUri = (params.get("redirect_uri") ?? "").trim();
  if (!clientId || clientId.length > 64) return { ok: false, error: "invalid_request", description: "client_id yo'q yoki noto'g'ri" };
  const client = await prisma.mcpOAuthClient.findUnique({ where: { id: clientId } });
  if (!client) return { ok: false, error: "invalid_client", description: "Bunday client ro'yxatdan o'tmagan. Ulanishni AI mijozdan qaytadan boshlang." };
  if (!redirectUri || !client.redirectUris.includes(redirectUri)) {
    return { ok: false, error: "invalid_request", description: "redirect_uri bu client uchun ro'yxatdan o'tmagan" };
  }
  const state = params.get("state");
  if (state !== null && state.length > 1024) {
    return { ok: false, error: "invalid_request", description: "state juda uzun", redirectTo: withQuery(redirectUri, { error: "invalid_request", error_description: "state too long" }) };
  }
  const fail = (error: string, description: string): ParsedAuthorize => ({ ok: false, error, description, redirectTo: withQuery(redirectUri, { error, error_description: description, state }) });

  if (params.get("response_type") !== "code") return fail("unsupported_response_type", "response_type faqat 'code' bo'lishi mumkin");
  const method = params.get("code_challenge_method") ?? "";
  const challenge = params.get("code_challenge") ?? "";
  if (method !== "S256") return fail("invalid_request", "code_challenge_method=S256 kerak (PKCE majburiy)");
  if (!PKCE_CHARS.test(challenge)) return fail("invalid_request", "code_challenge noto'g'ri (43-128 belgi, base64url)");
  const scopeRaw = (params.get("scope") ?? "").trim();
  const scopes = scopeRaw ? scopeRaw.split(/\s+/) : [];
  const unknownScope = scopes.find((s) => !(OAUTH_SCOPES as readonly string[]).includes(s));
  if (unknownScope) return fail("invalid_scope", `Noma'lum scope: ${unknownScope.slice(0, 40)}`);
  const resource = params.get("resource");
  if (resource !== null && resource.length > 2000) return fail("invalid_target", "resource juda uzun");

  return {
    ok: true,
    request: {
      clientId: client.id,
      clientName: client.clientName,
      redirectUri,
      codeChallenge: challenge,
      state,
      requestedScope: scopes.includes("write") ? "WRITE" : "READ",
      resource,
    },
  };
}

export interface ConsentGrant {
  workspaceId: string;
  userId: string;
  scope: McpScope;
  requireHumanApproval: boolean;
}

let lastCodePruneMs = 0;

export function resetOauthPruneForTests() {
  lastCodePruneMs = 0;
}

/** Spent and long-expired codes are deleted opportunistically (at most once an hour per process). */
async function pruneCodes(at: Date): Promise<void> {
  if (at.getTime() - lastCodePruneMs < 60 * 60 * 1000) return;
  lastCodePruneMs = at.getTime();
  try {
    await prisma.mcpAuthCode.deleteMany({ where: { expiresAt: { lt: new Date(at.getTime() - 86_400_000) } } });
  } catch (error) {
    console.error("[MCP OAuth] prune failed:", describeError(error));
  }
}

/** The person approved: store a one-time code and build the redirect back to the client. */
export async function issueAuthorizationCode(request: AuthorizeRequest, grant: ConsentGrant, at: Date = now()): Promise<{ redirectTo: string }> {
  const active = await prisma.mcpToken.count({ where: { workspaceId: grant.workspaceId, revokedAt: null } });
  const reconnecting = await prisma.mcpToken.count({ where: { workspaceId: grant.workspaceId, revokedAt: null, oauthClientId: request.clientId } });
  // A re-connect of the same client replaces its old token at exchange time, so it may go ahead at the cap.
  if (active >= MAX_TOKENS_PER_WORKSPACE && reconnecting === 0) throw conflict(TOKEN_LIMIT_MESSAGE);
  await pruneCodes(at);
  const code = randomBytes(32).toString("base64url");
  await prisma.mcpAuthCode.create({
    data: {
      codeHash: sha256(code),
      clientId: request.clientId,
      redirectUri: request.redirectUri,
      codeChallenge: request.codeChallenge,
      codeChallengeMethod: "S256",
      scope: grant.scope,
      requireHumanApproval: grant.scope === "WRITE" ? grant.requireHumanApproval : true,
      workspaceId: grant.workspaceId,
      userId: grant.userId,
      resource: request.resource,
      expiresAt: new Date(at.getTime() + AUTH_CODE_TTL_MS),
    },
  });
  return { redirectTo: withQuery(request.redirectUri, { code, state: request.state }) };
}

/** The person refused (or is not allowed): the client learns it through the redirect, never why in detail. */
export function denyAuthorization(request: AuthorizeRequest, reason = "access_denied"): { redirectTo: string } {
  return { redirectTo: withQuery(request.redirectUri, { error: reason, error_description: "The user did not approve the connection", state: request.state }) };
}

// ─── Token endpoint ───────────────────────────────────────────────────────────

export interface TokenResponse {
  access_token: string;
  token_type: "Bearer";
  expires_in: number;
  refresh_token: string;
  scope: string;
}

/** Fields of application/x-www-form-urlencoded (or JSON) token requests we read. */
export interface TokenRequestBody {
  grant_type?: string;
  code?: string;
  redirect_uri?: string;
  client_id?: string;
  client_secret?: string;
  code_verifier?: string;
  refresh_token?: string;
  resource?: string;
}

/** Parses `Authorization: Basic base64(client_id:client_secret)` (RFC 6749 §2.3.1). */
export function basicClientOf(header: string | null): { clientId: string; clientSecret: string } | null {
  const match = /^Basic\s+([A-Za-z0-9+/=_-]+)\s*$/i.exec(header?.trim() ?? "");
  if (!match) return null;
  const decoded = Buffer.from(match[1], "base64").toString("utf8");
  const idx = decoded.indexOf(":");
  if (idx <= 0) return null;
  try {
    return { clientId: decodeURIComponent(decoded.slice(0, idx)), clientSecret: decodeURIComponent(decoded.slice(idx + 1)) };
  } catch {
    return null;
  }
}

async function authenticateClient(body: TokenRequestBody, authorization: string | null) {
  const basic = basicClientOf(authorization);
  const clientId = (basic?.clientId ?? body.client_id ?? "").trim();
  if (!clientId || clientId.length > 64) throw oauthError("invalid_client", "client_id kerak", 401);
  const client = await prisma.mcpOAuthClient.findUnique({ where: { id: clientId } });
  if (!client) throw oauthError("invalid_client", "client topilmadi: ulanishni qaytadan boshlang (ro'yxatdan o'tish)", 401);
  if (client.tokenEndpointAuthMethod !== "none") {
    const secret = basic?.clientSecret ?? body.client_secret ?? "";
    if (!client.clientSecretHash || !secret || !sameHash(client.clientSecretHash, sha256(secret))) {
      throw oauthError("invalid_client", "client_secret noto'g'ri", 401);
    }
  }
  return client;
}

async function revokeTokenQuietly(tokenId: string | null, at: Date) {
  if (!tokenId) return;
  try {
    await prisma.mcpToken.updateMany({ where: { id: tokenId, revokedAt: null }, data: { revokedAt: at, refreshTokenHash: null } });
    await prisma.mcpAction.updateMany({ where: { tokenId, status: "PROPOSED" }, data: { status: "REJECTED", confirmCodeHash: null, error: "Token bekor qilindi", resolvedAt: at } });
  } catch (error) {
    console.error("[MCP OAuth] revoke failed:", describeError(error));
  }
}

function tokenResponse(raw: string, refresh: string, scope: McpScope, at: Date, expiresAt: Date): TokenResponse {
  return {
    access_token: raw,
    token_type: "Bearer",
    expires_in: Math.max(1, Math.floor((expiresAt.getTime() - at.getTime()) / 1000)),
    refresh_token: refresh,
    scope: enumToScope(scope),
  };
}

const newRefreshToken = () => `sa_mcpr_${randomBytes(32).toString("base64url")}`;

async function exchangeAuthorizationCode(body: TokenRequestBody, authorization: string | null, at: Date): Promise<TokenResponse> {
  const client = await authenticateClient(body, authorization);
  const code = (body.code ?? "").trim();
  const verifier = (body.code_verifier ?? "").trim();
  if (!code || code.length > 256) throw oauthError("invalid_grant", "code kerak");
  if (!PKCE_CHARS.test(verifier)) throw oauthError("invalid_grant", "code_verifier kerak (PKCE, 43-128 belgi)");

  const row = await prisma.mcpAuthCode.findUnique({ where: { codeHash: sha256(code) } });
  if (!row || row.clientId !== client.id) throw oauthError("invalid_grant", "code noto'g'ri yoki boshqa client uchun");
  if (row.usedAt) {
    // Replay of a spent code: whatever it produced is revoked (RFC 6749 §4.1.2).
    await revokeTokenQuietly(row.issuedTokenId, at);
    throw oauthError("invalid_grant", "code allaqachon ishlatilgan — ulanishni qaytadan boshlang");
  }
  if (row.expiresAt.getTime() <= at.getTime()) throw oauthError("invalid_grant", "code muddati tugagan (5 daqiqa) — ulanishni qaytadan boshlang");
  if ((body.redirect_uri ?? "").trim() !== row.redirectUri) throw oauthError("invalid_grant", "redirect_uri mos kelmadi");
  if (!sameHash(row.codeChallenge, pkceChallengeOf(verifier))) throw oauthError("invalid_grant", "code_verifier mos kelmadi (PKCE)");

  // Burn the code first; two concurrent exchanges can win at most once.
  const claimed = await prisma.mcpAuthCode.updateMany({ where: { id: row.id, usedAt: null }, data: { usedAt: at } });
  if (claimed.count !== 1) throw oauthError("invalid_grant", "code allaqachon ishlatilgan — ulanishni qaytadan boshlang");

  // Re-connecting the same client replaces its previous token instead of piling up.
  const active = await prisma.mcpToken.count({ where: { workspaceId: row.workspaceId, revokedAt: null } });
  if (active >= MAX_TOKENS_PER_WORKSPACE) {
    const oldest = await prisma.mcpToken.findFirst({
      where: { workspaceId: row.workspaceId, revokedAt: null, oauthClientId: client.id },
      orderBy: { createdAt: "asc" },
      select: { id: true },
    });
    if (!oldest) throw oauthError("invalid_grant", TOKEN_LIMIT_MESSAGE);
    await revokeTokenQuietly(oldest.id, at);
  }

  const raw = generateRawToken();
  const refresh = newRefreshToken();
  const expiresAt = new Date(at.getTime() + ACCESS_TOKEN_TTL_MS);
  const token = await prisma.mcpToken.create({
    data: {
      workspaceId: row.workspaceId,
      name: `${client.clientName} (OAuth)`.slice(0, 80),
      tokenHash: hashToken(raw),
      tokenHint: raw.slice(-4),
      scope: row.scope,
      requireHumanApproval: row.requireHumanApproval,
      createdByUserId: row.userId,
      expiresAt,
      oauthClientId: client.id,
      refreshTokenHash: sha256(refresh),
      refreshExpiresAt: new Date(at.getTime() + REFRESH_TOKEN_TTL_MS),
    },
  });
  await prisma.mcpAuthCode.update({ where: { id: row.id }, data: { issuedTokenId: token.id } });
  try {
    await prisma.mcpOAuthClient.update({ where: { id: client.id }, data: { lastUsedAt: at } });
  } catch {
    /* cosmetic */
  }
  return tokenResponse(raw, refresh, row.scope, at, expiresAt);
}

async function refreshAccessToken(body: TokenRequestBody, authorization: string | null, at: Date): Promise<TokenResponse> {
  const client = await authenticateClient(body, authorization);
  const presented = (body.refresh_token ?? "").trim();
  if (!presented || presented.length > 256) throw oauthError("invalid_grant", "refresh_token kerak");
  const row = await prisma.mcpToken.findUnique({ where: { refreshTokenHash: sha256(presented) } });
  if (!row || row.oauthClientId !== client.id) throw oauthError("invalid_grant", "refresh_token noto'g'ri — ulanishni qaytadan boshlang");
  if (row.revokedAt) throw oauthError("invalid_grant", "token bekor qilingan — /developer/mcp da ulanishni qaytadan boshlang");
  if (!row.refreshExpiresAt || row.refreshExpiresAt.getTime() <= at.getTime()) throw oauthError("invalid_grant", "refresh_token muddati tugagan — ulanishni qaytadan boshlang");

  const raw = generateRawToken();
  const refresh = newRefreshToken();
  const expiresAt = new Date(at.getTime() + ACCESS_TOKEN_TTL_MS);
  // Rotation: the old access and refresh tokens stop working with this one conditional write.
  const rotated = await prisma.mcpToken.updateMany({
    where: { id: row.id, refreshTokenHash: row.refreshTokenHash, revokedAt: null },
    data: { tokenHash: hashToken(raw), tokenHint: raw.slice(-4), refreshTokenHash: sha256(refresh), expiresAt, refreshExpiresAt: new Date(at.getTime() + REFRESH_TOKEN_TTL_MS) },
  });
  if (rotated.count !== 1) throw oauthError("invalid_grant", "refresh_token allaqachon ishlatilgan — ulanishni qaytadan boshlang");
  return tokenResponse(raw, refresh, row.scope, at, expiresAt);
}

export type TokenOutcome = { status: number; body: Record<string, unknown>; headers?: Record<string, string> };

/** POST /api/mcp/oauth/token. Never throws: every failure is an RFC 6749 §5.2 error body. */
export async function handleTokenRequest(body: TokenRequestBody, authorization: string | null, clientIp: string | null, at: Date = now()): Promise<TokenOutcome> {
  if (blocked(tokenFailures, clientIp, at.getTime(), TOKEN_FAILURES_PER_IP_PER_MIN)) {
    return { status: 429, body: { error: "invalid_request", error_description: "Juda ko'p urinish. Birozdan keyin qayta urinib ko'ring." }, headers: { "Retry-After": "60" } };
  }
  try {
    switch (body.grant_type) {
      case "authorization_code":
        return { status: 200, body: { ...(await exchangeAuthorizationCode(body, authorization, at)) } };
      case "refresh_token":
        return { status: 200, body: { ...(await refreshAccessToken(body, authorization, at)) } };
      default:
        throw oauthError("unsupported_grant_type", "grant_type authorization_code yoki refresh_token bo'lishi kerak");
    }
  } catch (error) {
    note(tokenFailures, clientIp, at.getTime(), TOKEN_FAILURES_PER_IP_PER_MIN);
    if (error instanceof OAuthError) {
      const headers = error.status === 401 ? { "WWW-Authenticate": 'Basic realm="socialauto"' } : undefined;
      return { status: error.status, body: { error: error.error, error_description: error.description }, headers };
    }
    if (error instanceof McpServiceError) return { status: 400, body: { error: "invalid_grant", error_description: error.message } };
    console.error("[MCP OAuth] token endpoint failed:", describeError(error));
    return { status: 500, body: { error: "server_error", error_description: "Kutilmagan xato — birozdan keyin qayta urinib ko'ring" } };
  }
}

const TOKEN_FIELDS: Array<keyof TokenRequestBody> = ["grant_type", "code", "redirect_uri", "client_id", "client_secret", "code_verifier", "refresh_token", "resource"];

/** Reads a token request body: form-urlencoded (the standard) or JSON (some clients). null = unreadable. */
export async function readTokenRequest(request: Request, maxBytes = 16 * 1024): Promise<TokenRequestBody | null> {
  const type = (request.headers.get("content-type") ?? "").toLowerCase();
  let text: string;
  try {
    text = await request.text();
  } catch {
    return null;
  }
  if (text.length > maxBytes) return null;
  const out: TokenRequestBody = {};
  if (type.includes("application/json")) {
    let json: unknown;
    try {
      json = JSON.parse(text);
    } catch {
      return null;
    }
    if (!json || typeof json !== "object" || Array.isArray(json)) return null;
    for (const key of TOKEN_FIELDS) {
      const value = (json as Record<string, unknown>)[key];
      if (typeof value === "string") out[key] = value;
    }
    return out;
  }
  const form = new URLSearchParams(text);
  for (const key of TOKEN_FIELDS) {
    const value = form.get(key);
    if (value !== null) out[key] = value;
  }
  return out;
}
