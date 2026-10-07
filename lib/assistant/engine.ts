/**
 * Lead assistant engine — wires `runTurn` (the conversation logic) to Instagram,
 * the database and the queue. Everything here is idempotent: webhooks are
 * retried by Meta and BullMQ jobs can run twice.
 */

import type { Conversation, InstagramAccount } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { extractPhone } from "@/lib/leads/phone";
import {
  createLeadForConversation,
  notifyCustomerWroteAgain,
  readCollected,
  type Collected,
} from "@/lib/leads/service";
import {
  MetaApiError,
  TokenExpiredError,
  getMessagingProfile,
  sendDirectMessage,
  sendSenderAction,
} from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { markTokenBroken } from "@/lib/meta/token-health";
import { getRedisConnection } from "@/lib/queue/client";
import {
  scheduleReply,
  type EchoJob,
  type InboundJob,
} from "@/lib/queue/assistant-queue";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import { DEBOUNCE_MS, typingDelayMs } from "./humanize";
import { detectLanguage } from "./language";
import { recordKnowledgeGap } from "./knowledge-gaps";
import { getLlmProvider } from "./llm/provider";
import {
  aiConversationLimit,
  findProfile,
  isProfileLive,
  isWithinWorkingHours,
  readWorkingHours,
  toSnapshot,
} from "./profile";
import { pickTemplate } from "./templates";
import { runTurn, type ActiveState } from "./turn";

const DAY_MS = 24 * 60 * 60 * 1000;
const NEW_CONVERSATION_AFTER_MS = 30 * DAY_MS;
const CAMPAIGN_REPLY_WINDOW_MS = 3 * DAY_MS;
// Longer than LLM retries (2 x 12s) + the typing delay (<= 9s) + sends.
const LOCK_TTL_SECONDS = 90;
const LLM_FAIL_LIMIT = 3;
const TEMPLATE_MODE_MS = 10 * 60_000;

const ACTIVE_STATES = new Set(["NEW", "NEED", "CONTACT"]);

function tokenOf(account: InstagramAccount): string | null {
  if (!account.accessToken) return null;
  try {
    return decryptToken(account.accessToken);
  } catch {
    return null;
  }
}

async function logEvent(
  workspaceId: string,
  conversationId: string | null,
  type: string,
  payload?: Record<string, unknown>
) {
  await prisma.assistantEvent
    .create({
      data: {
        workspaceId,
        conversationId,
        type,
        payload: payload ? JSON.parse(JSON.stringify(payload)) : undefined,
      },
    })
    .catch(() => {});
}

// ─── Inbound ───────────────────────────────────────────────────────────────────

async function upsertConversation(account: InstagramAccount, senderId: string) {
  const existing = await prisma.conversation.findUnique({
    where: { instagramAccountId_igUserId: { instagramAccountId: account.id, igUserId: senderId } },
  });
  if (existing) {
    const quietFor = existing.lastCustomerMessageAt
      ? Date.now() - existing.lastCustomerMessageAt.getTime()
      : 0;
    // 30+ days of silence after a hand-off: a brand new conversation. The
    // lead dedup (30-day phone window) still links it to an older lead.
    if (existing.assistantState !== "NEW" && quietFor > NEW_CONVERSATION_AFTER_MS) {
      return prisma.conversation.update({
        where: { id: existing.id },
        data: {
          assistantState: "NEW",
          botMessageCount: 0,
          phoneAskCount: 0,
          spamStreak: 0,
          operatorActiveUntil: null,
          campaignId: null,
          collected: {},
          leadCycle: { increment: 1 },
        },
      });
    }
    return existing;
  }
  try {
    return await prisma.conversation.create({
      data: {
        workspaceId: account.workspaceId,
        instagramAccountId: account.id,
        igUserId: senderId,
      },
    });
  } catch (error) {
    // Two messages of a burst raced to create the row; the other worker won.
    if ((error as { code?: string }).code !== "P2002") throw error;
    return prisma.conversation.findUniqueOrThrow({
      where: { instagramAccountId_igUserId: { instagramAccountId: account.id, igUserId: senderId } },
    });
  }
}

async function fillCustomerProfile(conversation: Conversation, account: InstagramAccount) {
  if (conversation.igUsername || conversation.igName) return conversation;
  const token = tokenOf(account);
  if (!token) return conversation;
  try {
    const profile = await getMessagingProfile(token, conversation.igUserId);
    return prisma.conversation.update({
      where: { id: conversation.id },
      data: { igUsername: profile.username ?? null, igName: profile.name ?? null },
    });
  } catch {
    return conversation; // cosmetic: the lead just falls back to the id
  }
}

