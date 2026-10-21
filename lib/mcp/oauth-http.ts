/**
 * ETAP 12 — small HTTP helpers shared by the OAuth routes (kept out of the route
 * files so tests can call them with plain Requests).
 */

import { handleTokenRequest, OAuthError, readTokenRequest, registerClient } from "./oauth";

const NO_STORE = { "Cache-Control": "no-store", Pragma: "no-cache" } as const;

/** Metadata documents are public and may be fetched from a browser (MCP Inspector), so they carry CORS. */
const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, MCP-Protocol-Version",
  "Access-Control-Max-Age": "86400",
} as const;

export function metadataResponse(body: unknown): Response {
  if (body === null) return new Response(null, { status: 204, headers: CORS });
  return Response.json(body, { status: 200, headers: { ...CORS, "Cache-Control": "public, max-age=300" } });
}

/** Best-effort client address (first X-Forwarded-For hop / X-Real-IP); only used for throttling. */
export function clientIpOf(request: Request): string | null {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim() || "";
  return ip ? ip.slice(0, 64) : null;
}

export function oauthErrorResponse(error: string, description: string, status = 400, headers: Record<string, string> = {}): Response {
  return Response.json({ error, error_description: description }, { status, headers: { ...NO_STORE, ...headers } });
}

const MAX_REGISTER_BYTES = 16 * 1024;

/** POST /api/mcp/oauth/register (RFC 7591). */
export async function handleRegisterPost(request: Request): Promise<Response> {
  const length = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(length) && length > MAX_REGISTER_BYTES) return oauthErrorResponse("invalid_client_metadata", "So'rov juda katta", 413);
  let text: string;
  try {
    text = await request.text();
  } catch {
    return oauthErrorResponse("invalid_client_metadata", "So'rov tanasini o'qib bo'lmadi");
  }
  if (text.length > MAX_REGISTER_BYTES) return oauthErrorResponse("invalid_client_metadata", "So'rov juda katta", 413);
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return oauthErrorResponse("invalid_client_metadata", "JSON o'qib bo'lmadi");
  }
  try {
    const client = await registerClient(body, clientIpOf(request));
    return Response.json(client, { status: 201, headers: NO_STORE });
  } catch (error) {
    if (error instanceof OAuthError) return oauthErrorResponse(error.error, error.description, error.status, error.status === 429 ? { "Retry-After": "60" } : {});
    console.error("[MCP OAuth] register failed:", error instanceof Error ? error.name : typeof error);
    return oauthErrorResponse("server_error", "Kutilmagan xato — birozdan keyin qayta urinib ko'ring", 500);
  }
}

/** POST /api/mcp/oauth/token (RFC 6749 §4.1.3 / §6). */
export async function handleTokenPost(request: Request): Promise<Response> {
  const body = await readTokenRequest(request);
  if (!body) return oauthErrorResponse("invalid_request", "So'rov tanasi application/x-www-form-urlencoded yoki JSON bo'lishi kerak");
  const outcome = await handleTokenRequest(body, request.headers.get("authorization"), clientIpOf(request));
  return Response.json(outcome.body, { status: outcome.status, headers: { ...NO_STORE, ...(outcome.headers ?? {}) } });
}

export function methodNotAllowed(allow: string): Response {
  return oauthErrorResponse("invalid_request", `Faqat ${allow} qo'llab-quvvatlanadi`, 405, { Allow: allow });
}
