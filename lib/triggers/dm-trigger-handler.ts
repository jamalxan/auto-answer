/**
 * DM-side triggers (ETAP 3): Direct, Story Mention, click-to-Direct ad and
 * ig.me link. Ads and links are DIRECT_MESSAGE campaigns with sourceFilter
 * ADS / LINK.
 *
 *   webhook (ingest.ts) ─▶ claim.ts decideDmTrigger: keywords / intents,
 *                          audience, source, cooldown, comment thread,
 *                          priority ─▶ InstagramEvent.claimedCampaignId
 *
 *   DIRECT_MESSAGE (plain) ─▶ direct-handler.ts bookkeeping first (active
 *                              comment / live / DM-trigger executions, lead
 *                              phone, stop on reply) ─▶ runDmTrigger
 *   STORY_MENTION          ─▶ contact ─▶ runDmTrigger
 *
 *   runDmTrigger: ONLY the claimed campaign, decided in the webhook — the
 *   worker never decides again (production skipped exactly the claimed
 *   events, so a second decision could only disagree: a double reply or a
 *   message nobody answers). Hard checks only: campaign still active on the
 *   same account, 24h window, quota / rate limit. ─▶ TriggerExecution
 *   (variant chosen once) ─▶ one DM with the campaign's quick replies ─▶
 *   follow-ups scheduled from the send
 *
 * The person wrote first, so Meta's 24-hour window is open: there is no
 * opening button, the reply carries the quick replies straight away and the
 * execution is "opened" at the person's message (openedAt = lastInboundAt =
 * event time). Taps come back as "c2:<execution>:qr:<id>" and are handled by
 * direct-handler.ts like any other execution's. Follow-ups use the "direct"
 * moment: every step except NO_CLICK, which has no meaning without a button.
 *
 * Idempotency is delivery.ts's: one execution per (event, campaign), SENT
 * ends the job, a leftover SENDING fails instead of re-sending. A retry uses
 * the same claimed campaign, whatever the person's history says by then.
 */

import { prisma } from "@/lib/db/client";
import { sendDirectMessage, sendDirectMessageWithQuickReplies } from "@/lib/meta/client";
import { startFlowFromCampaign } from "@/lib/flows/bridge";
import { readDmClaimNote } from "./claim";
import { enrichContact, recordInteraction, storeMessage, type RecordedInteraction } from "./contacts";
import {
  beginExecution,
  failExecution,
  markExecutionSending,
  markExecutionSent,
  readAccessToken,
  sendGuarded,
  skipExecution,
  type EventWithAccount,
  type HandlerResult,
} from "./delivery";
import { buildQuickReplies, handleDirectMessage } from "./direct-handler";
import { isWindowOpen, scheduleFollowUps, WINDOW_CLOSED_REASON } from "./followups";
import { describeCommentMatch, selectDmCampaign, type CommentMatchKind } from "./matching";
import { chooseReplies, loadApprovedVariants } from "./variants";

/** Campaign trigger types answered here. Ad messages and ig.me links are DIRECT_MESSAGE + sourceFilter. */
export const DM_TRIGGER_TYPES = ["DIRECT_MESSAGE", "STORY_MENTION"] as const;

const EMPTY_REPLY_REASON = "Javob matni bo'sh — kampaniyada xabar yoki tasdiqlangan variant yo'q.";
/** An event stored without a webhook decision (none was made for it). */
export const NOT_CLAIMED_REASON = "Webhookda Direct trigger tanlanmagan — javobni asosiy tizim beradi.";
export const CLAIMED_CAMPAIGN_GONE_REASON =
  "Webhookda tanlangan kampaniya o'chirilgan yoki o'zgargan — javob yuborilmadi (asosiy tizim ham bu xabarni o'tkazib yuborgan).";

async function loadQuickReplies(campaignId: string) {
  return prisma.triggerQuickReply.findMany({
    where: { campaignId },
    orderBy: [{ sort: "asc" }, { createdAt: "asc" }],
  });
}

/**
 * The webhook claimed this event for a campaign that is now switched off,
 * deleted or moved: production already stepped aside, so nobody answers this
 * message. Rare (the campaign changed within seconds), but it must be visible.
 */
