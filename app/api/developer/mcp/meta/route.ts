import { NextRequest } from "next/server";
import { jsonOk } from "@/lib/api-auth";
import { requireMcp } from "@/lib/developer/mcp-guard";
import { prisma } from "@/lib/db/client";
import { CONFIRM_TTL_MS, isMcpEnabled, MAX_BODY_BYTES, MAX_TOKENS_PER_WORKSPACE, RATE_LIMIT_PER_MIN, TOKEN_PREFIX } from "@/lib/mcp/config";
import { AUTHORIZATION_SERVER_METADATA_PATH, AUTHORIZE_PATH, PROTECTED_RESOURCE_METADATA_PATH } from "@/lib/mcp/oauth";
import { ALL_TOOLS } from "@/lib/mcp/tools";
import { canManageWorkspace } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

function originOf(request: NextRequest): string {
  const base = process.env.NEXTAUTH_URL?.trim();
  return (base ? base : request.nextUrl.origin).replace(/\/+$/, "");
}

/** Everything the screen needs once: kill switch, endpoint URL, limits, tools and the caller's rights. */
export async function GET(request: NextRequest) {
  const auth = await requireMcp("read");
  if (!auth.ok) return auth.response;
  const workspace = await prisma.workspace.findUnique({ where: { id: auth.ctx.workspaceId }, select: { id: true, name: true } });
  return jsonOk({
    enabled: isMcpEnabled(),
    endpoint: `${originOf(request)}/api/mcp`,
    oauth: {
      authorizationServer: `${originOf(request)}${AUTHORIZATION_SERVER_METADATA_PATH}`,
      protectedResource: `${originOf(request)}${PROTECTED_RESOURCE_METADATA_PATH}`,
      authorize: `${originOf(request)}${AUTHORIZE_PATH}`,
    },
    workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
    limits: { ratePerMin: RATE_LIMIT_PER_MIN, maxBodyBytes: MAX_BODY_BYTES, confirmMinutes: CONFIRM_TTL_MS / 60_000, maxTokens: MAX_TOKENS_PER_WORKSPACE, tokenPrefix: TOKEN_PREFIX },
    tools: ALL_TOOLS.map((t) => ({ name: t.name, scope: t.scope, kind: t.kind, description: t.description })),
    me: { canManage: canManageWorkspace(auth.ctx.role) },
  });
}
