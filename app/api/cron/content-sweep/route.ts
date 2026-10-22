import { NextRequest, NextResponse } from "next/server";
import { isContentSchedulerEnabled } from "@/lib/content/config";
import { sweepContent } from "@/lib/content/sweep";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";

/**
 * ETAP 13 — the Content Scheduler sweeper, every minute from scripts/cron.sh
 * (the worker runs the same sweep in its maintenance tick; both are
 * idempotent). Re-queues due posts whose job vanished, fails posts past the
 * late window, sends manual-publish notices, binds manual posts.
 */
export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  if (!isContentSchedulerEnabled()) {
    return NextResponse.json({ success: true, data: { skipped: "CONTENT_SCHEDULER_DISABLED" } });
  }
  try {
    const data = await sweepContent();
    return NextResponse.json({ success: true, data });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Unknown error";
    console.error("[content-sweep] failed:", message);
    return NextResponse.json({ success: false, error: message }, { status: 500 });
  }
}
