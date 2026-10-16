/**
 * B-23: queue depths are PLATFORM-wide (every workspace's jobs share the same
 * BullMQ queues), so only platform admins (ADMIN_EMAILS) may see them. A
 * workspace user / developer of a tenant gets the workspace-scoped tiles only.
 */

import { prisma } from "@/lib/db/client";
import { isAdminEmail } from "@/lib/admin";
import type { KpiData } from "./kpi";

export function redactKpiForViewer<T extends Pick<KpiData, "queueDepths" | "failed">>(
  kpi: T,
  isPlatformAdmin: boolean
): T & { queueDepthsRestricted: boolean } {
  if (isPlatformAdmin) return { ...kpi, queueDepthsRestricted: false };
  return {
    ...kpi,
    queueDepths: null,
    failed: kpi.failed.filter((key) => key !== "queueDepths"),
    queueDepthsRestricted: true,
  };
}

export async function isPlatformAdminUser(userId: string): Promise<boolean> {
  const user = await prisma.user.findUnique({ where: { id: userId }, select: { email: true } });
  return isAdminEmail(user?.email);
}
