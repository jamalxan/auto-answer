import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireWorkspace } from "@/lib/channels/guard";
import { firstIssue, quickRepliesInputSchema, saveDmQuickReplies } from "@/lib/triggers/dm-trigger-service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Replace-all save of the quick replies sent with the reply (no opening button needed: the window is open). */
export async function PUT(request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = quickRepliesInputSchema.safeParse(body);
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  const result = await saveDmQuickReplies(auth.ctx.workspaceId, id, parsed.data.quickReplies);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk({ quickReplies: result.data });
}
