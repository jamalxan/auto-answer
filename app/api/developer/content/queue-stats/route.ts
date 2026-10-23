import { jsonOk } from "@/lib/api-auth";
import { contentQueueCounts } from "@/lib/content/queue";
import { prisma } from "@/lib/db/client";
import { requireContent } from "@/lib/developer/content-guard";

export const dynamic = "force-dynamic";

const DAY_MS = 24 * 3_600_000;

/**
 * "Kontent navbati" (M10): the workspace's posts by pipeline stage, the
 * last 24 hours' outcomes, the next slot, and the BullMQ queue depth — so a
 * stuck worker shows up here before a customer notices a missed post.
 */
export async function GET() {
  const auth = await requireContent("view");
  if (!auth.ok) return auth.response;
  const { workspaceId } = auth.ctx;
  const since = new Date(Date.now() - DAY_MS);
  const [byStatus, failed24h, published24h, next, overdue, queues] = await Promise.all([
    prisma.scheduledPost.groupBy({ by: ["status"], where: { workspaceId, deletedAt: null }, _count: { _all: true } }),
    prisma.scheduledPost.count({ where: { workspaceId, deletedAt: null, status: "FAILED", updatedAt: { gte: since } } }),
    prisma.scheduledPost.count({ where: { workspaceId, deletedAt: null, status: { in: ["PUBLISHED", "PUBLISHED_MANUAL"] }, publishedAt: { gte: since } } }),
    prisma.scheduledPost.findFirst({ where: { workspaceId, deletedAt: null, status: "SCHEDULED", scheduledAt: { gte: new Date() } }, orderBy: { scheduledAt: "asc" }, select: { id: true, scheduledAt: true } }),
    prisma.scheduledPost.count({ where: { workspaceId, deletedAt: null, status: { in: ["SCHEDULED", "READY_TO_PUBLISH"] }, scheduledAt: { lt: new Date(Date.now() - 2 * 60_000) } } }),
    contentQueueCounts().catch(() => null),
  ]);
  const statuses = Object.fromEntries(byStatus.map((r) => [r.status, r._count._all]));
  return jsonOk({ statuses, failed24h, published24h, next, overdue, queues });
}
