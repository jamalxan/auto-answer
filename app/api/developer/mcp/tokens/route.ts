import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { NOT_JSON, readSmallBody, requireMcp, respondMcp } from "@/lib/developer/mcp-guard";
import { createToken, listTokens } from "@/lib/mcp/tokens";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireMcp("read");
  if (!auth.ok) return auth.response;
  return respondMcp(() => listTokens(auth.ctx.workspaceId));
}

/** Creates a token. The raw value is in this one answer only; it is never stored or listed again. */
export async function POST(request: NextRequest) {
  const auth = await requireMcp("create");
  if (!auth.ok) return auth.response;
  const { body, response } = await readSmallBody(request);
  if (response) return response;
  if (!body) return jsonError(NOT_JSON, 400);
  return respondMcp(() => createToken(auth.ctx.workspaceId, body, auth.ctx.userId), 201);
}
