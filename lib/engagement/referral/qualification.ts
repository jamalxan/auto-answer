/**
 * ETAP 9.3 — referral qualification: when does a PENDING friend count?
 *
 *   FIRST_MESSAGE  the friend writes their own DIRECT_MESSAGE with text (or taps a quick reply)
 *                  at/after the ref event. An empty messaging_referral — the link merely
 *                  opened — does NOT count (owner decision: first message).
 *   LEAD           CRM event `lead_created` for the friend
 *   PURCHASE       CRM event `stage_changed` into a WON stage for the friend
 *
 * Three entry points, all idempotent: CRM listeners (real time, module.ts),
 * the maintenance sweep (safety net, also re-drives QUALIFIED events whose
 * reward did not finish), and the owner's APPROVE of a flagged event.
 *
 * A flagged event whose condition is met stays PENDING (the flags are shown
 * to the owner, `rewardSnapshot.awaitingReview`) until reviewed; an unflagged
 * one goes QUALIFIED and is rewarded at once.
 */

import type { ReferralEvent, ReferralProgram, ReferralQualifier } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { isEngagementEnabled } from "../config";
import { isBlocked, mergeFlags, samePhone } from "./fraud";
import { needsRewardRedrive, redriveRewardSideEffects, rewardReferralEvent } from "./reward";

export const QUALIFY_SWEEP_BATCH = 300;
/** A friend who needs longer than this to write is not swept any more (the listeners still catch them). */
export const QUALIFY_SWEEP_DAYS = 14;
const RETRY_BATCH = 100;
/** REWARDED events younger than this are still being finished by their own run. */
const REDRIVE_GRACE_MS = 2 * 60_000;
/** Only recently rewarded events are re-driven (older ones are history). */
const REDRIVE_DAYS = 3;

export interface QualificationResult {
  checked: number;
  qualified: number;
  rewarded: number;
  awaitingReview: number;
  retried: number;
  /** REWARDED events whose tag / points step was run again. */
  redriven: number;
}

export type EvaluateOutcome = "none" | "awaiting_review" | "qualified" | "rewarded";

async function contactOf(program: ReferralProgram, contactId: string | null, igUserId: string) {
  if (contactId) {
    const byId = await prisma.crmContact.findFirst({ where: { id: contactId, workspaceId: program.workspaceId } });
    if (byId) return byId;
  }
  return prisma.crmContact.findUnique({
    where: { instagramAccountId_igUserId: { instagramAccountId: program.instagramAccountId, igUserId } },
  });
}

/** The friend's first real message: text, or a quick-reply / button tap (payload). */
export async function hasFirstMessage(event: ReferralEvent, program: ReferralProgram): Promise<boolean> {
  const source = await prisma.instagramEvent.findUnique({ where: { id: event.sourceEventId } });
  const since = source?.timestamp ?? event.createdAt;
  const messages = await prisma.instagramEvent.findMany({
    where: {
      instagramAccountId: program.instagramAccountId,
      senderId: event.refereeIgUserId,
      eventType: "DIRECT_MESSAGE",
      timestamp: { gte: since },
    },
    orderBy: { timestamp: "asc" },
    take: 20,
  });
  // The carrying event counts when it is itself a message (message.referral); an empty open does not.
  return messages.some((message) => Boolean(message.text?.trim()) || Boolean(message.payload));
}

async function hasLead(event: ReferralEvent, program: ReferralProgram): Promise<boolean> {
  const contact = await contactOf(program, event.refereeContactId, event.refereeIgUserId);
  if (!contact) return false;
  const deals = await prisma.crmDeal.findMany({ where: { contactId: contact.id, leadId: { not: null } }, select: { createdAt: true } });
  return deals.some((deal) => deal.createdAt >= event.createdAt);
}

