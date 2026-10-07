import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/db/client";
import {
  canManageWorkspace,
  getCurrentWorkspaceContext,
} from "@/lib/workspace-access";

export async function POST(request: NextRequest) {
  const context = await getCurrentWorkspaceContext();
  if (!context) {
    return NextResponse.json(
      { success: false, error: "Unauthorized" },
      { status: 401 }
    );
  }

  if (!canManageWorkspace(context.role)) {
    return NextResponse.json(
      { success: false, error: "Only owners and admins can disconnect accounts" },
      { status: 403 }
    );
  }

  const body = await request.json().catch(() => ({}));
  const instagramAccountId =
    typeof body.instagramAccountId === "string" ? body.instagramAccountId : null;

  // Soft disconnect: keep the account row. Deleting it would cascade away every
  // campaign, DM log, conversation and lead. Dropping the token stops all
  // sending/reading; reconnecting later reuses the row (same id) via upsert in
  // the OAuth callback, so the campaigns come back working.
  const now = new Date();
  await prisma.instagramAccount.updateMany({
    where: {
      workspaceId: context.workspaceId,
      ...(instagramAccountId ? { id: instagramAccountId } : {}),
    },
    data: {
      accessToken: "",
      tokenExpiresAt: null,
      webhookSubscribed: false,
      tokenStatus: "BROKEN",
      tokenCheckedAt: now,
      tokenLastError: "Disconnected by user",
      tokenBrokenAt: now,
      tokenAlertedAt: now,
    },
  });

  return NextResponse.json({ success: true });
}
