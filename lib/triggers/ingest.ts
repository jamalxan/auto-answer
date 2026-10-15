/**
 * Webhook → InstagramEvent rows → queue.
 *
 * Called from the webhook route BEFORE the DM keyword path and the assistant,
 * inside its own try/catch. For DMs, story mentions and referral messages it
 * also makes the one ETAP 3 decision "which DIRECT_MESSAGE / STORY_MENTION
 * campaign answers this?" (claim.ts decideDmTrigger) and stores it with the
 * event (claimedCampaignId); the route keeps exactly the claimed events away
 * from those production paths. Per person (account + sender) the decision and
 * the insert run under a Postgres advisory transaction lock, so two webhooks
 * for one person cannot both claim inside one cooldown. Any failure there
 * claims nothing (the event is still stored, unclaimed): production answers.
 *
 * Duplicate protection, layer one: InstagramEvent is unique per
 * (account, messageId), so a redelivered webhook hits the constraint and is
 * dropped before it reaches the queue. A redelivered DM keeps the decision
 * stored the first time.
 */

import { prisma } from "@/lib/db/client";
import type { Prisma } from "@/app/generated/prisma/client";
import { isTriggerEngineEnabled } from "./config";
import { selectCampaign } from "./matching";
import {
  decideDmTrigger,
  dmClaimNote,
  forgetCommentClaims,
  loadDmTriggerCampaigns,
  type DmClaimNote,
  type TriggerDb,
} from "./claim";
import type { DmTriggerEventType } from "./matching";
import {
  isC2Payload,
  normalizeWebhookPayload,
  type NormalizedInstagramEvent,
  type RawWebhookPayload,
} from "./normalize";
import { findPendingLeadExecution, phoneFromText } from "./lead-capture";
import { enqueueEvent } from "./queue";

export interface IngestResult {
  stored: string[];
  duplicates: number;
  skipped: number;
  /** Events that could not be stored (logged); production handles them as before. */
  failed: number;
  /**
   * DMs / story mentions / referral messages a DIRECT_MESSAGE / STORY_MENTION
   * campaign answers: storyReplyKey() → campaign id. Only events whose row
   * exists with claimedCampaignId (stored now, or earlier for a redelivery).
   */
  claimed: Map<string, string>;
}

interface AccountGate {
  id: string;
  workspaceId: string;
  /** False when the account has no trigger campaign: the engine stays out. */
  engaged: boolean;
}

const GATE_TTL_MS = 30_000;
const gateCache = new Map<string, { value: AccountGate | null; expires: number }>();

/** Drop the cached gate after a campaign is created or deleted. */
export function forgetAccountGate(instagramId?: string) {
  if (instagramId) gateCache.delete(instagramId);
  else gateCache.clear();
  // Same moment the Comment 2.0 claim list goes stale (this process only).
  forgetCommentClaims(instagramId);
}

async function loadAccountGate(instagramId: string): Promise<AccountGate | null> {
  const cached = gateCache.get(instagramId);
  if (cached && cached.expires > Date.now()) return cached.value;

  const account = await prisma.instagramAccount.findUnique({
    where: { instagramId },
    select: { id: true, workspaceId: true, _count: { select: { triggerCampaigns: true } } },
  });
  const value = account
    ? { id: account.id, workspaceId: account.workspaceId, engaged: account._count.triggerCampaigns > 0 }
    : null;
  gateCache.set(instagramId, { value, expires: Date.now() + GATE_TTL_MS });
  return value;
}

export function isUniqueViolation(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { code?: unknown }).code === "P2002";
}

/**
 * Store one normalised event. Returns null when it was already stored.
 * `backtrackRunId` marks events queued by a backtrack scan (lib/triggers/backtrack.ts).
 */