async function hasPurchase(event: ReferralEvent, program: ReferralProgram): Promise<boolean> {
  const contact = await contactOf(program, event.refereeContactId, event.refereeIgUserId);
  if (!contact) return false;
  const deals = await prisma.crmDeal.findMany({ where: { contactId: contact.id, wonAt: { not: null } }, select: { wonAt: true } });
  return deals.some((deal) => deal.wonAt && deal.wonAt >= event.createdAt);
}

export async function isConditionMet(event: ReferralEvent, program: ReferralProgram): Promise<boolean> {
  switch (program.qualifier) {
    case "FIRST_MESSAGE":
      return hasFirstMessage(event, program);
    case "LEAD":
      return hasLead(event, program);
    case "PURCHASE":
      return hasPurchase(event, program);
    default:
      return false;
  }
}

/** Claim PENDING → QUALIFIED (one winner under concurrency), then reward. */
async function qualifyAndReward(
  event: ReferralEvent,
  by: ReferralQualifier,
  flags: string[],
  now: Date
): Promise<EvaluateOutcome> {
  const claim = await prisma.referralEvent.updateMany({
    where: { id: event.id, status: "PENDING" },
    data: { status: "QUALIFIED", qualifiedAt: now, qualifiedBy: by, fraudFlags: flags },
  });
  if (claim.count === 0) return "none";
  const reward = await rewardReferralEvent(event.id, now);
  return reward.rewarded ? "rewarded" : "qualified";
}

/**
 * Decide one PENDING event. `conditionKnownMet` is set by the listeners that
 * ARE the condition (lead_created, stage_changed WON).
 */
export async function evaluateReferralEvent(
  event: ReferralEvent,
  program: ReferralProgram,
  now: Date = new Date(),
  options: { conditionKnownMet?: boolean } = {}
): Promise<EvaluateOutcome> {
  if (event.status !== "PENDING") return "none";
  const met = options.conditionKnownMet ?? (await isConditionMet(event, program));
  if (!met) return "none";

  // The phone may have been captured after the ref: re-check SAME_PHONE now.
  let flags: string[] = [...event.fraudFlags];
  const [referrer, referee] = await Promise.all([
    contactOf(program, event.referrerContactId, event.referrerIgUserId),
    contactOf(program, event.refereeContactId, event.refereeIgUserId),
  ]);
  if (samePhone(referrer?.phoneE164, referee?.phoneE164)) flags = mergeFlags(flags, ["SAME_PHONE"]);

  const current = { fraudFlags: flags, reviewedAt: event.reviewedAt };
  if (isBlocked(current)) {
    const patch: Record<string, unknown> = {};
    if (flags.length !== event.fraudFlags.length) patch.fraudFlags = flags;
    if (!event.rewardSnapshot) patch.rewardSnapshot = { awaitingReview: true, conditionMetAt: now.toISOString(), qualifier: program.qualifier };
    if (Object.keys(patch).length > 0) await prisma.referralEvent.updateMany({ where: { id: event.id, status: "PENDING" }, data: patch });
    return "awaiting_review";
  }
  return qualifyAndReward(event, program.qualifier, flags, now);
}

/**
 * Owner approved a flagged event (the review hold is already lifted). A
 * QUALIFIED event is rewarded; a PENDING one goes through the normal condition
 * path: qualified and rewarded now only if the condition is already met, else
 * it stays PENDING for the listener / sweep.
 */
export async function forceQualifyAndReward(eventId: string, now: Date = new Date()): Promise<EvaluateOutcome> {
  const event = await prisma.referralEvent.findUnique({ where: { id: eventId } });
  if (!event) return "none";
  if (event.status === "PENDING") {
    const program = await prisma.referralProgram.findUnique({ where: { id: event.programId } });
    if (!program) return "none";
    return evaluateReferralEvent(event, program, now);
  }
  if (event.status === "QUALIFIED") {
    const reward = await rewardReferralEvent(event.id, now);
    return reward.rewarded ? "rewarded" : "qualified";
  }
  return "none";
}

function tally(result: QualificationResult, outcome: EvaluateOutcome) {
  if (outcome === "awaiting_review") result.awaitingReview++;
  else if (outcome === "qualified") result.qualified++;
  else if (outcome === "rewarded") {
    result.qualified++;
    result.rewarded++;
  }
}

