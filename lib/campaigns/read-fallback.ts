/**
 * The opening-DM read fallback (legacy engine): a person who READ an opening
 * DM and never tapped its button gets the reveal message five minutes later.
 *
 * A read receipt does not say WHICH message was read, so the fallback is
 * limited to opening DMs sent recently. Without that bound every later read —
 * of an operator or JavobAI reply months after the comment — re-sent the old
 * campaign's link, and it was delivered because the person had just written
 * to us (open messaging window).
 */

import type { Prisma } from "@/app/generated/prisma/client";

/** How long after the opening DM a read still counts as "read the opening DM". */
export const OPENING_DM_READ_WINDOW_MS = 24 * 60 * 60 * 1000;

export function openingDmReadWhere(instagramAccountId: string, userId: string, now: Date = new Date()): Prisma.DmLogWhereInput {
  return {
    commenterId: userId,
    status: "SENT",
    dmSentAt: { gte: new Date(now.getTime() - OPENING_DM_READ_WINDOW_MS) },
    // The reveal row ("reveal:<user>") is the answer itself, not an opening DM waiting for one.
    NOT: { commentId: { startsWith: "reveal:" } },
    automation: {
      isActive: true,
      openingDmEnabled: true,
      instagramAccount: { instagramId: instagramAccountId },
    },
  };
}
