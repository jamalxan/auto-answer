import { jsonOk } from "@/lib/api-auth";
import { requireMigration } from "@/lib/developer/migration-guard";
import { prisma } from "@/lib/db/client";
import { isMigrationEnabled, MAX_FLOW_TEXT, MAX_SCREENSHOT_BYTES, MAX_SCREENSHOTS } from "@/lib/migration/config";
import { FEATURE_CATALOG } from "@/lib/migration/catalog";
import { can, isReadOnlyRole, normalizeRole } from "@/lib/workspace-permissions";

export const dynamic = "force-dynamic";

/** Everything the wizard needs once: accounts, the feature catalogue, limits, kill switch, caller rights. */
export async function GET() {
  const auth = await requireMigration("read");
  if (!auth.ok) return auth.response;
  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId: auth.ctx.workspaceId },
    select: { id: true, username: true, tokenStatus: true },
    orderBy: { connectedAt: "asc" },
  });
  const canWrite = !isReadOnlyRole(auth.ctx.role) && can(auth.ctx.role, "manage_campaigns");
  return jsonOk({
    enabled: isMigrationEnabled(),
    accounts,
    catalog: FEATURE_CATALOG.map(({ key, category, label, status, maps_to, message, suggestion }) => ({
      key,
      category,
      label,
      status,
      mapsTo: maps_to ?? null,
      message,
      suggestion,
    })),
    limits: { maxFlowText: MAX_FLOW_TEXT, maxScreenshots: MAX_SCREENSHOTS, maxScreenshotBytes: MAX_SCREENSHOT_BYTES },
    me: { userId: auth.ctx.userId, role: normalizeRole(auth.ctx.role), canWrite },
  });
}
