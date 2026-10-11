import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { requireTriggerDev } from "@/lib/triggers/access";
import { campaignInputSchema, createCampaign, firstIssue, listCampaigns } from "@/lib/triggers/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireTriggerDev();
  if (!auth.ok) return auth.response;

  const [campaigns, accounts] = await Promise.all([
    listCampaigns(auth.ctx.workspaceId),
    prisma.instagramAccount.findMany({
      where: { workspaceId: auth.ctx.workspaceId },
      orderBy: { connectedAt: "desc" },
      select: { id: true, username: true, tokenStatus: true },
    }),
  ]);
  return jsonOk({ campaigns, accounts });
}

export async function POST(request: NextRequest) {
  const auth = await requireTriggerDev(true);
  if (!auth.ok) return auth.response;

  const parsed = campaignInputSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  const result = await createCampaign(auth.ctx.workspaceId, parsed.data);
  if (!result.ok) return jsonError(result.error, 400);
  return jsonOk({ campaign: result.campaign }, 201);
}