async function reportClaimedCampaignGone(event: EventWithAccount, campaignId: string | null) {
  console.warn(`[Trigger Engine] ${event.id}: claimed campaign ${campaignId ?? "-"} is gone, message left unanswered`);
  await prisma.operationalEvent
    .create({
      data: {
        workspaceId: event.workspaceId,
        source: "WORKER",
        level: "WARNING",
        message: `Trigger engine: ${event.eventType} javobsiz qoldi — ${CLAIMED_CAMPAIGN_GONE_REASON}`.slice(0, 500),
        payload: { eventId: event.id, campaignId },
      },
    })
    .catch(() => {});
}

/** Answer one DM-side event with the campaign the webhook claimed it for. */
export async function runDmTrigger(
  event: EventWithAccount,
  interaction: RecordedInteraction,
  now: Date = new Date()
): Promise<HandlerResult> {
  const account = event.instagramAccount;
  const note = readDmClaimNote(event.rawPayload);
  if (!event.claimedCampaignId) {
    // Claimed, but the campaign was deleted since (the foreign key cleared it).
    if (note?.campaignId) {
      await reportClaimedCampaignGone(event, note.campaignId);
      return { status: "IGNORED", error: CLAIMED_CAMPAIGN_GONE_REASON };
    }
    return { status: "IGNORED", error: note?.reason ?? NOT_CLAIMED_REASON };
  }

  const campaign = await prisma.triggerCampaign.findUnique({ where: { id: event.claimedCampaignId } });
  if (
    !campaign ||
    !campaign.active ||
    campaign.instagramAccountId !== account.id ||
    campaign.triggerType !== event.eventType
  ) {
    await reportClaimedCampaignGone(event, event.claimedCampaignId);
    return { status: "IGNORED", error: CLAIMED_CAMPAIGN_GONE_REASON };
  }

  // ETAP 6: a published flow answers instead of the campaign's own message.
  if (campaign.kind === "FLOW") return startFlowFromCampaign(event, campaign, interaction, note?.matchedKeyword ?? null);

  const start = await beginExecution(event, campaign.id, async () => {
    const chosen = await chooseReplies(campaign, await loadApprovedVariants(campaign.id));
    return { matchedKeyword: note?.matchedKeyword ?? null, responseText: chosen.dm.text, variantId: chosen.dm.variantId };
  });
  if ("done" in start) return start.done;
  let execution = start.execution;

  // The person's message opened the window: quick-reply taps and follow-ups
  // run from it, exactly as after a comment campaign's button tap.
  if (!execution.openedAt) {
    execution = await prisma.triggerExecution.update({
      where: { id: execution.id },
      data: { openedAt: event.timestamp, lastInboundAt: event.timestamp, firstInboundAt: execution.firstInboundAt ?? event.timestamp },
    });
  }
  if (!isWindowOpen(execution, now)) {
    return skipExecution(execution.id, WINDOW_CLOSED_REASON, `message at ${event.timestamp.toISOString()}`);
  }
  const text = execution.responseText;
  if (!text.trim()) return skipExecution(execution.id, EMPTY_REPLY_REASON, `campaign ${campaign.id}`);

  const token = readAccessToken(account);
  if (!token.ok) return failExecution(event, execution.id, token.failure);
  const accessToken = token.token;
  interaction.contact = await enrichContact(interaction.contact, accessToken);

  const chips = buildQuickReplies(execution.id, await loadQuickReplies(campaign.id));
  const executionId = execution.id;
  const result = await sendGuarded(
    event.workspaceId,
    account,
    () =>
      chips.length > 0
        ? sendDirectMessageWithQuickReplies(accessToken, account.instagramId, event.senderId, text, chips)
        : sendDirectMessage(accessToken, account.instagramId, event.senderId, text),
    { beforeSend: () => markExecutionSending(executionId) }
  );
  if (!result.ok) {
    if (result.skipped) return skipExecution(executionId, result.error, result.errorDetail);
    return failExecution(event, executionId, result.failure);
  }

  const sentAt = new Date();
  await markExecutionSent(executionId, result.sent, sentAt);
  await storeMessage({
    conversationId: interaction.conversation.id,
    direction: "OUTBOUND",
    text,
    mid: result.sent.message_id ?? null,
    eventId: event.id,
    executionId,
  }).catch((error) => {
    // The DM is out; failing the event now would only invite a duplicate.
    console.error("[Trigger Engine] outbound message not stored:", error instanceof Error ? error.message : error);
  });
  await scheduleFollowUps(execution, campaign, sentAt, "direct").catch((error) => {
    console.error("[Trigger Engine] follow-ups not scheduled:", error instanceof Error ? error.message : error);
  });

  return { status: "PROCESSED" };
}

