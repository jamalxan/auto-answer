import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { readJson, requireCrm, respond } from "@/lib/developer/crm-guard";
import { createTag, listTags, run } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireCrm("view_contacts");
  if (!auth.ok) return auth.response;
  return jsonOk({ tags: await listTags(auth.ctx.workspaceId) });
}

export async function POST(request: NextRequest) {
  const auth = await requireCrm("manage_campaigns", { write: true });
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  return respond(await run(() => createTag(auth.ctx.workspaceId, body)), 201);
}
