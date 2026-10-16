/**
 * Overlap guard between Comment 2.0 and the production comment campaigns.
 *
 * Meta allows one private reply per comment. When an active Comment 2.0
 * campaign will answer a comment, the production worker (processComment in
 * lib/queue/dm-worker.ts) asks here first and steps aside, so nobody gets two
 * DMs and no production campaign burns the one allowed reply.
 *
 * The production worker calls this for every comment, so "this account has no
 * active COMMENT campaign" is cached per account for a short while — the hot
 * path: only the developer can create Comment 2.0 campaigns, so for every
 * other account the answer is a cached "no campaigns" and nothing changes.
 * When campaigns exist they are always read fresh: a cached "claimed" could
 * outlive a campaign switched off, deleted or narrowed in another process (the
 * UI's forget calls only reach its own process), and then production would
 * step aside while the engine ignores the comment — nobody answers it.
 *
 * Failures answer false: on any doubt production keeps working as before.
 * Kept free of lib/meta imports on purpose (the production worker loads it).
 *
 * ETAP 3 adds the DM side (bottom of the file): which DIRECT_MESSAGE /
 * STORY_MENTION campaign answers a DM. That is decided ONCE, in the webhook
 * (decideDmTrigger, called by ingest.ts under a per-person lock), and stored
 * on the event (claimedCampaignId); the handler (dm-trigger-handler.ts) never
 * decides again. The active-conversation query (findActiveConversations) is
 * shared by that decision and the direct handler's bookkeeping.
 */

import { prisma } from "@/lib/db/client";
import type { InstagramEventType, Prisma } from "@/app/generated/prisma/client";
import { FLOW_OWNS_THREAD_REASON, flowOwnsThread } from "@/lib/flows/bridge";
import { flowKindFilter, isFlowPayload } from "@/lib/flows/config";
import { isTriggerEngineEnabled } from "./config";
import { STOP_ON_REPLY_REASON } from "./lead-capture";
import {
  describeCommentMatch,
  selectCommentCampaign,
  selectDmCampaign,
  type CommentMatchableCampaign,
  type DmTriggerEventType,
} from "./matching";
import { isC2Payload } from "./normalize";

const CLAIM_TTL_MS = 30_000;
/** Accounts known to have no active COMMENT campaign, until `expires`. */
const noCampaignsCache = new Map<string, number>();

/** Drop cached "no campaigns" answers (one account, by either id, or all). */
export function forgetCommentClaims(accountKey?: string) {
  if (accountKey) noCampaignsCache.delete(accountKey);
  else noCampaignsCache.clear();
}

/**
 * Active COMMENT campaigns of an account. `accountKey` may be our
 * InstagramAccount.id or the Instagram id (webhook entry.id) — the production
 * worker only has the latter.
 */
async function loadCampaigns(accountKey: string): Promise<CommentMatchableCampaign[]> {
  const emptyUntil = noCampaignsCache.get(accountKey);
  if (emptyUntil !== undefined) {
    if (emptyUntil > Date.now()) return [];
    noCampaignsCache.delete(accountKey);
  }

  const campaigns = await prisma.triggerCampaign.findMany({
    where: {
      triggerType: "COMMENT",
      active: true,
      // Flow proxy campaigns (ETAP 6) claim comments too; invisible with FLOWS_DISABLED=1.
      ...flowKindFilter(),
      OR: [{ instagramAccountId: accountKey }, { instagramAccount: { instagramId: accountKey } }],
    },
    select: {
      id: true,
      triggerType: true,
      active: true,
      mediaScope: true,
      mediaIds: true,
      keywords: true,
      matchingMode: true,
      intents: true,
      priority: true,
      createdAt: true,
    },
    orderBy: { createdAt: "asc" },
  });
  if (campaigns.length === 0) noCampaignsCache.set(accountKey, Date.now() + CLAIM_TTL_MS);
  return campaigns;
}

