import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import {
  backtrackInputSchema,
  firstIssue,
  listBacktrackRuns,
  NOT_FOUND,
  startCampaignBacktrack,
} from "@/lib/triggers/comment-service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const runs = await listBacktrackRuns(auth.ctx.workspaceId, id);
  if (!runs) return jsonError(NOT_FOUND, 404);
  return jsonOk({ runs });
}

/** Scan the campaign's posts back N (at most 7) days and queue matching comments. */
export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = backtrackInputSchema.safeParse(body);
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  const result = await startCampaignBacktrack(auth.ctx.workspaceId, id, parsed.data.days);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk(result.data, 202);
}