/**
 * A CRM listener saw the friend do the qualifying thing. Looks up the friend's
 * PENDING event in the account's active program (only when its qualifier is
 * `qualifier`) and decides it.
 */
export async function qualifyReferee(
  input: { instagramAccountId: string; refereeIgUserId: string; qualifier: ReferralQualifier },
  now: Date = new Date()
): Promise<EvaluateOutcome> {
  if (!isEngagementEnabled()) return "none";
  const program = await prisma.referralProgram.findUnique({ where: { instagramAccountId: input.instagramAccountId } });
  if (!program || !program.active || program.qualifier !== input.qualifier) return "none";
  const event = await prisma.referralEvent.findUnique({
    where: { programId_refereeIgUserId: { programId: program.id, refereeIgUserId: input.refereeIgUserId } },
  });
  if (!event || event.status !== "PENDING") return "none";
  // The real-time FIRST_MESSAGE listener still verifies the message in the table; LEAD / PURCHASE ARE the condition.
  return evaluateReferralEvent(event, program, now, input.qualifier === "FIRST_MESSAGE" ? {} : { conditionKnownMet: true });
}

export async function runReferralQualification(now: Date = new Date()): Promise<QualificationResult> {
  const result: QualificationResult = { checked: 0, qualified: 0, rewarded: 0, awaitingReview: 0, retried: 0, redriven: 0 };
  if (!isEngagementEnabled()) return result;

  const programs = await prisma.referralProgram.findMany({ where: { active: true } });
  if (programs.length === 0) return result;
  const byId = new Map(programs.map((program) => [program.id, program]));
  const ids = [...byId.keys()];

  const pending = await prisma.referralEvent.findMany({
    where: {
      programId: { in: ids },
      status: "PENDING",
      createdAt: { gte: new Date(now.getTime() - QUALIFY_SWEEP_DAYS * 24 * 3600_000) },
    },
    orderBy: { createdAt: "desc" },
    take: QUALIFY_SWEEP_BATCH,
  });
  for (const event of pending) {
    const program = byId.get(event.programId);
    if (!program) continue;
    // Already met and waiting for the owner's decision: nothing to re-check.
    if (event.rewardSnapshot && isBlocked(event)) continue;
    result.checked++;
    try {
      tally(result, await evaluateReferralEvent(event, program, now));
    } catch (error) {
      console.error("[Engagement] referral qualification failed:", error instanceof Error ? error.message : error);
    }
  }

  // A QUALIFIED event whose reward did not finish (crash between the two steps) is driven again.
  const stuck = await prisma.referralEvent.findMany({
    where: { programId: { in: ids }, status: "QUALIFIED", rewardedAt: null },
    orderBy: { createdAt: "asc" },
    take: RETRY_BATCH,
  });
  for (const event of stuck) {
    if (isBlocked(event)) continue;
    result.retried++;
    const reward = await rewardReferralEvent(event.id, now);
    if (reward.rewarded) result.rewarded++;
  }

  // A REWARDED event whose tag / points step threw (or whose snapshot was never saved):
  // re-run only those idempotent steps.
  const rewarded = await prisma.referralEvent.findMany({
    where: {
      programId: { in: ids },
      status: "REWARDED",
      rewardedAt: { gte: new Date(now.getTime() - REDRIVE_DAYS * 24 * 3600_000), lte: new Date(now.getTime() - REDRIVE_GRACE_MS) },
    },
    orderBy: { rewardedAt: "desc" },
    take: QUALIFY_SWEEP_BATCH,
  });
  for (const event of rewarded) {
    if (!needsRewardRedrive(event)) continue;
    try {
      if (await redriveRewardSideEffects(event.id, now)) result.redriven++;
    } catch (error) {
      console.error("[Engagement] reward re-drive failed:", error instanceof Error ? error.message : error);
    }
  }
  return result;
}
