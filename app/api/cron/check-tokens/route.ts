import { NextRequest, NextResponse } from "next/server";
import { checkAllAccountTokens } from "@/lib/meta/token-health";
import { isAuthorizedCronRequest } from "@/lib/cron-auth";

export const dynamic = "force-dynamic";

// Every 6 hours (scripts/cron.sh, vercel.json): verifies each Instagram token
// with a real Graph API call and flips broken ones so the UI stops claiming
// "Connected" while Meta answers with error 190.
export async function GET(request: NextRequest) {
  if (!isAuthorizedCronRequest(request)) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const summary = await checkAllAccountTokens();
  return NextResponse.json({ success: true, data: summary });
}
