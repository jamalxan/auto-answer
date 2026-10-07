import { NextResponse } from "next/server";
import { auth } from "@/lib/auth";
import { isAdminEmail } from "@/lib/admin";
import { getDMQueue } from "@/lib/queue/client";

export const runtime = "nodejs";

// The DM queue is shared by every workspace, so clearing its failed jobs is a
// platform-admin action (ADMIN_EMAILS), not a per-workspace one. Failure
// detail is preserved in DmLog, so nothing is lost by dropping the job record.
export async function POST() {
  const session = await auth();
  if (!isAdminEmail(session?.user?.email)) {
    return NextResponse.json(
      { success: false, error: "Forbidden" },
      { status: 403 }
    );
  }

  const removed = await getDMQueue().clean(0, 1000, "failed");
  return NextResponse.json({ success: true, data: { removed: removed.length } });
}
