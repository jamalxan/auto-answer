import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireWorkspace } from "@/lib/channels/guard";
import { listWorkspaceAccounts } from "@/lib/triggers/comment-service";
import { createDmCampaign, dmCampaignSchema, firstIssue, listDmCampaigns } from "@/lib/triggers/dm-trigger-service";

export const dynamic = "force-dynamic";

/** ETAP 3 Direct / Story Mention campaigns (ad messages and ig.me links are Direct with a source filter). */
export async function GET() {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;

  const [campaigns, accounts] = await Promise.all([
    listDmCampaigns(auth.ctx.workspaceId),
    listWorkspaceAccounts(auth.ctx.workspaceId),
  ]);
  return jsonOk({ campaigns, accounts });
}

export async function POST(request: NextRequest) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = dmCampaignSchema.safeParse(body);
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  const result = await createDmCampaign(auth.ctx.workspaceId, parsed.data);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk({ campaign: result.data }, 201);
}