export async function storeEvent(
  account: { id: string; workspaceId: string },
  event: NormalizedInstagramEvent,
  options: {
    backtrackRunId?: string;
    /** ETAP 3: the DM-trigger campaign the webhook decided will answer it. */
    claimedCampaignId?: string | null;
    dmClaim?: DmClaimNote;
    db?: TriggerDb;
  } = {}
): Promise<string | null> {
  const db = options.db ?? prisma;
  try {
    const row = await db.instagramEvent.create({
      data: {
        workspaceId: account.workspaceId,
        instagramAccountId: account.id,
        eventType: event.type,
        senderId: event.senderId,
        senderUsername: event.senderUsername ?? null,
        messageId: event.messageId,
        storyId: event.storyId ?? null,
        storyUrl: event.storyUrl ?? null,
        mediaId: event.mediaId ?? null,
        text: event.text,
        payload: event.payload ?? null,
        referralSource: event.referralSource ?? null,
        adId: event.adId ?? null,
        ref: event.ref ?? null,
        reaction: event.reaction ?? null,
        reactedMid: event.reactedMid ?? null,
        backtrackRunId: options.backtrackRunId ?? null,
        claimedCampaignId: options.claimedCampaignId ?? null,
        timestamp: event.timestamp,
        rawPayload: {
          entryId: event.instagramAccountId,
          hasAttachment: event.hasAttachment,
          item: event.raw,
          ...(options.dmClaim ? { dmClaim: options.dmClaim } : {}),
        } as Prisma.InputJsonValue,
        processingStatus: "PENDING",
      },
      select: { id: true },
    });
    return row.id;
  } catch (error) {
    if (isUniqueViolation(error)) return null;
    throw error;
  }
}

/**
 * A comment the production worker stepped aside for (Comment 2.0 claims it).
 * Webhook comments are already stored, so this is a no-op for them; comments
 * found later by the polling reconciler would otherwise reach nobody. The
 * comment's own time is unknown here, so "now" stands in for it — polling
 * only looks back 72h, well inside Meta's 7-day private-reply limit.
 */
export async function handOverClaimedComment(comment: {
  instagramId: string;
  commentId: string;
  text: string;
  commenterId: string;
  commenterName?: string;
  mediaId: string;
  originalMediaId?: string;
}): Promise<boolean> {
  if (!isTriggerEngineEnabled()) return false;
  const account = await prisma.instagramAccount.findUnique({
    where: { instagramId: comment.instagramId },
    select: { id: true, workspaceId: true },
  });
  if (!account) return false;

  const eventId = await storeEvent(account, {
    type: "COMMENT",
    instagramAccountId: comment.instagramId,
    senderId: comment.commenterId,
    senderUsername: comment.commenterName,
    messageId: comment.commentId,
    mediaId: comment.mediaId,
    text: comment.text,
    hasAttachment: false,
    timestamp: new Date(),
    // Same shape as a webhook change, so the handler finds the ad's post.
    raw: {
      field: "comments",
      value: {
        id: comment.commentId,
        media: { id: comment.mediaId, original_media_id: comment.originalMediaId },
      },
      handedOverBy: "production-worker",
    },
  });
  if (!eventId) return false;
  await enqueueEvent(eventId);
  return true;
}

/** Shown in the logs when the webhook could not decide (the event is stored unclaimed). */
export const DM_CLAIM_FAILED_REASON =
  "Webhook qarori olinmadi (xatolik) — Direct trigger javob bermaydi, javobni asosiy tizim beradi.";

const CLAIM_TX_OPTIONS = { maxWait: 5_000, timeout: 10_000 };

/** A DM-side event a DIRECT_MESSAGE / STORY_MENTION campaign may answer (taps and other payloads never). */
function dmTriggerType(event: NormalizedInstagramEvent): DmTriggerEventType | null {
  if (event.type === "STORY_MENTION") return "STORY_MENTION";
  if (event.type === "DIRECT_MESSAGE" && !event.payload) return "DIRECT_MESSAGE";
  return null;
}

async function storedClaim(accountId: string, messageId: string): Promise<string | null> {
  const row = await prisma.instagramEvent.findUnique({
    where: { instagramAccountId_messageId: { instagramAccountId: accountId, messageId } },
    select: { claimedCampaignId: true },
  });
  return row?.claimedCampaignId ?? null;
}

/**
 * Decide and store one DM-side event (see the file comment). Returns the new
 * event id (null when it was stored before) and the campaign that answers it
 * (for a redelivery: the decision stored the first time).
 *
 * The lock is a Postgres advisory transaction lock keyed by account + sender.
 * It is taken and released by the same transaction that reads the person's
 * history and inserts the event, so the next webhook for this person waits
 * until the claimed row is committed and visible: no gap between "lock
 * released" and "row visible", no TTL that can run out mid-claim (a Redis
 * lock could), nothing to clean up after a crash. A lock wait over 3s
 * (lock_timeout) fails the claim like any other error.
 */
