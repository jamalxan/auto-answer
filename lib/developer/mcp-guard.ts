import { NextRequest, NextResponse } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { isMcpEnabled, MCP_OFF_MESSAGE } from "@/lib/mcp/config";
import { McpServiceError } from "@/lib/mcp/errors";
import { readLimitedJson } from "@/lib/utils/limited-body";
import { canManageWorkspace } from "@/lib/workspace-access";
import { requireDeveloper, type DeveloperAuth } from "./access";

export { NOT_JSON } from "./crm-guard";

/**
 * Guards for /api/developer/mcp (ETAP 12). On top of the developer login and
 * the app session (requireDeveloper):
 *
 *   read    tokens, action log, meta: every role (the hash and codes are never selected)
 *   create  new token: workspace OWNER / ADMIN only (a token is a credential), 503 while MCP_DISABLED
 *   revoke  OWNER / ADMIN only; also allowed while the kill switch is on (a leaked token must always be killable)
 */
export type McpAccess = "read" | "create" | "revoke";

export async function requireMcp(access: McpAccess): Promise<DeveloperAuth> {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth;
  if (access !== "read" && !canManageWorkspace(auth.ctx.role)) {
    return { ok: false, response: jsonError("Tokenlarni faqat egasi yoki administrator boshqaradi", 403) };
  }
  if (access === "create" && !isMcpEnabled()) {
    return { ok: false, response: jsonError(MCP_OFF_MESSAGE, 503) };
  }
  return auth;
}

/** Small JSON object body (4 KB) or null when missing / malformed; 413 as `response`. */
export async function readSmallBody(request: NextRequest): Promise<{ body: object | null; response?: NextResponse }> {
  const result = await readLimitedJson(request, 4096);
  if (!result.ok) return { body: null, response: jsonError("So'rov juda katta", 413) };
  const value = result.value;
  return { body: value && typeof value === "object" && !Array.isArray(value) ? value : null };
}

/** Runs a service call and maps McpServiceError to the Uzbek message + status; anything else is a generic 500. */
export async function respondMcp<T>(fn: () => Promise<T>, status = 200): Promise<NextResponse> {
  try {
    return jsonOk(await fn(), status);
  } catch (error) {
    if (error instanceof McpServiceError) return jsonError(error.message, error.status);
    console.error("[MCP] developer route failed:", error instanceof Error ? error.name : typeof error);
    return jsonError("Kutilmagan xato — birozdan keyin qayta urinib ko'ring", 500);
  }
}
