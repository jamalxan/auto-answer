import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { parseBody, readJson, requireCrm, respond } from "@/lib/developer/crm-guard";
import { broadcastInputSchema, createBroadcast, listBroadcasts } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireCrm("view_contacts");
  if (!auth.ok) return auth.response;
  return jsonOk({ broadcasts: await listBroadcasts(auth.ctx.workspaceId) });
}

/** Creates a DRAFT; POST /broadcasts/[id]/schedule sends it. Permission: manage_campaigns (MANAGER+). */
export async function POST(request: NextRequest) {
  const auth = await requireCrm("manage_campaigns", { write: true });
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(broadcastInputSchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(await createBroadcast(auth.ctx.workspaceId, parsed.data, auth.ctx.userId), 201);
}
