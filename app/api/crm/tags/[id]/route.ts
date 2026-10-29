import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { readJson, requireCrm, respond } from "@/lib/developer/crm-guard";
import { deleteTag, run, updateTag } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Props) {
  const auth = await requireCrm("manage_campaigns", { write: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  return respond(await run(() => updateTag(auth.ctx.workspaceId, id, body)));
}

export async function DELETE(_request: NextRequest, { params }: Props) {
  const auth = await requireCrm("manage_campaigns", { write: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const result = await run(() => deleteTag(auth.ctx.workspaceId, id));
  if (!result.ok) return respond(result);
  return jsonOk({ deleted: true });
}