/** Keyword campaign that should answer this DM itself (existing behaviour). */
async function matchesKeywordCampaign(accountId: string, text: string): Promise<boolean> {
  const campaigns = await prisma.automation.findMany({
    where: { instagramAccountId: accountId, isActive: true, dmTriggerEnabled: true },
    select: { keywords: true, matchAnyWord: true, wholeWordMatch: true },
  });
  return campaigns.some(
    (c) => c.matchAnyWord || matchKeywords(text, c.keywords, c.wholeWordMatch).matched
  );
}

export async function handleInboundMessage(job: InboundJob): Promise<void> {
  const account = await prisma.instagramAccount.findUnique({
    where: { instagramId: job.instagramAccountId },
  });
  if (!account) return;

  // Accounts that do not use the assistant keep no conversation records at all:
  // we only look at a DM when it answers one of OUR campaign DMs (a number typed
  // there still becomes a lead), otherwise nothing is stored.
  const profileRow = await findProfile(account.workspaceId, account.id);
  const live = profileRow ? isProfileLive(profileRow) : false;
  if (!live) {
    const existing = await prisma.conversation.findUnique({
      where: { instagramAccountId_igUserId: { instagramAccountId: account.id, igUserId: job.senderId } },
      select: { id: true },
    });
    const recentCampaignDm = await prisma.dmLog.findFirst({
      where: {
        instagramAccountId: account.id,
        commenterId: job.senderId,
        status: "SENT",
        dmSentAt: { gte: new Date(Date.now() - CAMPAIGN_REPLY_WINDOW_MS) },
      },
      select: { id: true },
    });
    if (!existing && !recentCampaignDm) return;
  }

  let conversation = await upsertConversation(account, job.senderId);
  const text = job.text.trim() || (job.hasAttachment ? "[rasm/fayl]" : "");
  if (!text) return;

  // Idempotent store (Meta may deliver the same webhook twice).
  try {
    await prisma.conversationMessage.create({
      data: { conversationId: conversation.id, mid: job.messageId, author: "CUSTOMER", text },
    });
  } catch {
    return; // already processed
  }
  conversation = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastCustomerMessageAt: new Date() },
  });
  conversation = await fillCustomerProfile(conversation, account);

  // Which kind of conversation is this? A: reply to a campaign DM, B: inbound.
  let handoffCampaignId: string | null = conversation.campaignId;
  let anyCampaignId: string | null = conversation.campaignId;
  if (!conversation.campaignId && conversation.assistantState === "NEW") {
    const log = await prisma.dmLog.findFirst({
      where: {
        instagramAccountId: account.id,
        commenterId: job.senderId,
        status: "SENT",
        dmSentAt: { gte: new Date(Date.now() - CAMPAIGN_REPLY_WINDOW_MS) },
      },
      orderBy: { dmSentAt: "desc" },
      select: { automationId: true, automation: { select: { handoffToAssistant: true } } },
    });
    if (log) {
      anyCampaignId = log.automationId;
      if (log.automation.handoffToAssistant) handoffCampaignId = log.automationId;
    }
    if (anyCampaignId) {
      conversation = await prisma.conversation.update({
        where: { id: conversation.id },
        data: { campaignId: anyCampaignId, source: "CAMPAIGN" },
      });
    }
  }

  // After hand-off: stay silent, but tell the operators the customer is back.
  if (conversation.assistantState === "HANDED_OFF") {
    await notifyCustomerWroteAgain(conversation.id);
    if (profileRow && profileRow.postHandoffReply && live) {
      await scheduleReply(conversation.id, DEBOUNCE_MS);
    }
    return;
  }

  const assistantWanted =
    live &&
    !conversation.botPaused &&
    (handoffCampaignId
      ? profileRow!.handleCampaignReplies
      : profileRow!.handleInboundDm);

  if (!assistantWanted) {
    // Phase-1 behaviour (no assistant): a customer who answers a campaign DM
    // with a phone number becomes a lead anyway.
    const phone = extractPhone(text);
    if (phone && anyCampaignId) {
      const collected: Collected = {
        ...readCollected(conversation.collected),
        phone_e164: phone.e164,
        phone_raw: phone.raw,
      };
      await prisma.conversation.update({
        where: { id: conversation.id },
        data: { collected: JSON.parse(JSON.stringify(collected)), assistantState: "HANDED_OFF" },
      });
      await createLeadForConversation(conversation.id, {
        summary: "Mijoz kampaniya DM'iga raqam yozib javob berdi.",
      });
    }
    return;
  }

  // The existing keyword campaign answers this message itself.
  if (conversation.assistantState === "NEW" && (await matchesKeywordCampaign(account.id, text))) {
    return;
  }

  if (conversation.operatorActiveUntil && conversation.operatorActiveUntil > new Date()) return;

  await scheduleReply(conversation.id, DEBOUNCE_MS);
}