/** True when an active Comment 2.0 campaign on this account will answer the comment. */
export async function isCommentClaimedByCommentEngine(
  instagramAccountId: string,
  mediaId: string | null,
  text: string,
  altMediaId?: string | null
): Promise<boolean> {
  if (!isTriggerEngineEnabled() || !instagramAccountId) return false;
  try {
    const campaigns = await loadCampaigns(instagramAccountId);
    if (campaigns.length === 0) return false;
    return selectCommentCampaign(campaigns, { mediaId, altMediaId, text }).campaign !== null;
  } catch (error) {
    console.error(
      "[Trigger Engine] comment claim check failed, production handles the comment:",
      error instanceof Error ? error.message : error
    );
    return false;
  }
}

/**
 * A quick-reply payload that belongs to Comment 2.0. The webhook route keeps
 * such messages away from the DM keyword path and the assistant (see
 * findClaimedC2Messages in ingest.ts, which applies this to a whole payload).
 */
export function isClaimedC2Payload(payload: string | null | undefined): boolean {
  return isTriggerEngineEnabled() && (isC2Payload(payload) || isFlowPayload(payload));
}

/// ─── DM-side triggers (ETAP 3) ────────────────────────────────────────────────

const HOUR_MS = 3600_000;
/** Meta's messaging window; a conversation counts as active inside it. */
const CONVERSATION_ACTIVE_MS = 24 * HOUR_MS;
/** Messages that make up a DM conversation (for "reopened"). Comments do not. */
const DM_SIDE_EVENT_TYPES = ["DIRECT_MESSAGE", "STORY_REPLY", "STORY_MENTION"] as const;
/** Not an interaction with the account (observation only, never booked on the contact). */
const NOT_HISTORY_EVENT_TYPES = ["MESSAGE_REACTION", "STORY_REACTION"] as const;
/** Executions whose thread a plain DM continues (direct-handler.ts bookkeeping). */
export const CONVERSATION_EVENT_TYPES = ["COMMENT", "LIVE_COMMENT", "DIRECT_MESSAGE", "STORY_MENTION"] as const;
/** Of those, the ones started by a (live) comment: the other bot. */
export const COMMENT_CONVERSATION_EVENT_TYPES = ["COMMENT", "LIVE_COMMENT"] as const;
/** Executions that answered (or are about to answer) the person: they count for the cooldown. */
const COOLDOWN_EXECUTION_STATUSES = ["PENDING", "SENDING", "RETRYING", "SENT"] as const;

export const COMMENT_OWNS_THREAD_REASON =
  "Izoh kampaniyasi suhbati davom etmoqda — Direct trigger javob bermadi (ikki bot bir vaqtda yozmaydi).";

/** The prisma client or an interactive transaction (the webhook claim runs inside one). */
export type TriggerDb = Prisma.TransactionClient;

export async function loadDmTriggerCampaigns(accountId: string, type: DmTriggerEventType, db: TriggerDb = prisma) {
  return db.triggerCampaign.findMany({
    where: { instagramAccountId: accountId, triggerType: type, active: true, ...flowKindFilter() },
    orderBy: { createdAt: "asc" },
  });
}

export type DmTriggerCampaign = Awaited<ReturnType<typeof loadDmTriggerCampaigns>>[number];

export interface ConversationState {
  sentAt: Date | null;
  openedAt: Date | null;
  lastInboundAt: Date | null;
  stoppedAt: Date | null;
  stopReason: string | null;
  handedOffAt: Date | null;
}

/**
 * True while an execution still owns its DM thread at `at`: its last activity
 * (reply sent, tap or message from the person) is under 24h old and its
 * automation is not stopped. A stop caused by the message at `at` itself
 * (stop on reply, booked by an earlier try of the same event) does not count,
 * and a handoff always keeps the thread taken (the bot stays out).
 */
export function isActiveCommentConversation(state: ConversationState, at: Date): boolean {
  const stoppedByThisMessage =
    state.stopReason === STOP_ON_REPLY_REASON && state.lastInboundAt?.getTime() === at.getTime();
  if (state.stoppedAt && !stoppedByThisMessage && !state.handedOffAt) return false;
  const times = [state.sentAt, state.openedAt, state.lastInboundAt]
    .filter((d): d is Date => d instanceof Date)
    .map((d) => d.getTime());
  if (times.length === 0) return false;
  return at.getTime() - Math.max(...times) < CONVERSATION_ACTIVE_MS;
}

