import { jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { aiConversationLimit } from "@/lib/assistant/profile";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * One call for the dashboard cards (leads, phone-capture rate, undelivered) and
 * the diagnostics sections (delivery errors, integration health, LLM/fallback).
 */
export async function GET() {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  const workspaceId = auth.ctx.workspaceId;
  const now = Date.now();
  const since30 = new Date(now - 30 * DAY_MS);
  const since7 = new Date(now - 7 * DAY_MS);

  const [
    leadsCount,
    assistantChats,
    capturedWithPhone,
    deadDeliveries,
    heldDeliveries,
    failedRows,
    integrations,
    llmErrors,
    blocked,
    usage,
    workspace,
  ] = await Promise.all([
    prisma.lead.count({ where: { workspaceId, isTest: false, createdAt: { gte: since30 } } }),
    prisma.conversation.count({ where: { workspaceId, botMessageCount: { gt: 0 }, createdAt: { gte: since30 } } }),
    prisma.lead.count({
      where: {
        workspaceId,
        isTest: false,
        phoneE164: { not: null },
        createdAt: { gte: since30 },
        conversation: { botMessageCount: { gt: 0 } },
      },
    }),
    prisma.leadDelivery.count({ where: { lead: { workspaceId, isTest: false }, status: "DEAD" } }),
    prisma.leadDelivery.count({
      where: {
        lead: { workspaceId, isTest: false },
        status: { in: ["PENDING", "FAILED"] },
        integration: { status: "BROKEN" },
      },
    }),
    prisma.leadDelivery.findMany({
      where: { lead: { workspaceId }, status: { in: ["DEAD", "FAILED"] } },
      orderBy: { updatedAt: "desc" },
      take: 15,
      select: {
        id: true,
        leadId: true,
        status: true,
        attempts: true,
        lastError: true,
        updatedAt: true,
        integration: { select: { name: true, type: true } },
        lead: { select: { name: true, phoneE164: true } },
      },
    }),
    prisma.integration.findMany({
      where: { workspaceId },
      select: { id: true, name: true, type: true, status: true, lastError: true, lastCheckedAt: true },
      orderBy: { createdAt: "asc" },
    }),
    prisma.assistantEvent.count({ where: { workspaceId, type: "llm_error", createdAt: { gte: since7 } } }),
    prisma.assistantEvent.count({ where: { workspaceId, type: "blocked_reply", createdAt: { gte: since7 } } }),
    prisma.llmUsage.aggregate({
      where: { workspaceId, createdAt: { gte: since30 } },
      _sum: { costUsd: true },
    }),
    prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { assistantTemplateOnlyUntil: true, aiConversationsThisPeriod: true, aiConversationsLimit: true },
    }),
  ]);

  const conversionPct = assistantChats > 0 ? Math.round((capturedWithPhone / assistantChats) * 100) : 0;
  const templateUntil =
    workspace?.assistantTemplateOnlyUntil && workspace.assistantTemplateOnlyUntil.getTime() > now
      ? workspace.assistantTemplateOnlyUntil
      : null;

  return jsonOk({
    cards: {
      leads30: leadsCount,
      conversionPct,
      assistantChats,
      undelivered: deadDeliveries + heldDeliveries,
    },
    deliveryErrors: failedRows.map((d) => ({
      id: d.id,
      leadId: d.leadId,
      status: d.status,
      attempts: d.attempts,
      lastError: d.lastError,
      updatedAt: d.updatedAt,
      integration: d.integration.name,
      type: d.integration.type,
      leadName: d.lead.name,
    })),
    integrations: integrations.map((i) => ({
      id: i.id,
      name: i.name,
      type: i.type,
      status: i.status,
      lastError: i.lastError,
      lastCheckedAt: i.lastCheckedAt,
    })),
    llm: {
      errors7d: llmErrors,
      blocked7d: blocked,
      templateOnlyUntil: templateUntil,
      aiUsed: workspace?.aiConversationsThisPeriod ?? 0,
      aiLimit: workspace ? aiConversationLimit(workspace) : 0,
      costUsd30: Number(usage._sum.costUsd ?? 0).toFixed(2),
    },
  });
}