// ─── Echo (operator took over) ─────────────────────────────────────────────────

export async function handleEcho(job: EchoJob): Promise<void> {
  const ownAppId = process.env.INSTAGRAM_APP_ID;
  // Our own app's sends (campaign DMs, assistant replies) are not an operator.
  if (job.appId && ownAppId && String(job.appId) === String(ownAppId)) return;

  const account = await prisma.instagramAccount.findUnique({
    where: { instagramId: job.instagramAccountId },
  });
  if (!account) return;

  // Campaign DMs / reveals sent by our own worker are echoed too. Their app_id
  // should match ours, but if Meta reports a different id they must still never
  // be mistaken for a human: a DM we logged as sent to this customer moments ago
  // is ours.
  const justSent = await prisma.dmLog.findFirst({
    where: {
      instagramAccountId: account.id,
      commenterId: job.customerId,
      dmSentAt: { gte: new Date(Date.now() - 2 * 60_000) },
    },
    select: { id: true },
  });
  if (justSent) return;

  const known = await prisma.conversationMessage.findFirst({
    where: { mid: job.messageId, conversation: { instagramAccountId: account.id } },
    select: { id: true },
  });
  if (known) return; // stored by our own send

  const conversation = await upsertConversation(account, job.customerId);
  const profile = await findProfile(account.workspaceId, account.id);
  const pauseHours = profile?.operatorPauseHours ?? 24;

  await prisma.conversationMessage
    .create({
      data: {
        conversationId: conversation.id,
        mid: job.messageId,
        author: "OPERATOR",
        text: job.text || "[fayl]",
      },
    })
    .catch(() => {});

  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { operatorActiveUntil: new Date(Date.now() + pauseHours * 60 * 60_000) },
  });
  await logEvent(account.workspaceId, conversation.id, "operator_takeover", { pauseHours });
}

/**
 * A human answered from the SocialAuto inbox: the bot goes quiet for the
 * configured pause, and the message is kept in the conversation record.
 */
export async function markOperatorActiveForContact(
  instagramAccountId: string,
  igUserId: string,
  text: string,
  messageId?: string
) {
  const conversation = await prisma.conversation.findUnique({
    where: { instagramAccountId_igUserId: { instagramAccountId, igUserId } },
    select: { id: true },
  });
  if (!conversation) return; // never talked to the assistant: nothing to pause
  await prisma.conversationMessage
    .create({
      data: { conversationId: conversation.id, mid: messageId ?? null, author: "OPERATOR", text },
    })
    .catch(() => {});
  await markOperatorActive(conversation.id);
}

/** Called when a human answers from the SocialAuto inbox. */
export async function markOperatorActive(conversationId: string) {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { workspaceId: true, instagramAccountId: true },
  });
  if (!conversation) return;
  const profile = await findProfile(conversation.workspaceId, conversation.instagramAccountId);
  const hours = profile?.operatorPauseHours ?? 24;
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { operatorActiveUntil: new Date(Date.now() + hours * 60 * 60_000) },
  });
}

// ─── Reply job ─────────────────────────────────────────────────────────────────

async function acquireLock(conversationId: string): Promise<boolean> {
  const result = await getRedisConnection().set(
    `conv:${conversationId}:lock`,
    "1",
    "EX",
    LOCK_TTL_SECONDS,
    "NX"
  );
  return result === "OK";
}

async function releaseLock(conversationId: string) {
  await getRedisConnection()
    .del(`conv:${conversationId}:lock`)
    .catch(() => {});
}

function failKey(workspaceId: string) {
  return `llmfail:${workspaceId}`;
}

async function registerLlmFailure(workspaceId: string, conversationId: string) {
  const redis = getRedisConnection();
  const count = await redis.incr(failKey(workspaceId));
  await redis.expire(failKey(workspaceId), 15 * 60);
  if (count >= LLM_FAIL_LIMIT) {
    await prisma.workspace.update({
      where: { id: workspaceId },
      data: { assistantTemplateOnlyUntil: new Date(Date.now() + TEMPLATE_MODE_MS) },
    });
    await redis.del(failKey(workspaceId));
    await logEvent(workspaceId, conversationId, "template_mode", { minutes: 10 });
  }
}

