import { NextRequest } from "next/server";
import { jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { readCollected } from "@/lib/leads/service";

export const dynamic = "force-dynamic";

/**
 * Assistant status for one inbox thread: badge (assistant / operator / lead
 * captured), the pause switch and the lead panel (name, phone, interest,
 * campaign, CRM links).
 */
export async function GET(request: NextRequest) {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  // Deep links (Telegram button, Leads page) carry our conversation id; resolve
  // it to the Instagram account + customer so the inbox can open that thread.
  const byId = request.nextUrl.searchParams.get("conversationId");
  if (byId) {
    const found = await prisma.conversation.findFirst({
      where: { id: byId, workspaceId: auth.ctx.workspaceId },
      select: { instagramAccountId: true, igUserId: true },
    });
    return jsonOk({ resolved: found });
  }

  const accountId = request.nextUrl.searchParams.get("instagramAccountId");
  const contactId = request.nextUrl.searchParams.get("contactId");
  if (!accountId || !contactId) return jsonOk({ conversation: null, lead: null });

  const conversation = await prisma.conversation.findFirst({
    where: { workspaceId: auth.ctx.workspaceId, instagramAccountId: accountId, igUserId: contactId },
  });
  if (!conversation) return jsonOk({ conversation: null, lead: null, canManage: auth.ctx.role !== "MEMBER" });

  const lead = await prisma.lead.findFirst({
    where: { workspaceId: auth.ctx.workspaceId, conversationId: conversation.id },
    orderBy: { createdAt: "desc" },
    include: {
      deliveries: {
        where: { status: "SENT", externalUrl: { not: null } },
        include: { integration: { select: { type: true } } },
      },
    },
  });

  const now = new Date();
  const operatorActive = Boolean(conversation.operatorActiveUntil && conversation.operatorActiveUntil > now);
  const collected = readCollected(conversation.collected);

  return jsonOk({
    canManage: auth.ctx.role !== "MEMBER",
    conversation: {
      id: conversation.id,
      assistantState: conversation.assistantState,
      botPaused: conversation.botPaused,
      operatorActive,
      operatorActiveUntil: conversation.operatorActiveUntil,
      badge: lead ? "lead" : operatorActive || conversation.botPaused ? "operator" : "assistant",
      collected: {
        name: collected.name ?? null,
        phone: collected.phone_e164 ?? null,
        productInterest: collected.product_interest ?? null,
      },
    },
    lead: lead
      ? {
          id: lead.id,
          name: lead.name,
          phoneE164: lead.phoneE164,
          productInterest: lead.productInterest,
          campaignName: lead.campaignName,
          flag: lead.flag,
          crmLinks: lead.deliveries.map((d) => ({
            type: d.integration.type,
            url: d.externalUrl,
          })),
        }
      : null,
  });
}