/**
 * The person's ACTIVE conversations at `at` (isActiveCommentConversation),
 * newest first: SENT executions of the given event types for this sender on
 * this account. The one query behind both "does a comment / live campaign own
 * the thread?" (webhook claim) and the stop-on-reply / lastInboundAt
 * bookkeeping in direct-handler.ts — so a stale execution is never revived by
 * a later DM, and the two can never disagree about which threads are live.
 */
export async function findActiveConversations(
  query: {
    accountId: string;
    senderId: string;
    at: Date;
    eventTypes: readonly InstagramEventType[];
    /** The event being handled: its own execution is not a previous conversation. */
    excludeEventId?: string;
  },
  db: TriggerDb = prisma
) {
  const since = new Date(query.at.getTime() - CONVERSATION_ACTIVE_MS);
  const rows = await db.triggerExecution.findMany({
    where: {
      status: "SENT",
      ...(query.excludeEventId ? { eventId: { not: query.excludeEventId } } : {}),
      event: { instagramAccountId: query.accountId, senderId: query.senderId, eventType: { in: [...query.eventTypes] } },
      // Cheap pre-filter; the exact rule (stops, handoff) is applied below.
      OR: [{ sentAt: { gte: since } }, { openedAt: { gte: since } }, { lastInboundAt: { gte: since } }],
    },
    include: { campaign: true, event: { select: { eventType: true } } },
    orderBy: { createdAt: "desc" },
    take: 20,
  });
  return rows.filter((row) => isActiveCommentConversation(row, query.at));
}

export interface DmTriggerQuery {
  /** Our InstagramAccount.id. */
  accountId: string;
  senderId: string;
  type: DmTriggerEventType;
  text: string;
  referralSource?: string | null;
  adId?: string | null;
  ref?: string | null;
  /** The event's time. */
  at: Date;
  /**
   * Events of the same sender stored earlier in the same webhook payload: they
   * are history whatever their timestamp says.
   */
  earlierEventIds?: string[];
}

export interface DmTriggerDecision {
  campaign: DmTriggerCampaign | null;
  matchedKeyword: string | null;
  /** Why no campaign was chosen (shown in the logs); null when one was. */
  reason: string | null;
}

/**
 * THE decision "which DIRECT_MESSAGE / STORY_MENTION campaign answers this
 * DM?" (ETAP 3). Made once, in the webhook, before the event is stored
 * (ingest.ts, under a per-person lock); the result is kept on the event
 * (claimedCampaignId) and the worker answers with exactly that campaign.
 * Every input is read from stored rows at decision time:
 *
 *   - a comment / live campaign owns the thread (DIRECT_MESSAGE only) → none;
 *   - audience: the person's stored events on this account up to `at` (plus
 *     `earlierEventIds`) — none means NEW_CONTACT; REOPENED is measured from
 *     the previous DM-side event;
 *   - cooldown: the campaign's executions to this person in PENDING /
 *     SENDING / RETRYING / SENT (by createdAt) and the events already claimed
 *     for it from this person (by timestamp), inside the cooldown window.
 */