async function registerLlmSuccess(workspaceId: string) {
  await getRedisConnection()
    .del(failKey(workspaceId))
    .catch(() => {});
}

export async function runAssistantReply(conversationId: string): Promise<void> {
  if (!(await acquireLock(conversationId))) {
    // Another worker is answering this chat right now; look again shortly.
    await scheduleReply(conversationId, 3000);
    return;
  }
  try {
    await replyInner(conversationId);
  } finally {
    await releaseLock(conversationId);
  }
}

async function replyInner(conversationId: string): Promise<void> {
  const startedAt = Date.now();
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      instagramAccount: true,
      workspace: true,
      messages: { orderBy: { createdAt: "desc" }, take: 30 },
    },
  });
  if (!conversation) return;
  const { instagramAccount: account, workspace } = conversation;

  const profileRow = await findProfile(workspace.id, account.id);
  if (!profileRow || !isProfileLive(profileRow)) return;
  if (conversation.botPaused) return;
  if (conversation.operatorActiveUntil && conversation.operatorActiveUntil > new Date()) return;

  const state = conversation.assistantState;
  const postHandoff = state === "HANDED_OFF";
  if (!postHandoff && !ACTIVE_STATES.has(state)) return;

  // Debounce guard: a newer message restarted the 4s window.
  const last = conversation.lastCustomerMessageAt;
  if (last) {
    const remaining = DEBOUNCE_MS - (Date.now() - last.getTime());
    if (remaining > 500) {
      await scheduleReply(conversationId, remaining);
      return;
    }
  }

  // Meta's 24-hour window: never message outside it.
  if (!last || Date.now() - last.getTime() > DAY_MS - 60_000) {
    await logEvent(workspace.id, conversationId, "window_closed");
    return;
  }

  const chronological = [...conversation.messages].reverse();
  let lastReplyIndex = -1;
  chronological.forEach((m, i) => {
    if (m.author !== "CUSTOMER") lastReplyIndex = i;
  });
  const pending = chronological.slice(lastReplyIndex + 1).filter((m) => m.author === "CUSTOMER");
  if (pending.length === 0) return; // already answered

  const token = tokenOf(account);
  if (!token) {
    await markTokenBroken(account.id, "Assistant could not decrypt the Instagram token");
    return;
  }

  // After a hand-off the only thing we may send is one short polite line.
  if (postHandoff) {
    const alreadyAnswered = conversation.messages.some(
      (m) => m.author === "ASSISTANT" && m.llmMeta && (m.llmMeta as { postHandoff?: boolean }).postHandoff
    );
    if (alreadyAnswered) return;
    const lang = detectLanguage(pending.map((m) => m.text).join(" "));
    const reply = pickTemplate("after_handoff", { lang });
    await deliverReply(conversation, token, reply, { postHandoff: true });
    return;
  }

  // AI-conversation quota: once exhausted we keep collecting numbers, from templates.
  let templateOnly = Boolean(
    workspace.assistantTemplateOnlyUntil && workspace.assistantTemplateOnlyUntil > new Date()
  );
  if (!templateOnly && conversation.botMessageCount === 0) {
    const limit = aiConversationLimit(workspace);
    if (workspace.aiConversationsThisPeriod >= limit) {
      templateOnly = true;
      await logEvent(workspace.id, conversationId, "ai_limit_reached", { limit });
    } else {
      await prisma.workspace.update({
        where: { id: workspace.id },
        data: { aiConversationsThisPeriod: { increment: 1 } },
      });
    }
  }

  const customerText = pending.map((m) => m.text).join("\n");
  const hasMedia = pending.some((m) => m.text === "[rasm/fayl]");
  const textOnly = customerText.replace(/\[rasm\/fayl\]/g, "").trim();
  const earlier = chronological.slice(0, lastReplyIndex + 1);
  const lastBot = [...earlier].reverse().find((m) => m.author === "ASSISTANT")?.text ?? null;
  const hours = readWorkingHours(profileRow.workingHours);

  const result = await runTurn({
    profile: toSnapshot(profileRow),
    state: state as ActiveState,
    collected: readCollected(conversation.collected),
    botMessageCount: conversation.botMessageCount,
    phoneAskCount: conversation.phoneAskCount,
    spamStreak: conversation.spamStreak,
    maxBotMessages: profileRow.maxBotMessages,
    fallbackLeadWithoutPhone: profileRow.fallbackLeadWithoutPhone,
    history: earlier.slice(-12).map((m) => ({
      role: m.author === "CUSTOMER" ? ("user" as const) : ("assistant" as const),
      content: m.text,
    })),
    customerText: textOnly,
    hasMedia,
    igName: conversation.igName,
    lastBotMessage: lastBot,
    templateOnly,
    offHours: !isWithinWorkingHours(hours),
    offHoursMessage: profileRow.offHoursMessage,
    llm: getLlmProvider(),
  });

  // Bookkeeping that must survive even if the send below fails.
  for (const usage of result.usages) {
    await prisma.llmUsage
      .create({
        data: {
          workspaceId: workspace.id,
          conversationId,
          model: usage.model,
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          costUsd: usage.costUsd,
          latencyMs: usage.latencyMs,
          ok: usage.ok,
        },
      })
      .catch(() => {});
  }
  for (const event of result.events) {
    await logEvent(workspace.id, conversationId, event.type, event.payload);
  }
  if (result.llmFailed) await registerLlmFailure(workspace.id, conversationId);
  else if (result.usages.some((u) => u.ok)) await registerLlmSuccess(workspace.id);
  if (result.unknownQuestion) await recordKnowledgeGap(workspace.id, result.unknownQuestion);

  // A newer customer message arrived while the model was thinking: drop this
  // turn (nothing persisted yet) and answer everything together.
  const fresh = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { lastCustomerMessageAt: true, operatorActiveUntil: true, botPaused: true },
  });
  if (fresh?.lastCustomerMessageAt && last && fresh.lastCustomerMessageAt > last) {
    await scheduleReply(conversationId, DEBOUNCE_MS);
    return;
  }
  if (fresh?.botPaused || (fresh?.operatorActiveUntil && fresh.operatorActiveUntil > new Date())) {
    return;
  }

  const collectedJson = JSON.parse(JSON.stringify(result.collected));
  const stateUpdate = {
    assistantState: result.state,
    collected: collectedJson,
    botMessageCount: result.botMessageCount,
    phoneAskCount: result.phoneAskCount,
    spamStreak: result.spamStreak,
  };

  if (result.reply) {
    const elapsed = Date.now() - startedAt;
    const delay = Math.max(0, typingDelayMs(result.reply.length) - elapsed);
    await sendSenderAction(token, account.instagramId, conversation.igUserId, "mark_seen").catch(() => {});
    await sendSenderAction(token, account.instagramId, conversation.igUserId, "typing_on").catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, delay));

    // The operator may have stepped in during the typing delay.
    const recheck = await prisma.conversation.findUnique({
      where: { id: conversationId },
      select: { operatorActiveUntil: true, botPaused: true },
    });
    if (recheck?.botPaused || (recheck?.operatorActiveUntil && recheck.operatorActiveUntil > new Date())) {
      return;
    }

    const sent = await deliverReply(conversation, token, result.reply, {
      intent: result.intent,
      usedTemplate: result.usedTemplate,
    });
    if (!sent) return; // send failed: keep the state, retry on the next customer message
  }

  await prisma.conversation.update({ where: { id: conversationId }, data: stateUpdate });

  if (result.lead) {
    await createLeadForConversation(conversationId, {
      flag: result.lead.flag,
      summary: result.lead.summary,
    });
  }
}

/** Send via Instagram and store it. Returns false when Meta refused the message. */
async function deliverReply(
  conversation: Conversation & { workspace: { id: string }; instagramAccount: InstagramAccount },
  token: string,
  reply: string,
  meta: Record<string, unknown>
): Promise<boolean> {
  const { instagramAccount: account } = conversation;
  try {
    const response = await sendDirectMessage(
      token,
      account.instagramId,
      conversation.igUserId,
      reply
    );
    await prisma.conversationMessage
      .create({
        data: {
          conversationId: conversation.id,
          mid: response.message_id,
          author: "ASSISTANT",
          text: reply,
          llmMeta: JSON.parse(JSON.stringify(meta)),
        },
      })
      .catch(() => {});
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: { lastBotMessageAt: new Date() },
    });
    return true;
  } catch (error) {
    if (error instanceof TokenExpiredError) {
      await markTokenBroken(account.id, error.message);
    }
    await logEvent(conversation.workspace.id, conversation.id, "send_failed", {
      message: error instanceof Error ? error.message : String(error),
      code: error instanceof MetaApiError ? error.code : null,
    });
    return false;
  }
}
