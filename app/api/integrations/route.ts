import { jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { serializeIntegration } from "@/lib/integrations/service";
import { getBotUsername, isTelegramConfigured } from "@/lib/telegram/api";
import { isFeatureEnabled } from "@/lib/assistant/profile";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;

  const [integrations, accounts, pending, dead] = await Promise.all([
    prisma.integration.findMany({
      where: { workspaceId: auth.ctx.workspaceId },
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
    canManage: auth.ctx.role !== "MEMBER",
    telegramBotConfigured: isTelegramConfigured() && Boolean(getBotUsername()),
    enabled: isFeatureEnabled("integrations"),
  });
}
