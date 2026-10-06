import { NextRequest } from "next/server";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const lead = await prisma.lead.findFirst({
    where: { id, workspaceId: auth.ctx.workspaceId },
    include: {
      instagramAccount: { select: { username: true } },
      deliveries: {
        orderBy: { createdAt: "asc" },
        include: { integration: { select: { type: true, name: true } } },
      },
    },
  });
  if (!lead) return jsonError("Not found", 404);

  return jsonOk({
    lead: {
      id: lead.id,
      createdAt: lead.createdAt,
      name: lead.name,
      phoneE164: lead.phoneE164,
      igUsername: lead.igUsername,
      accountUsername: lead.instagramAccount.username,
      productInterest: lead.productInterest,
      extraField: lead.extraField,
      language: lead.language,
      status: lead.status,
      source: lead.source,
      campaignName: lead.campaignName,
      triggerKeyword: lead.triggerKeyword,
      postUrl: lead.postUrl,
      summary: lead.summary,
      transcript: lead.transcript,
      flag: lead.flag,
      isTest: lead.isTest,
      isRepeat: lead.isRepeat,
      repeatCount: lead.repeatCount,
      trackedLinkClicked: lead.trackedLinkClicked,
      contactedAt: lead.contactedAt,
      conversationId: lead.conversationId,
      deliveries: lead.deliveries.map((d) => ({
        id: d.id,
        type: d.integration.type,
        name: d.integration.name,
        kind: d.kind,
        status: d.status,
        attempts: d.attempts,
        lastError: d.lastError,
        externalUrl: d.externalUrl,
        sentAt: d.sentAt,
        nextAttemptAt: d.nextAttemptAt,
      })),
    },
    canManage: auth.ctx.role !== "MEMBER",
  });
}
