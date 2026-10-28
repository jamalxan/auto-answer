import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireWorkspace } from "@/lib/channels/guard";
import { dmFollowUpsInputSchema, firstIssue, saveDmFollowUpSteps } from "@/lib/triggers/dm-trigger-service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Replace-all save of the follow-up steps (counted from the reply). */
export async function PUT(request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = dmFollowUpsInputSchema.safeParse(body);
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  const result = await saveDmFollowUpSteps(auth.ctx.workspaceId, id, parsed.data.steps);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk({ steps: result.data });
}
