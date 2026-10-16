import { jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { aiConversationLimit } from "@/lib/assistant/profile";
import { getLlmProvider } from "@/lib/assistant/llm/provider";
import { loadLlmStats } from "@/lib/assistant/llm/stats";
import { getLeadCards } from "@/lib/dashboard/stats";
import { loadDeliverySummary } from "@/lib/leads/undelivered";

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
    cards,
    failedRows,
    integrations,
    llmErrors,
    blocked,
    usage,
    workspace,
  ] = await Promise.all([
    getLeadCards(workspaceId),
    // B-32: dead, held (broken integration) and retrying rows: one source for every screen.
    loadDeliverySummary(workspaceId),
    prisma.integration.findMany({
      where: { workspaceId, type: { in: ["TELEGRAM", "AMOCRM", "BITRIX24"] } },
      select: { id: true, name: true, type: true, status: true, lastError: true, lastCheckedAt: true },
      orderBy: { createdAt: "asc" },
    }),
    // Same source as Diagnostics / Analytics: failed rows of llm_usage (lib/assistant/llm/stats.ts).
    loadLlmStats(workspaceId, since7),
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

  const templateUntil =
    workspace?.assistantTemplateOnlyUntil && workspace.assistantTemplateOnlyUntil.getTime() > now
      ? workspace.assistantTemplateOnlyUntil
      : null;

  return jsonOk({
    cards,
    deliveryErrors: failedRows.rows.slice(0, 15).map((d) => ({
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
      configured: getLlmProvider() !== null,
      errors7d: llmErrors.failures,
      calls7d: llmErrors.calls,
      errorRate7d: llmErrors.errorRate,
      p95LatencyMs7d: llmErrors.p95LatencyMs,
      blocked7d: blocked,
      templateOnlyUntil: templateUntil,
      aiUsed: workspace?.aiConversationsThisPeriod ?? 0,
      aiLimit: workspace ? aiConversationLimit(workspace) : 0,
      // Gemini lite calls cost fractions of a cent: two decimals would show $0.00 (B-37).
      costUsd30: (() => {
        const cost = Number(usage._sum.costUsd ?? 0);
        return cost > 0 && cost < 1 ? cost.toFixed(4) : cost.toFixed(2);
      })(),
    },
  });
}
