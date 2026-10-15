import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import { firstIssue, simulateCommentDryRun, simulateInputSchema } from "@/lib/triggers/comment-service";

export const dynamic = "force-dynamic";

/** Dry run: which Comment 2.0 campaign would answer this comment. Sends and stores nothing. */
export async function POST(request: NextRequest) {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = simulateInputSchema.safeParse(body);
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  const result = await simulateCommentDryRun(auth.ctx.workspaceId, parsed.data);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk(result.data);
}
