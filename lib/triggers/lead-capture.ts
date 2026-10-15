/**
 * Phone quick replies whose payload did not come back.
 *
 * A LEAD_CAPTURE chip is sent with content_type `user_phone_number`: Instagram
 * fills in the person's number and sends it as the message text. The tap may
 * come back with quick_reply.payload = the number instead of our "c2:" payload,
 * so it cannot be recognised by the payload. Instead: a message whose text is
 * a phone number, from someone with a pending lead (findPendingLeadExecution),
 * is that tap.
 *
 * Used in two places that must agree, or the message gets two answers or none:
 *   - the webhook route claims such messages away from the DM keyword path and
 *     the assistant (findClaimedLeadPhoneMessages in ingest.ts);
 *   - the direct handler treats them as the LEAD_CAPTURE tap.
 *
 * Kept free of lib/meta imports (the webhook route and production worker load it).
 */

import { prisma } from "@/lib/db/client";
import { parsePhone } from "@/lib/leads/phone";

/** The reason cancelFollowUps records when the person writes (stop on reply). */
export const STOP_ON_REPLY_REASON = "Mijoz javob yozdi";
/** Meta's messaging window: the tap must still be inside it. */
const LEAD_WINDOW_MS = 24 * 3600_000;

/** The message text, when the whole of it is a phone number. */
export function phoneFromText(text: string | null | undefined): string | null {
  if (!text || text.length > 24) return null;
  return parsePhone(text)?.e164 ?? null;
}

/**
 * The latest comment execution for this person that is waiting for a phone:
 * private reply sent, button tapped within the last 24 hours, no lead yet,
 * not handed to an operator or stopped (a stop because the person wrote
 * something does not count — they may still share the number), on an active
 * campaign that offers a LEAD_CAPTURE quick reply. Null when there is none.
 *
 * `capturedBy`: the time of the message being handled. A retry of the event
 * that already stored the lead (leadCapturedAt = that time) still finds it,
 * so the thank-you can go out on the retry.
 */
export async function findPendingLeadExecution(
  instagramAccount: { id: string },
  senderId: string,
  now: Date = new Date(),
  capturedBy?: Date
) {
  const since = new Date(now.getTime() - LEAD_WINDOW_MS);
  return prisma.triggerExecution.findFirst({
    where: {
      status: "SENT",
      openedAt: { not: null },
      handedOffAt: null,
      AND: [
        capturedBy ? { OR: [{ leadCapturedAt: null }, { leadCapturedAt: capturedBy }] } : { leadCapturedAt: null },
        { OR: [{ openedAt: { gte: since } }, { lastInboundAt: { gte: since } }] },
        {
          OR: [
            { stoppedAt: null },
            { stopReason: STOP_ON_REPLY_REASON },
            // stopped by this very lead (stop on lead) on the earlier try
            ...(capturedBy ? [{ leadCapturedAt: capturedBy }] : []),
          ],
        },
      ],
      event: { instagramAccountId: instagramAccount.id, senderId, eventType: "COMMENT" },
      campaign: { active: true, quickReplies: { some: { action: "LEAD_CAPTURE" } } },
    },
    include: { campaign: true },
    orderBy: { openedAt: "desc" },
  });
}
