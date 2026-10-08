import { NextRequest, NextResponse } from "next/server";
import { getCurrentUserId, getCurrentWorkspaceId } from "@/lib/auth";
import { getDashboardStats } from "@/lib/dashboard/stats";
import { getServerLocale } from "@/lib/i18n/get-locale";

export async function GET(request: NextRequest) {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const requested = request.nextUrl.searchParams.get("instagramAccountId");
  const data = await getDashboardStats({
    workspaceId,
    userId: await getCurrentUserId(),
    locale: await getServerLocale(),
    selectedAccountId: requested && requested !== "all" ? requested : null,
  });

  return NextResponse.json({ success: true, data });
}
