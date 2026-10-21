/**
 * ETAP 12 — the HTTP side of /api/mcp, kept out of the route file so tests can
 * call it with a plain Request. Order matters: kill switch, cheap size check,
 * token auth, streamed body cap, then the JSON-RPC handler.
 *
 * This route is NOT behind the developer login or the app session: the bearer
 * token is the credential. proxy.ts only guards listed page prefixes, so
 * /api/mcp needs no exemption (same as /api/webhooks).
 */

import { authenticateMcp, MISSING_TOKEN } from "./auth";
import { isMcpEnabled, MAX_BODY_BYTES, MCP_OFF_MESSAGE } from "./config";
import { publicOrigin, wwwAuthenticate } from "./oauth";
import { handleRpc, RPC } from "./protocol";
import { declaredTooLarge, readLimitedJson } from "@/lib/utils/limited-body";

const NO_STORE = { "Cache-Control": "no-store" } as const;

function error(status: number, message: string, headers: Record<string, string> = {}): Response {
  return Response.json({ success: false, error: message }, { status, headers: { ...NO_STORE, ...headers } });
}

function rpcFailure(status: number, code: number, message: string): Response {
  return Response.json({ jsonrpc: "2.0", id: null, error: { code, message } }, { status, headers: NO_STORE });
}

export const TOO_LARGE = `So'rov juda katta (${MAX_BODY_BYTES / 1024} KB dan oshmasin)`;

export function methodNotAllowed(): Response {
  // Streamable HTTP lets a server refuse the GET stream with 405 (no server-initiated messages here).
  return error(405, "Faqat POST qo'llab-quvvatlanadi (MCP Streamable HTTP, JSON javob)", { Allow: "POST, OPTIONS" });
}

/** Best-effort client address (first X-Forwarded-For hop / X-Real-IP); only used to throttle bad token guesses. */
function clientIpOf(request: Request): string | null {
  const ip = request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || request.headers.get("x-real-ip")?.trim() || "";
  return ip ? ip.slice(0, 64) : null;
}

export async function handleMcpPost(request: Request): Promise<Response> {
  if (!isMcpEnabled()) return error(503, MCP_OFF_MESSAGE, { "Retry-After": "300" });
  if (declaredTooLarge(request.headers, MAX_BODY_BYTES)) return error(413, TOO_LARGE);

  const auth = await authenticateMcp(request.headers.get("authorization"), new Date(), clientIpOf(request));
  if (!auth.ok) {
    // A 401 names the protected-resource metadata, which is how an MCP client
    // (Claude.ai / Claude Desktop connectors, ChatGPT, Claude Code) finds the OAuth flow.
    const headers: Record<string, string> =
      auth.status === 401
        ? { "WWW-Authenticate": wwwAuthenticate(publicOrigin(request), auth.error === MISSING_TOKEN ? undefined : "invalid_token") }
        : { "Retry-After": String(auth.retryAfterSec ?? 60) };
    return error(auth.status, auth.error, headers);
  }

  const body = await readLimitedJson(request, MAX_BODY_BYTES);
  if (!body.ok) return error(413, TOO_LARGE);
  if (body.value === undefined || body.value === null) return rpcFailure(400, RPC.parse, "JSON o'qib bo'lmadi: tanada to'g'ri JSON-RPC xabari bo'lishi kerak");

  const outcome = await handleRpc(auth.ctx, body.value);
  if (outcome.body === null) return new Response(null, { status: outcome.status, headers: NO_STORE });
  return Response.json(outcome.body, { status: outcome.status, headers: NO_STORE });
}
