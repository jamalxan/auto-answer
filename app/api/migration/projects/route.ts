import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { BODY_LIMITS, NOT_JSON, parseBody, readJsonObjectLimited, requireMigration, respondSafe } from "@/lib/developer/migration-guard";
import { connectManychat, connectSchema, listProjects, run } from "@/lib/migration/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireMigration("read");
  if (!auth.ok) return auth.response;
  return respondSafe(await run(() => listProjects(auth.ctx.workspaceId)));
}

/** Connect ManyChat: validates the key against api.manychat.com and stores it encrypted. */
export async function POST(request: NextRequest) {
  const auth = await requireMigration("write");
  if (!auth.ok) return auth.response;
  const { body, response } = await readJsonObjectLimited(request, BODY_LIMITS.small);
  if (response) return response;
  if (!body) return jsonError(NOT_JSON, 400);
  const parsed = parseBody(connectSchema, body);
  if (!parsed.ok) return jsonError(parsed.error, parsed.status);
  return respondSafe(await run(() => connectManychat(auth.ctx.workspaceId, parsed.data, auth.ctx.userId)), 201);
}
