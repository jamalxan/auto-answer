import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { parseBody, readJson, requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { getProgram, programQuerySchema, run, saveProgram } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

/** The referral program of one Instagram account (one per account), or { program: null }. */
export async function GET(request: NextRequest) {
  const auth = await requireEngagement("read");
  if (!auth.ok) return auth.response;
  const query = parseBody(programQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
  if (!query.ok) return respond(query);
  return respond(await run(async () => ({ program: await getProgram(auth.ctx.workspaceId, query.data.accountId) })));
}

/** ?accountId= ; body { name, active, qualifier, rewardRules, burstLimitPerDay } (the engine validates, 422). */
export async function PUT(request: NextRequest) {
  const auth = await requireEngagement("config");
  if (!auth.ok) return auth.response;
  const query = parseBody(programQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
  if (!query.ok) return respond(query);
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  return respond(await run(async () => ({ program: await saveProgram(auth.ctx.workspaceId, query.data.accountId, body) })));
}
