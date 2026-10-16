import { jsonOk, requireWorkspace } from "@/lib/api-auth";
import { canManageWorkspace } from "@/lib/workspace-access";
import { prisma } from "@/lib/db/client";
import { serializeIntegration } from "@/lib/integrations/service";
import { LEAD_PIPELINE_TYPES } from "@/lib/integrations2/config";
import { getBotUsername, isTelegramConfigured } from "@/lib/telegram/api";
import { isFeatureEnabled } from "@/lib/assistant/profile";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;

  const [integrations, accounts, pending, dead] = await Promise.all([
    prisma.integration.findMany({
      // Bus-only types (Webhook / Sheets / Make / Zapier) live in /developer/integrations.
      where: { workspaceId: auth.ctx.workspaceId, type: { in: [...LEAD_PIPELINE_TYPES] } },
      include: { telegramChats: { orderBy: { createdAt: "asc" } } },
      orderBy: { createdAt: "asc" },
    }),
    prisma.instagramAccount.findMany({
      where: { workspaceId: auth.ctx.workspaceId },
      select: { id: true, username: true },
    }),
    prisma.leadDelivery.groupBy({
      by: ["integrationId"],
      where: { integration: { workspaceId: auth.ctx.workspaceId }, status: { in: ["PENDING", "FAILED"] } },
      _count: true,
    }),
    prisma.leadDelivery.groupBy({
      by: ["integrationId"],
      where: { integration: { workspaceId: auth.ctx.workspaceId }, status: "DEAD" },
      _count: true,
    }),
  ]);
  const pendingBy = new Map(pending.map((p) => [p.integrationId, p._count]));
  const deadBy = new Map(dead.map((p) => [p.integrationId, p._count]));

  return jsonOk({
    integrations: integrations.map((i) =>
      serializeIntegration(i, { pending: pendingBy.get(i.id) ?? 0, dead: deadBy.get(i.id) ?? 0 })
    ),
    accounts,
    canManage: canManageWorkspace(auth.ctx.role),
    telegramBotConfigured: isTelegramConfigured() && Boolean(getBotUsername()),
    enabled: isFeatureEnabled("integrations"),
  });
}