export async function decideDmTrigger(
  query: DmTriggerQuery,
  campaigns?: DmTriggerCampaign[],
  db: TriggerDb = prisma
): Promise<DmTriggerDecision> {
  const list = campaigns ?? (await loadDmTriggerCampaigns(query.accountId, query.type, db));
  const none = (reason: string | null): DmTriggerDecision => ({
    campaign: null,
    matchedKeyword: null,
    reason: reason ?? "Mos kampaniya topilmadi",
  });
  if (list.length === 0) {
    return none(selectDmCampaign(list, { ...query, firstInteraction: true, hoursSincePreviousInbound: null }).ignoredReason);
  }

  if (query.type === "DIRECT_MESSAGE") {
    const owners = await findActiveConversations(
      { accountId: query.accountId, senderId: query.senderId, at: query.at, eventTypes: COMMENT_CONVERSATION_EVENT_TYPES },
      db
    );
    if (owners.length > 0) return none(COMMENT_OWNS_THREAD_REASON);
    // A live flow run (ETAP 6) owns the thread: no second bot starts talking.
    if (await flowOwnsThread(query.accountId, query.senderId, db)) return none(FLOW_OWNS_THREAD_REASON);
  }

  const person = { instagramAccountId: query.accountId, senderId: query.senderId };
  const upToNow = query.earlierEventIds?.length
    ? { OR: [{ timestamp: { lte: query.at } }, { id: { in: query.earlierEventIds } }] }
    : { timestamp: { lte: query.at } };

  const previous = await db.instagramEvent.findFirst({
    where: { ...person, eventType: { notIn: [...NOT_HISTORY_EVENT_TYPES] }, ...upToNow },
    select: { id: true },
  });

  let hoursSincePreviousInbound: number | null = null;
  if (previous && list.some((c) => c.audience === "REOPENED")) {
    const previousDm = await db.instagramEvent.findFirst({
      where: { ...person, eventType: { in: [...DM_SIDE_EVENT_TYPES] }, ...upToNow },
      orderBy: { timestamp: "desc" },
      select: { timestamp: true },
    });
    if (previousDm) {
      hoursSincePreviousInbound = Math.max(0, query.at.getTime() - previousDm.timestamp.getTime()) / HOUR_MS;
    }
  }

  const lastSentAt = new Map<string, Date>();
  const remember = (campaignId: string | null, at: Date | null) => {
    if (!campaignId || !at) return;
    const known = lastSentAt.get(campaignId);
    if (!known || at > known) lastSentAt.set(campaignId, at);
  };
  const maxCooldown = Math.max(0, ...list.map((c) => c.cooldownHours ?? 0));
  if (maxCooldown > 0) {
    const since = new Date(query.at.getTime() - maxCooldown * HOUR_MS);
    const ids = list.map((c) => c.id);
    const answered = await db.triggerExecution.findMany({
      where: {
        campaignId: { in: ids },
        status: { in: [...COOLDOWN_EXECUTION_STATUSES] },
        createdAt: { gte: since },
        event: person,
      },
      select: { campaignId: true, createdAt: true },
    });
    const claimed = await db.instagramEvent.findMany({
      where: { ...person, claimedCampaignId: { in: ids }, timestamp: { gte: since } },
      select: { claimedCampaignId: true, timestamp: true },
    });
    for (const row of answered) remember(row.campaignId, row.createdAt);
    for (const row of claimed) remember(row.claimedCampaignId, row.timestamp);
  }

  const selection = selectDmCampaign(list, {
    type: query.type,
    text: query.text,
    referralSource: query.referralSource,
    adId: query.adId,
    ref: query.ref,
    firstInteraction: !previous,
    hoursSincePreviousInbound,
    lastSentAt,
    at: query.at,
  });
  if (!selection.campaign) return none(selection.ignoredReason);
  return { campaign: selection.campaign, matchedKeyword: describeCommentMatch(selection), reason: null };
}

/**
 * What the webhook decided, kept in the event's rawPayload ("dmClaim") next
 * to claimedCampaignId: the matched keyword for the execution, and the reason
 * shown in the logs when nothing was claimed. `campaignId` survives a deleted
 * campaign (claimedCampaignId is then set to null by the foreign key).
 */
export type DmClaimNote = {
  campaignId: string | null;
  matchedKeyword: string | null;
  reason: string | null;
};

export function dmClaimNote(decision: DmTriggerDecision): DmClaimNote {
  return {
    campaignId: decision.campaign?.id ?? null,
    matchedKeyword: decision.matchedKeyword,
    reason: decision.reason,
  };
}

/** The dmClaim note of a stored event (null for events stored without one). */
export function readDmClaimNote(rawPayload: unknown): DmClaimNote | null {
  if (!rawPayload || typeof rawPayload !== "object") return null;
  const note = (rawPayload as { dmClaim?: unknown }).dmClaim;
  if (!note || typeof note !== "object") return null;
  const text = (value: unknown) => (typeof value === "string" ? value : null);
  const { campaignId, matchedKeyword, reason } = note as Record<string, unknown>;
  return { campaignId: text(campaignId), matchedKeyword: text(matchedKeyword), reason: text(reason) };
}