// ─── Handlers (processor.ts registry) ─────────────────────────────────────────

/** DIRECT_MESSAGE: taps and comment bookkeeping first (direct-handler.ts), then the Direct triggers. */
export async function handleDirectEvent(event: EventWithAccount): Promise<HandlerResult> {
  return handleDirectMessage(event, { onPlainMessage: (interaction) => runDmTrigger(event, interaction) });
}

/**
 * STORY_MENTION: the person mentioned the account in their story. Only the
 * CDN url is kept (storyUrl) — Meta does not allow storing the media.
 * Mentions have no text, so EVERY is the usual matching mode.
 */
export async function handleStoryMention(event: EventWithAccount): Promise<HandlerResult> {
  const interaction = await recordInteraction(event);
  return runDmTrigger(event, interaction);
}

// ─── Simulator ────────────────────────────────────────────────────────────────

export interface DmTriggerSimulation {
  matched: boolean;
  campaignId?: string;
  campaignName?: string;
  matchKind?: CommentMatchKind;
  matchedKeyword?: string;
  replyPreview?: string;
  quickReplies?: string[];
  reason?: string;
}

/**
 * Dry run: which DM-side campaign would answer, and with what. Sends nothing,
 * writes nothing (the SEQUENTIAL cursor is read, not moved). Same selection
 * rule as the webhook decision (claim.ts decideDmTrigger → selectDmCampaign),
 * but there is no real person, so `contactState` stands in for the audience
 * (default NEW) and the cooldown / comment-thread checks are not applied.
 */
export async function simulateDmTrigger(
  workspaceId: string,
  input: {
    instagramAccountId: string;
    eventType: "DIRECT_MESSAGE" | "STORY_MENTION";
    text: string;
    referralSource?: string | null;
    adId?: string | null;
    ref?: string | null;
    contactState?: "NEW" | "RETURNING" | "REOPENED";
    /** The campaign being edited: tested "as if active" even while it is a draft / paused (dry run only). */
    includeCampaignId?: string | null;
  }
): Promise<DmTriggerSimulation> {
  const includeId = input.includeCampaignId || null;
  const found = await prisma.triggerCampaign.findMany({
    where: {
      workspaceId,
      triggerType: input.eventType,
      kind: "CAMPAIGN",
      AND: [
        { OR: [{ instagramAccountId: input.instagramAccountId }, { instagramAccount: { instagramId: input.instagramAccountId } }] },
        { OR: includeId ? [{ active: true }, { id: includeId }] : [{ active: true }] },
      ],
    },
    orderBy: { createdAt: "asc" },
  });
  const campaigns = found.map((c) => (includeId && c.id === includeId ? { ...c, active: true } : c));

  const state = input.contactState ?? "NEW";
  const selection = selectDmCampaign(campaigns, {
    type: input.eventType,
    text: input.text ?? "",
    referralSource: input.referralSource?.trim() || null,
    adId: input.adId?.trim() || null,
    ref: input.ref?.trim() || null,
    firstInteraction: state === "NEW",
    hoursSincePreviousInbound: state === "NEW" ? null : state === "REOPENED" ? Number.POSITIVE_INFINITY : 0,
    at: new Date(),
  });
  if (!selection.campaign || !selection.matchKind) {
    return { matched: false, reason: selection.ignoredReason ?? "Mos kampaniya topilmadi" };
  }

  const campaign = selection.campaign;
  const chosen = await chooseReplies(campaign, await loadApprovedVariants(campaign.id), { dryRun: true });
  const quickReplies = await loadQuickReplies(campaign.id);
  return {
    matched: true,
    campaignId: campaign.id,
    campaignName: campaign.name,
    matchKind: selection.matchKind,
    matchedKeyword: describeCommentMatch(selection) ?? undefined,
    replyPreview: chosen.dm.text,
    quickReplies: quickReplies.slice(0, 13).map((qr) => qr.label),
  };
}
