/**
 * What happens when Meta tells us an Instagram user removed the app
 * (deauthorize) or asked for their data to be deleted.
 *
 * Both match the in-app "Disconnect": the token is wiped and the account
 * shows as disconnected, while the workspace's own records (campaigns, DM
 * logs, leads) stay. A deletion request additionally removes what we copied
 * from that Instagram account: its DM conversations and follower history.
 */

import { createHash } from "node:crypto";
import { prisma } from "@/lib/db/client";

async function disconnect(instagramUserId: string, reason: string) {
  const now = new Date();
  return prisma.instagramAccount.updateMany({
    where: { instagramId: instagramUserId },
    data: {
      accessToken: "",
      tokenExpiresAt: null,
      webhookSubscribed: false,
      tokenStatus: "BROKEN",
      tokenCheckedAt: now,
      tokenLastError: reason,
      tokenBrokenAt: now,
      tokenAlertedAt: now,
    },
  });
}

export async function deauthorizeInstagramUser(instagramUserId: string): Promise<number> {
  const result = await disconnect(instagramUserId, "App removed in Instagram (Meta deauthorize callback)");
  return result.count;
}

/** Stable code for one request, so the status page can be shown again later. */
export function deletionConfirmationCode(instagramUserId: string, issuedAt: number | undefined): string {
  return createHash("sha256")
    .update(`${instagramUserId}:${issuedAt ?? ""}`)
    .digest("hex")
    .slice(0, 16)
    .toUpperCase();
}

export async function deleteInstagramUserData(instagramUserId: string): Promise<number> {
  const accounts = await prisma.instagramAccount.findMany({
    where: { instagramId: instagramUserId },
    select: { id: true },
  });
  const ids = accounts.map((a) => a.id);
  if (ids.length) {
    await prisma.$transaction([
      // Messages go with their conversation (onDelete: Cascade).
      prisma.conversation.deleteMany({ where: { instagramAccountId: { in: ids } } }),
      prisma.followerSnapshot.deleteMany({ where: { instagramAccountId: { in: ids } } }),
      prisma.instagramAccount.updateMany({ where: { id: { in: ids } }, data: { name: null } }),
    ]);
  }
  await disconnect(instagramUserId, "Data deleted on request (Meta data deletion callback)");
  return ids.length;
}
