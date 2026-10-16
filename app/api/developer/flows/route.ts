import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { readJson, requireFlows, respond } from "@/lib/developer/flows-guard";
import { createFlow, listFlows, run } from "@/lib/flows/service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireFlows("read");
  if (!auth.ok) return auth.response;
  const params = request.nextUrl.searchParams;
  const status = params.get("status") ?? undefined;
  const accountId = params.get("accountId") ?? undefined;
  return respond(await run(async () => ({ flows: await listFlows(auth.ctx.workspaceId, { status, accountId }) })));
}

export async function POST(request: NextRequest) {
  const auth = await requireFlows("write");
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  return respond(await run(() => createFlow(auth.ctx.workspaceId, body, { userId: auth.ctx.userId })), 201);
}
