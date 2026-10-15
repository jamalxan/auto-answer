import { NextRequest, NextResponse } from "next/server";
import { runAllOwnerNotifications } from "@/lib/telegram/owner-notifications";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

// Hourly. Each notification limits itself (daily gap digest at 10:00, monthly
// price reminder at 11:00, one onboarding nudge per stalled session).
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }
  const data = await runAllOwnerNotifications();
  return NextResponse.json({ success: true, data });
}
