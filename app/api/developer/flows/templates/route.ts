import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { readJson, requireFlows, respond } from "@/lib/developer/flows-guard";
import { listTemplates, run, saveAsTemplate } from "@/lib/flows/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireFlows("read");
  if (!auth.ok) return auth.response;
  return respond(await run(async () => ({ templates: await listTemplates(auth.ctx.workspaceId) })));
}

export async function POST(request: NextRequest) {
  const auth = await requireFlows("write");
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  return respond(await run(() => saveAsTemplate(auth.ctx.workspaceId, body)), 201);
}
