import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireWorkspace } from "@/lib/channels/guard";
import {
  commentCampaignSchema,
  createCommentCampaign,
  firstIssue,
  listCommentCampaigns,
  listLegacyAutomations,
  listWorkspaceAccounts,
} from "@/lib/triggers/comment-service";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;

  const [campaigns, accounts, legacy] = await Promise.all([
    listCommentCampaigns(auth.ctx.workspaceId),
    listWorkspaceAccounts(auth.ctx.workspaceId),
    // Production (old) campaigns, read-only (B-34).
    listLegacyAutomations(auth.ctx.workspaceId).catch(() => []),
  ]);
  return jsonOk({ campaigns, accounts, legacy });
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = commentCampaignSchema.safeParse(body);
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  const result = await createCommentCampaign(auth.ctx.workspaceId, parsed.data);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk({ campaign: result.data }, 201);
}
