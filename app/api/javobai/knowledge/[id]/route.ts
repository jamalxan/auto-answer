import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireWorkspace } from "@/lib/channels/guard";
import { deleteKnowledgeEntry, firstIssue, knowledgeEntryPatchSchema, updateKnowledgeEntry } from "@/lib/javobai/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = knowledgeEntryPatchSchema.safeParse(body);
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  const result = await updateKnowledgeEntry(auth.ctx.workspaceId, id, parsed.data);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk({ entry: result.data });
}

export async function DELETE(_request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const result = await deleteKnowledgeEntry(auth.ctx.workspaceId, id);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk(result.data);
}
