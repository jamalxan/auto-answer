import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { parseBody, readJson, requireCrm, respond } from "@/lib/developer/crm-guard";
import { broadcastUpdateSchema, getBroadcast, updateBroadcast } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireCrm("view_contacts");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await getBroadcast(auth.ctx.workspaceId, id));
}

/** DRAFT only. */
export async function PATCH(request: NextRequest, { params }: Props) {
  const auth = await requireCrm("manage_campaigns", { write: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(broadcastUpdateSchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(await updateBroadcast(auth.ctx.workspaceId, id, parsed.data));
}
