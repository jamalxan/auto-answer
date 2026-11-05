import { NextResponse } from "next/server";
import { getCurrentWorkspaceId } from "@/lib/auth";
import { prisma } from "@/lib/db/client";

export const runtime = "nodejs";

/**
 * The workspace's connected Instagram accounts — just enough for an account
 * selector. This is a single indexed query, unlike /api/dashboard/stats which
 * runs the full analytics aggregation. Pages that only need the account list
 * (e.g. the inbox) should use this so they aren't gated on heavy stats.
 */
export async function GET() {
  const workspaceId = await getCurrentWorkspaceId();
  if (!workspaceId) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  const instagramAccounts = await prisma.instagramAccount.findMany({
    where: { workspaceId },
    orderBy: { connectedAt: "desc" },
    select: { id: true, username: true, instagramId: true, name: true, tokenStatus: true, tokenExpiresAt: true, tokenLastError: true, canPublish: true, webhookSubscribed: true },
  });

  return NextResponse.json({
    success: true,
    data: {
      // Status fields feed the Channels page; the token itself never leaves the server.
      instagramAccounts: instagramAccounts.map(({ tokenLastError, ...a }) => ({ ...a, disconnected: tokenLastError === "Disconnected by user" })),
      selectedInstagramAccountId: instagramAccounts[0]?.id ?? null,
    },
  });
}