export async function claimAndStoreDmEvent(
  account: { id: string; workspaceId: string },
  event: NormalizedInstagramEvent,
  type: DmTriggerEventType,
  earlierEventIds: string[] = []
): Promise<{ eventId: string | null; claimedCampaignId: string | null }> {
  const query = {
    accountId: account.id,
    senderId: event.senderId,
    type,
    text: event.text,
    referralSource: event.referralSource ?? null,
    adId: event.adId ?? null,
    ref: event.ref ?? null,
    at: event.timestamp,
    earlierEventIds,
  };
  const withStoredClaim = async (eventId: string | null) => ({
    eventId,
    claimedCampaignId: eventId ? null : await storedClaim(account.id, event.messageId),
  });

  try {
    const campaigns = await loadDmTriggerCampaigns(account.id, type);
    if (campaigns.length === 0) {
      // Nothing can be claimed: no lock, only the reason for the logs.
      const decision = await decideDmTrigger(query, campaigns);
      return await withStoredClaim(await storeEvent(account, event, { dmClaim: dmClaimNote(decision) }));
    }

    const lockKey = `${account.id}:${event.senderId}`;
    return await prisma.$transaction(async (tx) => {
      // Lock wait limit: past it the claim fails (nothing claimed).
      await tx.$executeRaw`SET LOCAL lock_timeout = '3s'`;
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('trigger-dm-claim'), hashtext(${lockKey}))`;
      // A redelivery keeps the decision made the first time.
      const stored = await tx.instagramEvent.findUnique({
        where: { instagramAccountId_messageId: { instagramAccountId: account.id, messageId: event.messageId } },
        select: { claimedCampaignId: true },
      });
      if (stored) return { eventId: null, claimedCampaignId: stored.claimedCampaignId };

      const decision = await decideDmTrigger(query, campaigns, tx);
      const claimedCampaignId = decision.campaign?.id ?? null;
      const eventId = await storeEvent(account, event, { claimedCampaignId, dmClaim: dmClaimNote(decision), db: tx });
      // Only an unlocked fallback insert can get here first; let it stand.
      if (!eventId) throw new Error(`event ${event.messageId} was stored concurrently`);
      return { eventId, claimedCampaignId };
    }, CLAIM_TX_OPTIONS);
  } catch (error) {
    console.error(
      "[Trigger Engine] DM trigger claim failed, nothing claimed:",
      error instanceof Error ? error.message : error
    );
  }

  // Stored unclaimed (taps, bookkeeping and the logs still see it); the DM
  // keyword path and the assistant answer it. If the row exists already, its
  // own stored decision stands.
  return withStoredClaim(
    await storeEvent(account, event, {
      dmClaim: { campaignId: null, matchedKeyword: null, reason: DM_CLAIM_FAILED_REASON },
    })
  );
}

export async function ingestWebhookPayload(payload: unknown): Promise<IngestResult> {
  const result: IngestResult = { stored: [], duplicates: 0, skipped: 0, failed: 0, claimed: new Map() };
  if (!isTriggerEngineEnabled()) return result;

  const events = normalizeWebhookPayload(payload as RawWebhookPayload);
  // Events of a person stored earlier in this payload: history for the next one.
  const earlierByPerson = new Map<string, string[]>();
  for (const event of events) {
    try {
      const gate = await loadAccountGate(event.instagramAccountId);
      if (!gate || !gate.engaged) {
        result.skipped++;
        continue;
      }

      const person = `${gate.id}|${event.senderId}`;
      const earlier = earlierByPerson.get(person) ?? [];
      const type = dmTriggerType(event);
      let eventId: string | null;
      if (type) {
        const outcome = await claimAndStoreDmEvent(gate, event, type, earlier);
        eventId = outcome.eventId;
        if (outcome.claimedCampaignId) {
          result.claimed.set(storyReplyKey(event.instagramAccountId, event.messageId), outcome.claimedCampaignId);
        }
      } else {
        eventId = await storeEvent(gate, event);
      }
      if (!eventId) {
        result.duplicates++;
        continue;
      }
      result.stored.push(eventId);
      earlierByPerson.set(person, [...earlier, eventId]);

      // A failed enqueue (Redis down) is not lost: the row stays PENDING and the
      // worker's sweep picks it up.
      await enqueueEvent(eventId).catch((error) => {
        console.error(
          "[Trigger Engine] enqueue failed, left for the sweep:",
          error instanceof Error ? error.message : error
        );
      });
    } catch (error) {
      // One event failing must not cost the others, nor the claims made so far.
      result.failed++;
      console.error("[Trigger Engine] event not stored:", error instanceof Error ? error.message : error);
    }
  }
  return result;
}

export function storyReplyKey(instagramAccountId: string, messageId: string): string {
  return `${instagramAccountId}|${messageId}`;
}

async function loadStoryReplyCampaigns(instagramId: string) {
  const gate = await loadAccountGate(instagramId);
  if (!gate || !gate.engaged) return [];
  return prisma.triggerCampaign.findMany({
    where: { instagramAccountId: gate.id, triggerType: "STORY_REPLY", active: true },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Story replies in this payload that an active STORY_REPLY campaign will
 * answer, as storyReplyKey()s. The webhook route keeps these away from the DM
 * keyword autoreply and the lead assistant, so one story reply gets one DM.
 * Empty when the engine is off or no campaign matches: nothing changes then.
 */
export async function findClaimedStoryReplies(payload: unknown): Promise<Set<string>> {
  const claimed = new Set<string>();
  if (!isTriggerEngineEnabled()) return claimed;

  const replies = normalizeWebhookPayload(payload as RawWebhookPayload).filter(
    (event) => event.type === "STORY_REPLY"
  );
  const campaignsByAccount = new Map<string, Awaited<ReturnType<typeof loadStoryReplyCampaigns>>>();
  for (const event of replies) {
    let campaigns = campaignsByAccount.get(event.instagramAccountId);
    if (!campaigns) {
      campaigns = await loadStoryReplyCampaigns(event.instagramAccountId);
      campaignsByAccount.set(event.instagramAccountId, campaigns);
    }
    const selection = selectCampaign(campaigns, {
      type: "STORY_REPLY",
      text: event.text,
      storyId: event.storyId,
    });
    if (selection.campaign) claimed.add(storyReplyKey(event.instagramAccountId, event.messageId));
  }
  return claimed;
}

/**
 * Quick-reply taps on a Comment 2.0 main message ("c2:" payload), as
 * storyReplyKey()s. The webhook route keeps them away from the DM keyword
 * autoreply and the assistant: the tap belongs to the campaign that sent the
 * buttons (lib/triggers/direct-handler.ts). Button taps are postbacks and never
 * reach those paths anyway. Empty when the engine is off.
 */
export function findClaimedC2Messages(payload: unknown): Set<string> {
  const claimed = new Set<string>();
  if (!isTriggerEngineEnabled()) return claimed;
  for (const event of normalizeWebhookPayload(payload as RawWebhookPayload)) {
    if (event.type === "DIRECT_MESSAGE" && isC2Payload(event.payload)) {
      claimed.add(storyReplyKey(event.instagramAccountId, event.messageId));
    }
  }
  return claimed;
}

/**
 * Phone numbers shared from a Comment 2.0 LEAD_CAPTURE chip whose payload came
 * back as the number instead of "c2:…" (see lead-capture.ts), as
 * storyReplyKey()s. The direct handler answers them as the lead tap, so the
 * webhook route keeps them away from the DM keyword path and the assistant.
 *
 * Cheap: only plain DMs whose whole text is a phone number are looked at, and
 * only on accounts that have a trigger campaign (cached gate). Never throws:
 * on any error nothing is claimed and those paths run as before.
 */
export async function findClaimedLeadPhoneMessages(payload: unknown, now: Date = new Date()): Promise<Set<string>> {
  const claimed = new Set<string>();
  if (!isTriggerEngineEnabled()) return claimed;
  try {
    for (const event of normalizeWebhookPayload(payload as RawWebhookPayload)) {
      if (event.type !== "DIRECT_MESSAGE" || isC2Payload(event.payload) || !phoneFromText(event.text)) continue;
      const gate = await loadAccountGate(event.instagramAccountId);
      if (!gate || !gate.engaged) continue;
      if (await findPendingLeadExecution(gate, event.senderId, now)) {
        claimed.add(storyReplyKey(event.instagramAccountId, event.messageId));
      }
    }
  } catch (error) {
    console.error(
      "[Trigger Engine] lead phone claim check failed, nothing claimed:",
      error instanceof Error ? error.message : error
    );
    return new Set();
  }
  return claimed;
}
