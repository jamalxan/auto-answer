import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { readJson, requireFlows, respond } from "@/lib/developer/flows-guard";
import { deleteFlow, getFlow, renameFlow, run } from "@/lib/flows/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireFlows("read");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await run(() => getFlow(auth.ctx.workspaceId, id)));
}

export async function PATCH(request: NextRequest, { params }: Props) {
  const auth = await requireFlows("write");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  return respond(await run(() => renameFlow(auth.ctx.workspaceId, id, body)));
}

export async function DELETE(_request: NextRequest, { params }: Props) {
  const auth = await requireFlows("write");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const result = await run(() => deleteFlow(auth.ctx.workspaceId, id));
  if (!result.ok) return respond(result);
  return jsonOk({ deleted: true });
}
