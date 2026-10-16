import { jsonOk } from "@/lib/api-auth";
import { describeAlertRules } from "@/lib/analytics/alerts";
import { loadKpi } from "@/lib/analytics/kpi";
import { requireAnalytics } from "@/lib/developer/analytics-guard";
import { isPlatformAdminUser, redactKpiForViewer } from "@/lib/analytics/kpi-access";

export const dynamic = "force-dynamic";

/** Observability tiles (TZ 65) plus the alert rules with their last alert time. Never fails as a whole. */
export async function GET() {
  const auth = await requireAnalytics();
  if (!auth.ok) return auth.response;
  const [kpi, alertRules, platformAdmin] = await Promise.all([
    loadKpi(auth.ctx.workspaceId),
    describeAlertRules(auth.ctx.workspaceId),
    isPlatformAdminUser(auth.ctx.userId).catch(() => false),
  ]);
  // Platform-wide queue depths: platform admins only (B-23).
  return jsonOk({ ...redactKpiForViewer(kpi, platformAdmin), alertRules });
}
