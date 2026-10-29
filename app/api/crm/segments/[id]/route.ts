import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { readJson, requireCrm, respond } from "@/lib/developer/crm-guard";
import { deleteSegment, describeSegments, getSegment, run, updateSegment } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireCrm("view_contacts");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const result = await run(() => getSegment(auth.ctx.workspaceId, id));
  if (!result.ok) return respond(result);
  const descriptions = await describeSegments(auth.ctx.workspaceId, [result.data]);
  return jsonOk({ segment: { ...result.data, sentence: descriptions[result.data.id] ?? "" } });
}

export async function PATCH(request: NextRequest, { params }: Props) {
  const auth = await requireCrm("manage_campaigns", { write: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  return respond(await run(() => updateSegment(auth.ctx.workspaceId, id, body)));
}

export async function DELETE(_request: NextRequest, { params }: Props) {
  const auth = await requireCrm("manage_campaigns", { write: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const result = await run(() => deleteSegment(auth.ctx.workspaceId, id));
  if (!result.ok) return respond(result);
  return jsonOk({ deleted: true });
}
