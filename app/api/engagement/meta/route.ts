import { jsonOk } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { requireEngagement } from "@/lib/developer/engagement-guard";
import {
  BACKFILL_CAP,
  DEFAULT_BADGES,
  DEFAULT_POINTS_RULES,
  DEFAULT_RULES,
  FRAUD_FLAG_LABELS,
  MAX_WINDOW_DAYS,
  POINT_REASON_LABELS,
  RULE_VERIFIABILITY,
  isEngagementEnabled,
} from "@/lib/engagement/service";
import { PERMISSION_LABELS, ROLE_LABELS, can, normalizeRole, permissionsOf } from "@/lib/workspace-permissions";

export const dynamic = "force-dynamic";

/** Everything the screens need in one call: accounts, Comment 2.0 campaigns (confirmation link), permissions, rule verifiability, defaults, kill switch. */
export async function GET() {
  const auth = await requireEngagement("read");
  if (!auth.ok) return auth.response;
  const { workspaceId, role } = auth.ctx;
  const [accounts, campaigns] = await Promise.all([
    prisma.instagramAccount.findMany({
      where: { workspaceId },
      orderBy: { connectedAt: "desc" },
      select: { id: true, username: true, tokenStatus: true },
    }),
    prisma.triggerCampaign.findMany({
      where: { workspaceId, triggerType: "COMMENT" },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: { id: true, name: true, instagramAccountId: true, active: true },
    }),
  ]);
  return jsonOk({
    disabled: !isEngagementEnabled(),
    me: {
      role,
      normalizedRole: normalizeRole(role),
      roleLabel: ROLE_LABELS[normalizeRole(role)],
      permissions: permissionsOf(role),
      canManage: can(role, "manage_campaigns"),
      canExport: can(role, "export_data"),
    },
    accounts,
    campaigns,
    verifiability: RULE_VERIFIABILITY,
    defaults: {
      rules: DEFAULT_RULES,
      pointsRules: DEFAULT_POINTS_RULES,
      badgeRules: DEFAULT_BADGES,
    },
    limits: { maxWindowDays: MAX_WINDOW_DAYS, backfillCap: BACKFILL_CAP, maxWinners: 50, maxBackups: 20 },
    labels: { permission: PERMISSION_LABELS, pointReason: POINT_REASON_LABELS, fraudFlag: FRAUD_FLAG_LABELS },
  });
}
