/**
 * Webhook → InstagramEvent rows → queue.
 *
 * Called from the webhook route after its existing work, inside its own
 * try/catch: nothing here can change what the comment / DM / assistant paths
 * do with the same payload.
 *
 * Duplicate protection, layer one: InstagramEvent is unique per
 * (account, messageId), so a redelivered webhook hits the constraint and is
 * dropped before it reaches the queue.
 */

import { prisma } from "@/lib/db/client";
import type { Prisma } from "@/app/generated/prisma/client";
import { isTriggerEngineEnabled } from "./config";
import { selectCampaign } from "./matching";
import { forgetCommentClaims } from "./claim";
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
  options: { backtrackRunId?: string } = {}
): Promise<string | null> {
  try {
    const row = await prisma.instagramEvent.create({
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
        backtrackRunId: options.backtrackRunId ?? null,
        timestamp: event.timestamp,
        rawPayload: {
          entryId: event.instagramAccountId,
          hasAttachment: event.hasAttachment,
          item: event.raw,
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

export async function ingestWebhookPayload(payload: unknown): Promise<IngestResult> {
  const result: IngestResult = { stored: [], duplicates: 0, skipped: 0 };
  if (!isTriggerEngineEnabled()) return result;

  const events = normalizeWebhookPayload(payload as RawWebhookPayload);
  for (const event of events) {
    const gate = await loadAccountGate(event.instagramAccountId);
    if (!gate || !gate.engaged) {
      result.skipped++;
      continue;
    }

    const eventId = await storeEvent(gate, event);
    if (!eventId) {
      result.duplicates++;
      continue;
    }
    result.stored.push(eventId);

    // A failed enqueue (Redis down) is not lost: the row stays PENDING and the
    // worker's sweep picks it up.
    await enqueueEvent(eventId).catch((error) => {
      console.error(
        "[Trigger Engine] enqueue failed, left for the sweep:",
        error instanceof Error ? error.message : error
      );
    });
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
