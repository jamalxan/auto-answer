import { NextRequest, NextResponse } from "next/server";
import { runAlertsForAll } from "@/lib/analytics/alerts";
import { isAnalyticsEnabled } from "@/lib/analytics/queue";
import { rollupAll, trailingDays } from "@/lib/analytics/rollup";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

/**
 * Nightly at 00:15 Asia/Tashkent: recompute the trailing 3 days of every
 * workspace (late handoffs, sales and test-lead cleanups catch up). The
 * incremental yesterday+today run lives in the worker's maintenance tick.
 *
 * `?task=alerts` evaluates the monitoring alerts instead. The worker runs them
 * too, but a dead worker cannot report itself, so the scheduler calls this
 * from the web process every few minutes (scripts/cron.sh).
 */
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!isAnalyticsEnabled()) {
    return NextResponse.json({ success: true, data: { skipped: "ANALYTICS_DISABLED" } });
  }

  if (request.nextUrl.searchParams.get("task") === "alerts") {
    const results = await runAlertsForAll();
    return NextResponse.json({
      success: true,
      data: { workspaces: results.length, fired: results.reduce((sum, r) => sum + r.fired.length, 0) },
    });
  }

  const result = await rollupAll(trailingDays(new Date(), 3));
  return NextResponse.json({ success: true, data: result });
}
