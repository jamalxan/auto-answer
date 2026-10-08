import { NextRequest, NextResponse } from "next/server";
import { learnForAllEnabledProfiles } from "@/lib/assistant/learning";

export const dynamic = "force-dynamic";
export const maxDuration = 300;

// Daily (scripts/cron.sh): re-learn the managers' style for every profile with
// learning switched on, so new operator replies keep shaping the assistant.
export async function GET(request: NextRequest) {
  const cronSecret = process.env.CRON_SECRET || process.env.NEXTAUTH_SECRET;
  if (request.headers.get("authorization") !== `Bearer ${cronSecret}`) {
    return NextResponse.json({ success: false, error: "Unauthorized" }, { status: 401 });
  }

  const summary = await learnForAllEnabledProfiles();
  return NextResponse.json({ success: true, data: summary });
}
