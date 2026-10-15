import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import { createKnowledgeEntry, firstIssue, knowledgeEntrySchema, listKnowledge } from "@/lib/javobai/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** What the AI sees for this account (preview lines) plus the editable entries. */
export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const result = await listKnowledge(auth.ctx.workspaceId, id);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk(result.data);
}

export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = knowledgeEntrySchema.safeParse(body);
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  const result = await createKnowledgeEntry(auth.ctx.workspaceId, id, parsed.data);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk({ entry: result.data }, 201);
}
