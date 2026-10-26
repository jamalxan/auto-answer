/**
 * JavobAI engine — wires `runJavobAiTurn` to Instagram, the database and
 * the "javobai" queue, mirroring lib/assistant/engine.ts step for step
 * (same conversation record, same lock key `conv:<id>:lock`, same 4s
 * debounce, same 24h window, same idempotent message store) without
 * importing its private functions. Everything here is idempotent: webhooks
 * are retried by Meta and BullMQ jobs can run twice.
 *
 * Modes are re-checked at job time: a LIVE → OFF switch turns pending jobs
 * into no-ops; a SHADOW job on an account that is no longer SHADOW is a
 * no-op too.
 *
 * SHADOW never writes Conversation / ConversationMessage / memory: it reads
 * what production stored, computes its own reply with the history up to the
 * customer's message and stores an AiShadowTurn (+ LlmUsage "javobai_shadow").
 * The job runs SHADOW_DELAY_MS after the webhook so production's reply is
 * usually already there; when it is not, productionReply stays null. SHADOW
 * ignores media.
 *
 * ETAP 4.2–4.4 live here too:
 *   memory   (4.2) loaders feed the prompt ("MIJOZ HAQIDA"); after each LIVE
 *            turn the rolling summary grows / compacts (LlmUsage
 *            "javobai_summary") and the contact memory is upserted
 *   media    (4.3) voice notes are transcribed and photos described at inbound
 *            time, under the conversation lock, before the message is stored:
 *            the transcript IS the customer message ("🎤 …"), the photo
 *            outcome rides on the message's llmMeta for the reply job. Media
 *            bytes and signed urls never reach a log or the database.
 *   budget   (4.4) `enforceBudgetBeforeCall` once per job before any model /
 *            STT / vision call; hard limit in LIVE → one template per
 *            conversation + handoff "budget", never a model call; soft limit →
 *            default model and reduced caps. Every call (failures included)
 *            is an LlmUsage row through `recordJavobAiUsage`.
 */

import { randomUUID } from "node:crypto";
import type { AiConversationState, Conversation, ConversationMessage, InstagramAccount, Workspace } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { DEBOUNCE_MS, typingDelayMs } from "@/lib/assistant/humanize";
import { recordKnowledgeGap } from "@/lib/assistant/knowledge-gaps";
import type { Lang } from "@/lib/assistant/language";
import { getLlmProviderFor, type LLMProvider } from "@/lib/assistant/llm/provider";
import { aiConversationLimit, findProfile, isProfileLive, type LoadedProfile } from "@/lib/assistant/profile";
import { transcribeVoice } from "@/lib/assistant/stt";
import type { TurnEvent } from "@/lib/assistant/turn";
import { extractPhone } from "@/lib/leads/phone";
import { createLeadForConversation, notifyCustomerWroteAgain, readCollected, type Collected } from "@/lib/leads/service";
import { MetaApiError, TokenExpiredError, getMessagingProfile, sendDirectMessage, sendSenderAction } from "@/lib/meta/client";
import { decryptToken } from "@/lib/meta/oauth";
import { markTokenBroken } from "@/lib/meta/token-health";
import { getRedisConnection } from "@/lib/queue/client";
import { CONVERSATION_EVENT_TYPES, findActiveConversations } from "@/lib/triggers/claim";
import { findConsumingRun } from "@/lib/flows/bridge";
import { findPendingLeadExecution } from "@/lib/triggers/lead-capture";
import { matchKeywords } from "@/lib/utils/keyword-matcher";
import {
  acquireMediaSlot,
  classifyAttachments,
  describeMediaUrl,
  fetchAudioAttachment,
  fetchImageAttachment,
  type ClassifiedAttachments,
  type InboundAttachment,
} from "./attachments";
import { enforceBudgetBeforeCall, runBudgetAlerts, type BudgetGate, type BudgetStatus } from "./budget";
import type { JavobAiConfig } from "./config";
import { getJavobAiMode } from "./gate";
import { acceptHandoff, autoCloseInactiveHandoffs, escalatePendingHandoffs, mayResumeAfterClose, openHandoff, reopenAi } from "./handoff";
import { loadKnowledgeBlock, type KnowledgeBlock } from "./knowledge";
import { decideLadder, type LadderDecision } from "./ladder";
import { createDraft, loadIntentMode, recordLadderSample } from "./ladder-service";
import { detectLanguageV2, fromLegacyLang, toLegacyLang } from "./language";
import { captureJavobAiLead } from "./leads";
import {
  SUMMARY_MAX_CHARS,
  buildSummaryUpdate,
  compactSummaryIfNeeded,
  contactMemoryBlock,
  factsFromTurn,
  isReturningContact,
  loadContactMemory,
  loadConversationMemory,
  saveConversationSummary,
  toLlmMessages,
  upsertContactMemory,
} from "./memory";
import { enqueueJavobAiInbound, scheduleJavobAiReply, type JavobAiEchoJob, type JavobAiInboundJob } from "./queue";
import { selectProductsV2 } from "./retrieval";
import { modelForTask, perTurnCaps, type RoutingTask } from "./routing";
import {
  NEW_CONVERSATION_AFTER_MS,
  countedSignals,
  ensureAiState,
  loadAccountConfig,
  loadHandoffRules,
  loadScoringConfig,
  readContext,
  readExtracted,
  recordSignals,
  upsertConversation,
} from "./state";
import type { ScoringConfig } from "./scoring";
import { STT_LOW_CONFIDENCE, geminiSttModel, sttUsageRecord } from "./stt-gemini";
import { pickJavobAiTemplate } from "./templates";
import { validateReply, type ValidationIssue } from "./validate";
import { runJavobAiTurn, type JavobAiTurnContext, type JavobAiTurnResult } from "./turn";
import { recordJavobAiUsage, type JavobAiUsageKind } from "./usage";
import { MAX_CATALOG_ITEMS, decideImageOutcome, describeAndMatchImage, visionSystemNote, visionUsageRecord, type ImageOutcome } from "./vision";

const DAY_MS = 24 * 60 * 60 * 1000;
/** Production's window for "this DM answers one of our campaign DMs" (engine.ts). */
const CAMPAIGN_REPLY_WINDOW_MS = 3 * DAY_MS;
/** Production's window for "a DM our worker logged as sent moments ago is ours" (handleEcho). */
const JUST_SENT_WINDOW_MS = 2 * 60_000;
// Longer than LLM retries (2 x 12s) + the typing delay (<= 9s) + sends, and
// than one voice note (download 15s + STT 30s + one retry) plus one photo.
const LOCK_TTL_SECONDS = 90;
const HISTORY_MESSAGES = 30;
/** How long an inbound media job waits for a reply job to finish before going ahead without the lock. */
const MEDIA_LOCK_WAIT_MS = 500;
const MEDIA_LOCK_ATTEMPTS = 12;
export const USAGE_KIND_LIVE: JavobAiUsageKind = "javobai_reply";
export const USAGE_KIND_SHADOW: JavobAiUsageKind = "javobai_shadow";
/** Production's placeholder for a message that is only media (the media template answers it). */
export const MEDIA_PLACEHOLDER = "[rasm/fayl]";
/** A voice note that could not be transcribed (the "please write it" template answers it). */
export const VOICE_PLACEHOLDER = "[ovozli xabar]";
const PLACEHOLDERS = /\[rasm\/fayl\]|\[ovozli xabar\]/g;

/** What vision / STT made of one attachment, kept on the CUSTOMER message (no bytes, no url). */
export interface JavobAiMediaMeta {
  kind: "audio" | "image";
  /** audio: transcribed | unclear; image: an ImageOutcome, or "skipped" (cap / budget / no provider → media template). */
  outcome: "transcribed" | "unclear" | ImageOutcome | "skipped";
  provider?: string;
  confidence?: number | null;
  /** image: `visionSystemNote` — description + matched names, for the system prompt. */
  systemNote?: string;
  /** image: catalog matches by name (ids are re-resolved against the turn's KB). */
  matches?: Array<{ id: string; name: string }>;
  /** image: the model's clarifying question ("ask"). */
  question?: string | null;
}

/** What a JavobAI message stores in ConversationMessage.llmMeta. */
export interface JavobAiMessageMeta {
  javobai: true;
  intent?: string;
  confidence?: number;
  usedFacts?: string[];
  askedPhone?: boolean;
  askedField?: string | null;
  postHandoff?: boolean;
  handoff?: string | null;
  usedTemplate?: boolean;
  /** 4.4: the "AI paused, a manager answers" template — once per conversation. */
  budgetNotice?: boolean;
  /** Trust ladder: a COPILOT draft a human sent (id of the AiDraft). */
  draftId?: string;
  /** 4.3: the "please write it" template for a voice note. */
  voiceUnclear?: boolean;
  /** 4.3: on CUSTOMER messages that carried media. */
  media?: JavobAiMediaMeta[];
}

function tokenOf(account: InstagramAccount): string | null {
  if (!account.accessToken) return null;
  try {
    return decryptToken(account.accessToken);
  } catch {
    return null;
  }
}

async function logEvent(workspaceId: string, conversationId: string | null, type: string, payload?: Record<string, unknown>) {
  await prisma.assistantEvent
    .create({
      data: {
        workspaceId,
        conversationId,
        type: `jai_${type}`,
        payload: payload ? JSON.parse(JSON.stringify(payload)) : undefined,
      },
    })
    .catch(() => {});
}

async function recordUsages(workspaceId: string, conversationId: string | null, usages: JavobAiTurnResult["usages"], kind: JavobAiUsageKind) {
  for (const usage of usages) await recordJavobAiUsage({ workspaceId, conversationId, kind, ...usage });
}

async function recordEvents(workspaceId: string, conversationId: string | null, events: TurnEvent[]) {
  for (const event of events) await logEvent(workspaceId, conversationId, event.type, event.payload);
}

function metaOf(message: Pick<ConversationMessage, "llmMeta">): JavobAiMessageMeta | null {
  const meta = message.llmMeta as JavobAiMessageMeta | null;
  return meta && meta.javobai ? meta : null;
}

function isMuted(c: Pick<Conversation, "botPaused" | "operatorActiveUntil">): boolean {
  return c.botPaused || Boolean(c.operatorActiveUntil && c.operatorActiveUntil > new Date());
}

/** `getLlmProviderFor` for a routed task; null under the hard budget (never call). */
function providerFor(task: RoutingTask, status: BudgetStatus): LLMProvider | null {
  const model = modelForTask(task, status);
  return model === null ? null : getLlmProviderFor(model);
}

/** The smart model for one low-confidence retry, only when it differs from the reply model. */
function retryProviderFor(status: BudgetStatus): LLMProvider | null {
  const reply = modelForTask("reply", status);
  const retry = modelForTask("retry_low_confidence", status);
  return retry && retry !== reply ? getLlmProviderFor(retry) : null;
}

/** The customer's language for templates: this text, else the earlier turns, else Uzbek Latin. */
function langOf(text: string, collected: ReturnType<typeof readCollected>): Lang {
  const previous = fromLegacyLang(collected.language);
  const detected = detectLanguageV2(text, previous);
  return toLegacyLang(detected === "unknown" ? previous : detected);
}

// ─── Inbound ───────────────────────────────────────────────────────────────────

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

export async function handleJavobAiInbound(job: JavobAiInboundJob): Promise<void> {
  const account = await prisma.instagramAccount.findUnique({ where: { instagramId: job.instagramAccountId } });
  if (!account) return;

  // Re-checked at job time: a mode switch after the webhook makes this a no-op.
  const mode = await getJavobAiMode(account.id);
  if (job.shadow ? mode !== "SHADOW" : mode !== "LIVE") return;

  const profileRow = await findProfile(account.workspaceId, account.id);
  if (!profileRow || !isProfileLive(profileRow)) return;
  const text = job.text.trim() || (job.hasAttachment ? MEDIA_PLACEHOLDER : "");
  if (!text) return;

  if (job.shadow) return runShadowTurn(account, profileRow, job, text);

  let conversation = await upsertConversation(account, job.senderId);

  // 4.3: voice / photo are processed now (CDN urls expire within minutes),
  // before the message is stored, so the reply job sees the transcript.
  const media = classifyAttachments(job.attachments);
  let stored: { text: string; meta: JavobAiMessageMeta | null } = { text, meta: null };
  if (media.audio.length || media.images.length) {
    // Meta redelivery: already stored → never transcribe twice.
    const known = await prisma.conversationMessage.findFirst({ where: { conversationId: conversation.id, mid: job.messageId }, select: { id: true } });
    if (known) return;
    stored = await processInboundMedia({ job, media, account, conversation, profileRow });
  }

  // Idempotent store (Meta may deliver the same webhook twice).
  try {
    await prisma.conversationMessage.create({
      data: {
        conversationId: conversation.id,
        mid: job.messageId,
        author: "CUSTOMER",
        text: stored.text,
        ...(stored.meta ? { llmMeta: JSON.parse(JSON.stringify(stored.meta)) } : {}),
      },
    });
  } catch {
    return; // already processed
  }
  conversation = await prisma.conversation.update({
    where: { id: conversation.id },
    data: { lastCustomerMessageAt: new Date(), ...(job.source === "trigger" ? { source: "CAMPAIGN" as const } : {}) },
  });
  conversation = await fillCustomerProfile(conversation, account);

  // Which kind of conversation is this (production's rule): a reply to a
  // legacy keyword-campaign DM keeps the campaign on the conversation, so the
  // lead carries the attribution; everything else is an inbound DM.
  const link = await linkCampaignReply(conversation, account, job.senderId);
  conversation = link.conversation;

  let state = await ensureAiState(conversation);
  if (state.handoffState === "CLOSED") {
    // The operator closed the handoff: the next customer message brings the
    // AI back (unless the close said otherwise). Memory is kept.
    if (!(await mayResumeAfterClose(conversation.id))) return;
    await reopenAi(conversation.id);
    state = await ensureAiState(conversation);
  }
  const humanHolds = state.handoffState === "OPERATOR_ACTIVE" || isMuted(conversation);
  if (humanHolds) {
    // Trust ladder: while a human answers, the AI still drafts in silence so
    // the operator's reply becomes a comparison sample (audit: "kuzatish").
    if ((await loadAccountConfig(account.id)).ladderEnabled) await runShadowTurn(account, profileRow, job, text, "observe");
    if (state.handoffState === "OPERATOR_ACTIVE") return;
  }
  if (state.handoffState === "HANDOFF_PENDING") await notifyCustomerWroteAgain(conversation.id);
  if (humanHolds) return;

  // The AI quick-reply action hands the thread over explicitly (source
  // trigger): the owner's switches and the other bots do not apply to it.
  if (job.source !== "trigger") {
    // The profile's own switches (production's "assistantWanted"): inbound DMs
    // and campaign replies can each be left to the humans. Without the
    // assistant a number typed in reply to a campaign DM is still a lead.
    const wanted = link.handoffCampaignId ? profileRow.handleCampaignReplies : profileRow.handleInboundDm;
    if (!wanted) {
      await captureCampaignReplyPhone(conversation, text, link.anyCampaignId);
      return;
    }

    // The legacy keyword campaign (dmTriggerEnabled) answers this DM itself
    // from the webhook's keyword path: never a keyword autoreply plus ours.
    if (conversation.assistantState === "NEW" && (await matchesKeywordCampaign(account.id, text))) {
      await logEvent(account.workspaceId, conversation.id, "keyword_campaign_answers");
      return;
    }

    // A Comment 2.0 / live / Direct trigger flow may still own this person's
    // thread (< 24h since its last activity). The trigger engine answers a
    // plain DM in two cases only: the thread was handed to an operator
    // (HANDOFF chip) or a LEAD_CAPTURE chip is waiting for the number. After
    // a MESSAGE chip nobody else would answer the question, so JavobAI does.
    const owners = await findActiveConversations({
      accountId: account.id,
      senderId: job.senderId,
      at: new Date(),
      eventTypes: CONVERSATION_EVENT_TYPES,
    }).catch(() => []);
    const handedOff = owners.find((o) => o.handedOffAt);
    if (handedOff) {
      await logEvent(account.workspaceId, conversation.id, "trigger_owns_thread", { executionId: handedOff.id, reason: "handoff" });
      return;
    }
    const pendingLead = await findPendingLeadExecution({ id: account.id }, job.senderId).catch(() => null);
    if (pendingLead) {
      await logEvent(account.workspaceId, conversation.id, "trigger_owns_thread", { executionId: pendingLead.id, reason: "lead_capture" });
      return;
    }
    // A flow run (ETAP 6) waiting for this person's answer owns the thread.
    const flowRun = await findConsumingRun(account.id, job.senderId).catch(() => null);
    if (flowRun) {
      await logEvent(account.workspaceId, conversation.id, "trigger_owns_thread", { runId: flowRun.id, reason: "flow" });
      return;
    }
  }

  await scheduleJavobAiReply(conversation.id, DEBOUNCE_MS);
}

/**
 * Production's campaign link (engine.ts, kept private there): a NEW
 * conversation whose customer answers a keyword-campaign DM sent in the last
 * three days becomes a CAMPAIGN conversation of that automation.
 * `handoffCampaignId` is set only when the automation hands its replies to
 * the assistant; `anyCampaignId` for the phase-1 lead.
 */
async function linkCampaignReply(conversation: Conversation, account: InstagramAccount, senderId: string) {
  let handoffCampaignId: string | null = conversation.campaignId;
  let anyCampaignId: string | null = conversation.campaignId;
  if (!conversation.campaignId && conversation.assistantState === "NEW") {
    const log = await prisma.dmLog.findFirst({
      where: {
        instagramAccountId: account.id,
        commenterId: senderId,
        status: "SENT",
        dmSentAt: { gte: new Date(Date.now() - CAMPAIGN_REPLY_WINDOW_MS) },
      },
      orderBy: { dmSentAt: "desc" },
      select: { automationId: true, automation: { select: { handoffToAssistant: true } } },
    });
    if (log) {
      anyCampaignId = log.automationId;
      if (log.automation.handoffToAssistant) handoffCampaignId = log.automationId;
      conversation = await prisma.conversation.update({
        where: { id: conversation.id },
        data: { campaignId: anyCampaignId, source: "CAMPAIGN" },
      });
    }
  }
  return { conversation, handoffCampaignId, anyCampaignId };
}

/** Phase-1 behaviour (no assistant wanted): a number typed in reply to a campaign DM is a lead anyway. */
async function captureCampaignReplyPhone(conversation: Conversation, text: string, campaignId: string | null): Promise<void> {
  const phone = extractPhone(text);
  if (!phone || !campaignId) return;
  const collected: Collected = { ...readCollected(conversation.collected), phone_e164: phone.e164, phone_raw: phone.raw };
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { collected: JSON.parse(JSON.stringify(collected)), assistantState: "HANDED_OFF" },
  });
  await createLeadForConversation(conversation.id, { summary: "Mijoz kampaniya DM'iga raqam yozib javob berdi." });
}

/** A legacy keyword campaign that answers this DM itself (production's rule, mirrored). */
async function matchesKeywordCampaign(accountId: string, text: string): Promise<boolean> {
  const campaigns = await prisma.automation.findMany({
    where: { instagramAccountId: accountId, isActive: true, dmTriggerEnabled: true },
    select: { keywords: true, matchAnyWord: true, wholeWordMatch: true },
  });
  return campaigns.some((c) => c.matchAnyWord || matchKeywords(text, c.keywords, c.wholeWordMatch).matched);
}

// ─── Media (4.3) ───────────────────────────────────────────────────────────────

interface MediaJobInput {
  job: JavobAiInboundJob;
  media: ClassifiedAttachments;
  account: InstagramAccount;
  conversation: Conversation;
  profileRow: LoadedProfile;
}

/**
 * One voice note and one photo per message (Instagram sends one attachment
 * per DM), under the conversation lock so a reply job in flight does not
 * answer the typed text before the transcript lands. The budget gate runs
 * once here (hard limit → media skipped: voice → "please write it", photo →
 * media template) and the per-conversation cap (3 / 10 min) after it.
 * Returns what to store as the CUSTOMER message.
 */
async function processInboundMedia(input: MediaJobInput): Promise<{ text: string; meta: JavobAiMessageMeta | null }> {
  const { job, media, account, conversation } = input;
  const workspaceId = account.workspaceId;
  const scope = { workspaceId, conversationId: conversation.id };
  const typed = job.text.trim();
  const collected = readCollected(conversation.collected);
  const gate = await enforceBudgetBeforeCall(workspaceId);
  if (!gate.allowed) await logEvent(workspaceId, conversation.id, "media_skipped", { reason: "budget" });
  const allowed = async () => {
    if (!gate.allowed) return false;
    const slot = await acquireMediaSlot(getRedisConnection(), conversation.id);
    if (!slot) await logEvent(workspaceId, conversation.id, "media_skipped", { reason: "cap" });
    return slot;
  };

  const lockToken = await acquireLockWithWait(conversation.id);
  try {
    const metas: JavobAiMediaMeta[] = [];
    let text = typed;

    if (media.audio.length) {
      const transcript = await transcribeInbound(media.audio[0], { scope, hint: collected.language === "ru" ? "ru" : "uz", allowed });
      if (transcript) {
        text = typed ? `🎤 ${transcript.text}\n${typed}` : `🎤 ${transcript.text}`;
        metas.push({ kind: "audio", outcome: "transcribed", provider: transcript.provider, confidence: transcript.confidence });
      } else {
        // The typed text (if any) is answered; the note itself gets the template.
        text = typed || VOICE_PLACEHOLDER;
        metas.push({ kind: "audio", outcome: "unclear" });
      }
    }

    if (media.images.length) {
      metas.push(
        await describeInboundImage(media.images[0], {
          scope,
          lang: toLegacyLang(fromLegacyLang(collected.language)),
          customerText: typed,
          profileRow: input.profileRow,
          accountId: account.id,
          status: gate.status,
          allowed,
        })
      );
      if (!text) text = MEDIA_PLACEHOLDER;
    }

    return { text, meta: metas.length ? { javobai: true, media: metas } : null };
  } finally {
    if (lockToken) await releaseLock(conversation.id, lockToken);
  }
}

async function transcribeInbound(
  voice: InboundAttachment,
  ctx: { scope: { workspaceId: string; conversationId: string }; hint: "uz" | "ru"; allowed: () => Promise<boolean> }
): Promise<{ text: string; provider: string; confidence: number | null } | null> {
  if (!(await ctx.allowed())) return null;
  const { workspaceId, conversationId } = ctx.scope;
  const started = Date.now();
  try {
    const file = await fetchAudioAttachment(voice.url);
    const result = await transcribeVoice({ buffer: file.buffer, mime: file.mime, languageHint: ctx.hint }, { preferred: "gemini" });
    if (!result) {
      await logEvent(workspaceId, conversationId, "voice_skipped", { reason: "stt_not_configured" });
      return null;
    }
    await recordJavobAiUsage(sttUsageRecord(result, ctx.scope));
    const text = result.text.trim();
    const confident = result.confidence === null || result.confidence >= STT_LOW_CONFIDENCE;
    if (!text || !confident) {
      await logEvent(workspaceId, conversationId, "voice_unclear", { provider: result.provider, confidence: result.confidence, chars: text.length });
      return null;
    }
    await logEvent(workspaceId, conversationId, "voice_transcribed", {
      provider: result.provider,
      confidence: result.confidence,
      chars: text.length,
      ...(result.fallbackFrom ? { fallbackFrom: result.fallbackFrom.provider } : {}),
    });
    return { text, provider: result.provider, confidence: result.confidence };
  } catch (error) {
    // AttachmentError (too_large / unsupported_type / private_address / timeout) or every STT provider failed.
    await recordJavobAiUsage(
      sttUsageRecord({ model: geminiSttModel() ?? "unknown", inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: Date.now() - started }, ctx.scope, false)
    );
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[JavobAI] voice failed:", message, describeMediaUrl(voice.url));
    await logEvent(workspaceId, conversationId, "voice_failed", { error: message.slice(0, 200) });
    return null;
  }
}

async function describeInboundImage(
  photo: InboundAttachment,
  ctx: {
    scope: { workspaceId: string; conversationId: string };
    lang: Lang;
    customerText: string;
    profileRow: LoadedProfile;
    accountId: string;
    status: BudgetStatus;
    allowed: () => Promise<boolean>;
  }
): Promise<JavobAiMediaMeta> {
  const skipped = (reason: string): JavobAiMediaMeta => {
    void logEvent(ctx.scope.workspaceId, ctx.scope.conversationId, "media_skipped", { reason });
    return { kind: "image", outcome: "skipped" };
  };
  if (!(await ctx.allowed())) return { kind: "image", outcome: "skipped" };
  const provider = providerFor("vision", ctx.status);
  if (!provider) return skipped("no_provider");
  const { workspaceId, conversationId } = ctx.scope;
  const started = Date.now();
  try {
    const [file, kb, config] = await Promise.all([
      fetchImageAttachment(photo.url),
      loadKnowledgeBlock(ctx.profileRow.id, ctx.customerText),
      loadAccountConfig(ctx.accountId),
    ]);
    if (!kb) return skipped("no_profile");
    // The catalog the model sees: the products in the order the KB would list
    // them for this text, so "P3" here is "P3" in the turn whenever it made the cut.
    const catalog = selectProductsV2(ctx.customerText, kb.profile.products, MAX_CATALOG_ITEMS).map((p, i) => ({
      id: `P${i + 1}`,
      name: p.name,
      note: p.note ?? null,
    }));
    const result = await describeAndMatchImage({ buffer: file.buffer, mime: file.mime, provider, catalog, lang: ctx.lang, customerText: ctx.customerText });
    await recordJavobAiUsage(visionUsageRecord(result, ctx.scope));
    const outcome = decideImageOutcome(result, config.confidenceThreshold);
    await logEvent(workspaceId, conversationId, "image_described", { outcome, matches: result.matches.length, confidence: result.confidence, model: result.model });
    return {
      kind: "image",
      outcome,
      confidence: result.confidence,
      systemNote: visionSystemNote(result),
      matches: result.matches,
      question: result.question,
    };
  } catch (error) {
    await recordJavobAiUsage(
      visionUsageRecord({ model: provider.model, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: Date.now() - started }, ctx.scope, false)
    );
    const message = error instanceof Error ? error.message : String(error);
    console.warn("[JavobAI] vision failed:", message, describeMediaUrl(photo.url));
    await logEvent(workspaceId, conversationId, "image_failed", { error: message.slice(0, 200) });
    // Unreadable photo: the turn treats it as an unknown (gap + streak), not a handoff by itself.
    return { kind: "image", outcome: "handoff" };
  }
}

// ─── Shadow ────────────────────────────────────────────────────────────────────

async function runShadowTurn(
  account: InstagramAccount,
  profileRow: LoadedProfile,
  job: JavobAiInboundJob,
  text: string,
  source: "shadow" | "observe" = "shadow"
): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { instagramAccountId_igUserId: { instagramAccountId: account.id, igUserId: job.senderId } },
  });
  const messages = conversation
    ? await prisma.conversationMessage.findMany({ where: { conversationId: conversation.id }, orderBy: { createdAt: "asc" }, take: 200 })
    : [];
  const customerIndex = messages.findIndex((m) => m.mid === job.messageId);
  const earlier = customerIndex >= 0 ? messages.slice(0, customerIndex) : messages;
  const customerAt = customerIndex >= 0 ? messages[customerIndex].createdAt : null;
  const productionReply =
    customerAt !== null
      ? (messages.find((m) => m.author === "ASSISTANT" && m.createdAt > customerAt)?.text ?? null)
      : null;

  // Hard budget: SHADOW skips silently (nothing is sent anyway, no usage row).
  const gate = await enforceBudgetBeforeCall(account.workspaceId);
  if (!gate.allowed) {
    await logEvent(account.workspaceId, conversation?.id ?? null, "budget_hard_exceeded", { mode: source });
    return;
  }
  const caps = perTurnCaps(gate.status);

  const row = {
    workspaceId: account.workspaceId,
    conversationId: conversation?.id ?? null,
    customerText: text,
    productionReply,
    instagramAccountId: account.id,
    source,
    customerMessageId: customerIndex >= 0 ? messages[customerIndex].id : null,
  };
  try {
    const [config, scoring, rules, kb] = await Promise.all([
      loadAccountConfig(account.id),
      loadScoringConfig(account.workspaceId, account.id),
      loadHandoffRules(account.workspaceId),
      loadKnowledgeBlock(profileRow.id, text, caps.maxKbChars),
    ]);
    if (!kb) return;
    // Stateless by design (nothing of SHADOW is persisted on the conversation):
    // the score shown is this turn's own signals.
    const result = await runJavobAiTurn({
      kb,
      config,
      scoring,
      rules,
      state: { handoffState: "AI_ACTIVE", score: 0, extracted: {}, unknownStreak: 0, turns: earlier.filter((m) => m.author !== "CUSTOMER").length, countedSignals: [], phoneAskCount: 0, askedFields: [], postHandoffReplies: 0 },
      collected: conversation ? readCollected(conversation.collected) : {},
      memory: { summary: "", facts: {}, returning: false },
      context: {},
      history: earlier.slice(-caps.maxHistory).map((m) => ({ role: m.author === "CUSTOMER" ? ("user" as const) : ("assistant" as const), content: m.text })),
      customerText: text === MEDIA_PLACEHOLDER ? "" : text,
      hasMedia: text === MEDIA_PLACEHOLDER,
      igName: conversation?.igName ?? null,
      lastBotMessage: [...earlier].reverse().find((m) => m.author === "ASSISTANT")?.text ?? null,
      templateOnly: false,
      llm: providerFor("reply", gate.status),
      llmRetry: retryProviderFor(gate.status),
      caps,
    });
    const costUsd = result.usages.reduce((n, u) => n + u.costUsd, 0);
    await prisma.aiShadowTurn.create({
      data: {
        ...row,
        aiReply: result.reply,
        intent: result.intent,
        confidence: result.confidence,
        score: result.score,
        handoff: result.handoff.needed ? (result.handoff.reason ?? "handoff") : null,
        costUsd,
        error: result.llmFailed ? "LLM javob bermadi" : null,
      },
    });
    await recordUsages(account.workspaceId, conversation?.id ?? null, result.usages, USAGE_KIND_SHADOW);
  } catch (error) {
    await prisma.aiShadowTurn
      .create({ data: { ...row, error: (error instanceof Error ? error.message : String(error)).slice(0, 500) } })
      .catch(() => {});
  }
}

// ─── Echo (operator took over) ─────────────────────────────────────────────────

/**
 * The account itself sent a message. Production's handleEcho already sets the
 * hard mute; here a pending handoff becomes OPERATOR_ACTIVE (accepted by the
 * echo), so the Telegram "Qabul qildim" button is optional.
 */
export async function handleJavobAiEcho(job: JavobAiEchoJob): Promise<void> {
  const ownAppId = process.env.INSTAGRAM_APP_ID;
  if (job.appId && ownAppId && String(job.appId) === String(ownAppId)) return;
  const account = await prisma.instagramAccount.findUnique({ where: { instagramId: job.instagramAccountId }, select: { id: true, workspaceId: true } });
  if (!account) return;
  // Production's rule: a campaign DM / reveal our worker logged as sent to
  // this customer moments ago is ours whatever app_id Meta reports — it must
  // never accept a handoff on the operator's behalf.
  const justSent = await prisma.dmLog.findFirst({
    where: { instagramAccountId: account.id, commenterId: job.customerId, dmSentAt: { gte: new Date(Date.now() - JUST_SENT_WINDOW_MS) } },
    select: { id: true },
  });
  if (justSent) return;
  // Our own sends (JavobAI's and production's) store their mid as an
  // ASSISTANT message. Production's handleEcho — enqueued first, delayed the
  // same 3s — stores this very echo as an OPERATOR row before we run, so a
  // stored mid alone is not proof of our own send: only the author is.
  const known = await prisma.conversationMessage.findFirst({
    where: { mid: job.messageId, conversation: { instagramAccountId: account.id } },
    select: { author: true },
  });
  if (known?.author === "ASSISTANT") return;
  const conversation = await prisma.conversation.findUnique({
    where: { instagramAccountId_igUserId: { instagramAccountId: account.id, igUserId: job.customerId } },
    select: { id: true },
  });
  if (!conversation) return;
  const state = await prisma.aiConversationState.findUnique({ where: { conversationId: conversation.id } });
  if (!state || state.handoffState !== "HANDOFF_PENDING") return;
  await acceptHandoff(conversation.id, "echo");
  await logEvent(account.workspaceId, conversation.id, "handoff_accepted", { by: "echo" });
}

// ─── Reply job ─────────────────────────────────────────────────────────────────

/**
 * Compare-and-delete: the lock is released only by the job that holds it. A
 * media job that outlived the 90s TTL must not delete the lock a reply job
 * acquired meanwhile (that would let two reply jobs run at once). Production
 * uses the same key with a plain DEL; its own jobs never run on a LIVE
 * account, so this stricter release is compatible with it.
 */
const RELEASE_LOCK_SCRIPT = 'if redis.call("get", KEYS[1]) == ARGV[1] then return redis.call("del", KEYS[1]) end return 0';

function lockKey(conversationId: string): string {
  return `conv:${conversationId}:lock`;
}

/** The lock's token when acquired, null when another job holds it. */
async function acquireLock(conversationId: string): Promise<string | null> {
  const token = randomUUID();
  const result = await getRedisConnection().set(lockKey(conversationId), token, "EX", LOCK_TTL_SECONDS, "NX");
  return result === "OK" ? token : null;
}

async function releaseLock(conversationId: string, token: string) {
  await getRedisConnection()
    .eval(RELEASE_LOCK_SCRIPT, 1, lockKey(conversationId), token)
    .catch(() => {});
}

/**
 * Media processing waits a little for a reply job that holds the lock; if it
 * is still busy the media goes ahead without it (a lost voice note is worse
 * than a reply split in two). A Redis error fails open the same way.
 */
async function acquireLockWithWait(conversationId: string): Promise<string | null> {
  for (let attempt = 0; attempt < MEDIA_LOCK_ATTEMPTS; attempt++) {
    try {
      const token = await acquireLock(conversationId);
      if (token) return token;
    } catch {
      return null;
    }
    await new Promise((resolve) => setTimeout(resolve, MEDIA_LOCK_WAIT_MS));
  }
  return null;
}

export async function runJavobAiReply(conversationId: string): Promise<void> {
  const token = await acquireLock(conversationId);
  if (!token) {
    // Another worker (production's, ours, or a media job) is on this chat right now.
    await scheduleJavobAiReply(conversationId, 3000);
    return;
  }
  try {
    await replyInner(conversationId);
  } finally {
    await releaseLock(conversationId, token);
  }
}

/** Counters kept on the messages themselves (llmMeta), scoped to the current cycle. */
function countersFrom(messages: ConversationMessage[], handoffOpenedAt: Date | null) {
  const since = Date.now() - 30 * DAY_MS;
  const own = messages.filter((m) => m.author === "ASSISTANT" && m.createdAt.getTime() > since).map((m) => metaOf(m)).filter(Boolean) as JavobAiMessageMeta[];
  return {
    phoneAskCount: own.filter((m) => m.askedPhone).length,
    askedFields: [...new Set(own.map((m) => m.askedField).filter((f): f is string => Boolean(f)))],
    postHandoffReplies: handoffOpenedAt
      ? messages.filter((m) => m.author === "ASSISTANT" && m.createdAt > handoffOpenedAt && metaOf(m)?.postHandoff).length
      : 0,
    budgetNoticeSent: own.some((m) => m.budgetNotice),
  };
}

type LoadedConversation = Conversation & { instagramAccount: InstagramAccount; workspace: Workspace; messages: ConversationMessage[] };

/** The vision outcome of the pending photo(s), resolved against this turn's KB (ids by product name). */
function mediaContextFor(metas: JavobAiMediaMeta[], kb: KnowledgeBlock): JavobAiTurnContext["media"] {
  const images = metas.filter((m) => m.kind === "image");
  if (!images.length) return null;
  const productLines = kb.lines.filter((l) => l.kind === "product");
  const idFor = (name: string) => productLines.find((l) => l.text === name || l.text.startsWith(`${name} `))?.id ?? null;
  const preferredFactIds = images
    .filter((m) => m.outcome === "answer_from_catalog")
    .flatMap((m) => (m.matches ?? []).map((match) => idFor(match.name)))
    .filter((id): id is string => Boolean(id));
  const notes = images.map((m) => m.systemNote).filter((n): n is string => Boolean(n));
  return {
    systemNote: notes.length ? notes.join(" ") : null,
    preferredFactIds,
    question: images.find((m) => m.outcome === "ask")?.question ?? null,
    unreadable: !preferredFactIds.length && images.some((m) => m.outcome === "handoff"),
  };
}

async function replyInner(conversationId: string): Promise<void> {
  const startedAt = Date.now();
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: { instagramAccount: true, workspace: true, messages: { orderBy: { createdAt: "desc" }, take: HISTORY_MESSAGES } },
  });
  if (!conversation) return;
  const { instagramAccount: account, workspace } = conversation;

  if ((await getJavobAiMode(account.id)) !== "LIVE") return;
  const profileRow = await findProfile(workspace.id, account.id);
  if (!profileRow || !isProfileLive(profileRow)) return;
  if (isMuted(conversation)) return;

  const state = await ensureAiState(conversation);
  if (state.handoffState === "OPERATOR_ACTIVE" || state.handoffState === "CLOSED") return;

  // Debounce guard: a newer message restarted the 4s window.
  const last = conversation.lastCustomerMessageAt;
  if (last) {
    const remaining = DEBOUNCE_MS - (Date.now() - last.getTime());
    if (remaining > 500) {
      await scheduleJavobAiReply(conversationId, remaining);
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
    await markTokenBroken(account.id, "JavobAI could not decrypt the Instagram token");
    return;
  }

  const customerText = pending.map((m) => m.text).join("\n");
  const mediaMetas = pending.flatMap((m) => metaOf(m)?.media ?? []);
  const textOnly = customerText.replace(PLACEHOLDERS, "").trim();
  const hasMedia = pending.some((m) => m.text === MEDIA_PLACEHOLDER || m.text === VOICE_PLACEHOLDER) || mediaMetas.some((m) => m.kind === "image");
  const voiceUnclear = mediaMetas.some((m) => m.kind === "audio" && m.outcome === "unclear");
  const earlier = chronological.slice(0, lastReplyIndex + 1);
  const lastBot = [...earlier].reverse().find((m) => m.author === "ASSISTANT")?.text ?? null;
  const collected = readCollected(conversation.collected);
  const counters = countersFrom(conversation.messages, null);
  const context = readContext(state.context);

  // 4.4: the workspace budget, once per turn, before any model call. The
  // "already told the customer" stamp lives on the state, not only in the
  // 30-message window: a long burst of customer messages must not repeat it.
  const gate = await enforceBudgetBeforeCall(workspace.id);
  if (!gate.allowed) {
    return pauseForBudget(conversation, state, token, startedAt, gate, textOnly, counters.budgetNoticeSent || budgetNoticeSentRecently(context));
  }
  const caps = perTurnCaps(gate.status);
  if (gate.flagged) await logEvent(workspace.id, conversationId, "budget_soft_exceeded", { pct: gate.check?.pct ?? null });

  // 4.3: a voice note nobody could understand, nothing else to answer.
  if (voiceUnclear && !textOnly && !mediaMetas.some((m) => m.kind === "image" && m.systemNote)) {
    if (state.handoffState !== "AI_ACTIVE") return; // the manager owns the thread and hears the note
    await sendTemplate(conversation, token, startedAt, pickJavobAiTemplate("voice_unclear", { lang: langOf("", collected), avoid: lastBot }), {
      javobai: true,
      usedTemplate: true,
      voiceUnclear: true,
    });
    return;
  }

  // Photo matches go first in the retrieval query so their products are in the KB (and citable).
  const matchNames = mediaMetas.flatMap((m) => (m.matches ?? []).map((x) => x.name));
  const kbQuery = [...matchNames, textOnly].filter(Boolean).join(" ");
  const pendingIds = new Set(pending.map((m) => m.id));
  const [config, scoring, rules, kb, counted, openHandoffRow, contact, convMemory] = await Promise.all([
    loadAccountConfig(account.id),
    loadScoringConfig(workspace.id, account.id),
    loadHandoffRules(workspace.id),
    loadKnowledgeBlock(profileRow.id, kbQuery, caps.maxKbChars),
    countedSignals(state),
    prisma.aiHandoff.findFirst({ where: { conversationId, status: "OPEN" }, orderBy: { openedAt: "desc" }, select: { openedAt: true } }),
    loadContactMemory(account.id, conversation.igUserId),
    loadConversationMemory(conversationId, caps.maxHistory + pending.length),
  ]);
  if (!kb) return;
  const postHandoffReplies = countersFrom(conversation.messages, openHandoffRow?.openedAt ?? null).postHandoffReplies;

  // AI-conversation quota, counted like production: once per conversation,
  // after the first reply actually reaches the customer.
  let templateOnly = Boolean(workspace.assistantTemplateOnlyUntil && workspace.assistantTemplateOnlyUntil > new Date());
  let countsAsAiConversation = false;
  if (!templateOnly && conversation.botMessageCount === 0) {
    const limit = aiConversationLimit(workspace);
    if (workspace.aiConversationsThisPeriod >= limit) {
      templateOnly = true;
      await logEvent(workspace.id, conversationId, "ai_limit_reached", { limit });
    } else {
      countsAsAiConversation = true;
    }
  }

  const ctx: JavobAiTurnContext = {
    kb,
    config,
    scoring,
    rules,
    state: {
      handoffState: state.handoffState,
      score: state.score,
      extracted: readExtracted(state.extracted),
      unknownStreak: state.unknownStreak,
      turns: state.turns,
      countedSignals: counted,
      phoneAskCount: counters.phoneAskCount,
      askedFields: counters.askedFields,
      postHandoffReplies,
    },
    collected,
    memory: {
      summary: convMemory.summary,
      facts: {},
      // A contact written in an earlier lead cycle is a returning customer.
      returning: isReturningContact(contact) && contact?.facts.cycle !== String(conversation.leadCycle),
      text: contactMemoryBlock(contact),
    },
    context: {
      campaignName: typeof context.campaignName === "string" ? context.campaignName : null,
      cameFromAd: Boolean(context.cameFromAd),
    },
    media: mediaContextFor(mediaMetas, kb),
    // The window from the memory loader minus this turn's own messages.
    history: toLlmMessages(convMemory.recentMessages.filter((m) => !pendingIds.has(m.id))).slice(-caps.maxHistory),
    customerText: textOnly,
    hasMedia,
    igName: conversation.igName,
    lastBotMessage: lastBot,
    templateOnly,
    llm: providerFor("reply", gate.status),
    llmRetry: retryProviderFor(gate.status),
    caps,
  };

  const result = await runJavobAiTurn(ctx);

  // Bookkeeping that must survive even if the send below fails.
  await recordUsages(workspace.id, conversationId, result.usages, USAGE_KIND_LIVE);
  await recordEvents(workspace.id, conversationId, result.events);
  if (result.unknownQuestion) await recordKnowledgeGap(workspace.id, result.unknownQuestion);

  // A newer customer message arrived while the model was thinking: drop this
  // turn (nothing persisted yet) and answer everything together.
  const fresh = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { lastCustomerMessageAt: true, operatorActiveUntil: true, botPaused: true },
  });
  if (fresh?.lastCustomerMessageAt && last && fresh.lastCustomerMessageAt > last) {
    await scheduleJavobAiReply(conversationId, DEBOUNCE_MS);
    return;
  }
  if (fresh && isMuted(fresh)) return;

  const persistOptions = { budgetStatus: gate.status, lastCustomerMessageId: pending[pending.length - 1].id };

  // Trust ladder (audit 2026-10-26): only an AUTO intent is sent; OBSERVE
  // keeps the draft as a sample, COPILOT hands it to a human. A validator
  // hit (unknown number, promise, prompt leak) never goes out on its own.
  let ladder: LadderDecision = "send";
  let issues: ValidationIssue[] = [];
  if (result.reply && config.ladderEnabled) {
    issues = result.usedTemplate ? [] : validateReply({ reply: result.reply, knowledge: `${kb.text}
${kb.filterContext.profileText}
${customerText}` });
    ladder = decideLadder({ ladderEnabled: true, intent: result.intent, mode: await loadIntentMode(account.id, result.intent), usedTemplate: result.usedTemplate });
    if (ladder === "send" && issues.length > 0) ladder = "draft";
  }
  const sample = {
    workspaceId: workspace.id,
    instagramAccountId: account.id,
    conversationId,
    customerMessageId: pending[pending.length - 1].id,
    customerText,
    aiReply: result.reply,
    intent: result.intent,
    confidence: result.confidence,
    score: result.score,
    handoff: result.handoff.needed ? (result.handoff.reason ?? "handoff") : null,
    costUsd: result.usages.reduce((n, u) => n + u.costUsd, 0),
    issues,
  };
  if (ladder !== "send") {
    if (ladder === "draft") {
      await createDraft({ ...sample, who: conversation.igUsername ? `@${conversation.igUsername}` : (conversation.igName ?? conversation.igUserId) });
    } else {
      await recordLadderSample({ ...sample, source: "observe" });
    }
    await logEvent(workspace.id, conversationId, `ladder_${ladder}`, { intent: result.intent, issues });
    await persistTurn(conversation, state, config, scoring.thresholds, result, false, persistOptions);
    return;
  }

  let delivered = false;
  if (result.reply) {
    const elapsed = Date.now() - startedAt;
    const delay = Math.max(0, typingDelayMs(result.reply.length) - elapsed);
    await sendSenderAction(token, account.instagramId, conversation.igUserId, "mark_seen").catch(() => {});
    await sendSenderAction(token, account.instagramId, conversation.igUserId, "typing_on").catch(() => {});
    await new Promise((resolve) => setTimeout(resolve, delay));

    // The operator may have stepped in during the typing delay.
    const recheck = await prisma.conversation.findUnique({ where: { id: conversationId }, select: { operatorActiveUntil: true, botPaused: true } });
    if (recheck && isMuted(recheck)) return;

    delivered = await deliverReply(conversation, token, result.reply, {
      javobai: true,
      intent: result.intent,
      confidence: result.confidence,
      usedFacts: result.usedFacts,
      askedPhone: result.askedPhone,
      askedField: result.askedField,
      postHandoff: result.postHandoff,
      handoff: result.handoff.needed ? (result.handoff.reason ?? null) : null,
      usedTemplate: result.usedTemplate,
    });
    if (!delivered) {
      // Send failed: keep the state and retry on the next customer message —
      // unless this turn captured a lead, which must never be lost.
      if (result.lead) await persistTurn(conversation, state, config, scoring.thresholds, result, false, persistOptions);
      return;
    }
    if (countsAsAiConversation) {
      await prisma.workspace.update({ where: { id: workspace.id }, data: { aiConversationsThisPeriod: { increment: 1 } } });
    }
    // An AUTO reply stays a sample: an operator message after it is judged, a critical verdict demotes the intent.
    if (config.ladderEnabled) {
      if (!result.usedTemplate) await recordLadderSample({ ...sample, source: "auto" }).catch(() => {});
      // The thread got its answer: an older copilot draft must not go out after it.
      await prisma.aiDraft.updateMany({ where: { conversationId, status: "PENDING" }, data: { status: "SUPERSEDED", decidedAt: new Date() } });
    }
  }

  await persistTurn(conversation, state, config, scoring.thresholds, result, delivered, persistOptions);
}

/**
 * 4.4, LIVE, hard limit reached: the "AI paused, a manager answers" template
 * once per conversation, a handoff with reason "budget" (idempotent), no
 * model call and no usage row. A later message while still over the limit
 * stays silent (the manager has the thread).
 */
async function pauseForBudget(
  conversation: LoadedConversation,
  state: AiConversationState,
  token: string,
  startedAt: number,
  gate: BudgetGate,
  text: string,
  noticeSent: boolean
): Promise<void> {
  const { workspace } = conversation;
  await logEvent(workspace.id, conversation.id, "budget_hard_exceeded", { usedUsd: gate.check?.usedUsd ?? null, hardUsd: gate.check?.hardUsd ?? null, noticeSent });
  if (noticeSent) return;
  const scoring = await loadScoringConfig(workspace.id, conversation.instagramAccountId);
  // The handoff first: the manager must get the thread even if the send fails.
  const opened = await openHandoff(conversation.id, {
    reason: "budget",
    score: state.score,
    thresholds: scoring.thresholds,
    summary: gate.reason ?? null,
    alert: true,
  });
  await logEvent(workspace.id, conversation.id, "handoff_opened", { reason: "budget", score: state.score, state: opened });
  const lang = langOf(text, readCollected(conversation.collected));
  const delivered = await sendTemplate(conversation, token, startedAt, pickJavobAiTemplate("budget_paused", { lang }), {
    javobai: true,
    usedTemplate: true,
    handoff: "budget",
    budgetNotice: true,
  });
  if (delivered) {
    await prisma.aiConversationState
      .update({ where: { id: state.id }, data: { context: { ...readContext(state.context), budgetNoticeAt: new Date().toISOString() } } })
      .catch(() => {});
  }
}

/** The budget notice went out in this lead cycle (30 days, like the message counters). */
function budgetNoticeSentRecently(context: Record<string, unknown>): boolean {
  const at = typeof context.budgetNoticeAt === "string" ? Date.parse(context.budgetNoticeAt) : NaN;
  return Number.isFinite(at) && Date.now() - at < NEW_CONVERSATION_AFTER_MS;
}

/** A fixed reply decided by code (no model): typing delay, mute re-check, send, counters. */
async function sendTemplate(conversation: LoadedConversation, token: string, startedAt: number, reply: string, meta: JavobAiMessageMeta): Promise<boolean> {
  const { instagramAccount: account } = conversation;
  const delay = Math.max(0, typingDelayMs(reply.length) - (Date.now() - startedAt));
  await sendSenderAction(token, account.instagramId, conversation.igUserId, "mark_seen").catch(() => {});
  await sendSenderAction(token, account.instagramId, conversation.igUserId, "typing_on").catch(() => {});
  await new Promise((resolve) => setTimeout(resolve, delay));
  const recheck = await prisma.conversation.findUnique({ where: { id: conversation.id }, select: { operatorActiveUntil: true, botPaused: true } });
  if (recheck && isMuted(recheck)) return false;
  const delivered = await deliverReply(conversation, token, reply, meta);
  if (delivered) {
    await prisma.conversation.update({
      where: { id: conversation.id },
      data: {
        botMessageCount: { increment: 1 },
        lastBotMessageAt: new Date(),
        // A handoff template leaves HANDED_OFF (set by openHandoff) alone.
        ...(conversation.assistantState === "NEW" && !meta.handoff ? { assistantState: "NEED" as const } : {}),
      },
    });
  }
  return delivered;
}

async function persistTurn(
  conversation: Conversation & { workspace: Workspace },
  state: AiConversationState,
  config: JavobAiConfig,
  thresholds: ScoringConfig["thresholds"],
  result: JavobAiTurnResult,
  delivered: boolean,
  options: { budgetStatus: BudgetStatus; lastCustomerMessageId: string }
): Promise<void> {
  const workspaceId = conversation.workspaceId;
  await prisma.aiConversationState.update({
    where: { id: state.id },
    data: {
      score: result.score,
      temperature: result.temperature,
      extracted: JSON.parse(JSON.stringify(result.extracted)),
      unknownStreak: result.unknownStreak,
      turns: delivered ? result.turns : state.turns,
    },
  });
  await recordSignals(state, result.signals);
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: {
      collected: JSON.parse(JSON.stringify(result.collected)),
      ...(delivered ? { botMessageCount: { increment: 1 }, lastBotMessageAt: new Date() } : {}),
      ...(conversation.assistantState === "NEW" && delivered ? { assistantState: "NEED" as const } : {}),
    },
  });

  // Rolling summary (4.2): the dated memory note; once a note pushes it past
  // 90 % of SUMMARY_MAX_CHARS one cheap call compacts it to ~400 chars
  // (truncated to the newest lines instead when the model is out of budget
  // or fails). Memory upkeep never fails the turn.
  const update = buildSummaryUpdate({ previousSummary: state.summary, memoryNote: result.memoryNote });
  let summary = update.summary;
  const summaryLlm = providerFor("summary", options.budgetStatus);
  const compactionStarted = Date.now();
  const compaction = update.changed
    ? await compactSummaryIfNeeded(summary, summaryLlm, { maxChars: Math.floor(SUMMARY_MAX_CHARS * 0.9) })
    : { summary, compacted: false, inputTokens: 0, outputTokens: 0, model: null, error: null };
  summary = compaction.summary;
  // Every attempted call is a usage row, a failed one too (ok: false on the
  // routed model); without a provider no call was made and nothing is logged.
  if (summaryLlm && (compaction.model || compaction.error)) {
    const model = compaction.model ?? summaryLlm.model;
    await recordJavobAiUsage({
      workspaceId,
      conversationId: conversation.id,
      kind: "javobai_summary",
      model,
      inputTokens: compaction.inputTokens,
      outputTokens: compaction.outputTokens,
      costUsd: summaryLlm.costUsd(compaction.inputTokens, compaction.outputTokens, model),
      latencyMs: Date.now() - compactionStarted,
      ok: compaction.compacted,
    });
  }
  if (compaction.error) await logEvent(workspaceId, conversation.id, "summary_compaction_failed", { error: compaction.error });
  await saveConversationSummary(conversation.id, { summary, summaryUpToMessageId: options.lastCustomerMessageId }).catch(() => {});

  // Contact memory (4.2): facts of this turn + the cycle marker the next cycle compares.
  await upsertContactMemory(conversation.instagramAccountId, conversation.igUserId, {
    facts: { ...factsFromTurn({ extracted: result.extracted, language: result.language }), cycle: String(conversation.leadCycle) },
  }).catch(() => {});

  if (result.lead) {
    const all = await prisma.aiScoreEvent.findMany({ where: { stateId: state.id, leadCycle: state.leadCycle }, select: { signal: true, points: true } });
    // captureJavobAiLead also writes the lead id + summary into the contact memory.
    await captureJavobAiLead({
      conversationId: conversation.id,
      summary: result.lead.summary,
      flag: result.lead.flag,
      score: result.score,
      thresholds,
      signals: all,
      extracted: result.extracted,
      isTest: config.isTest,
    });
  }
  if (result.handoff.needed && result.handoff.reason) {
    await openHandoff(conversation.id, {
      reason: result.handoff.reason,
      score: result.score,
      thresholds,
      summary: result.lead?.summary ?? result.extracted.interest ?? result.extracted.product ?? null,
      alert: true,
    });
    await logEvent(workspaceId, conversation.id, "handoff_opened", { reason: result.handoff.reason, score: result.score });
  }
}

/** Send via Instagram and store it. Returns false when Meta refused the message. */
async function deliverReply(
  conversation: Conversation & { workspace: { id: string }; instagramAccount: InstagramAccount },
  token: string,
  reply: string,
  meta: JavobAiMessageMeta
): Promise<boolean> {
  const { instagramAccount: account } = conversation;
  try {
    const response = await sendDirectMessage(token, account.instagramId, conversation.igUserId, reply);
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
    return true;
  } catch (error) {
    if (error instanceof TokenExpiredError) await markTokenBroken(account.id, error.message);
    await logEvent(conversation.workspace.id, conversation.id, "send_failed", {
      message: error instanceof Error ? error.message : String(error),
      code: error instanceof MetaApiError ? error.code : null,
    });
    return false;
  }
}

// ─── Copilot drafts & manager replies (trust ladder) ─────────────────────────

export interface HumanSendResult {
  ok: boolean;
  error?: string;
}

async function loadSendable(workspaceId: string, conversationId: string) {
  const conversation = await prisma.conversation.findFirst({
    where: { id: conversationId, workspaceId },
    include: { instagramAccount: true, workspace: true },
  });
  if (!conversation) return { error: "Suhbat topilmadi" } as const;
  const last = conversation.lastCustomerMessageAt;
  if (!last || Date.now() - last.getTime() > DAY_MS - 60_000) return { error: "Instagram 24 soatlik oynasi yopilgan" } as const;
  const token = tokenOf(conversation.instagramAccount);
  if (!token) return { error: "Instagram ulanishi buzilgan" } as const;
  return { conversation, token } as const;
}

/**
 * A human approved a COPILOT draft (as is, or with `finalText`). Claimed
 * atomically, so two taps never send twice. Unchanged text is a judged match
 * at once; an edit goes to the judge like any operator reply.
 */
export async function sendJavobAiDraft(workspaceId: string, draftId: string, by: string, finalText?: string | null): Promise<HumanSendResult> {
  const draft = await prisma.aiDraft.findFirst({ where: { id: draftId, workspaceId } });
  if (!draft) return { ok: false, error: "Qoralama topilmadi" };
  const text = (finalText ?? draft.text).trim();
  if (!text) return { ok: false, error: "Matn bo'sh" };
  const edited = text !== draft.text.trim();
  const claimed = await prisma.aiDraft.updateMany({
    where: { id: draftId, status: "PENDING" },
    data: { status: edited ? "EDITED" : "SENT", finalText: text, decidedBy: by, decidedAt: new Date() },
  });
  if (claimed.count === 0) return { ok: false, error: "Qoralama allaqachon ko'rib chiqilgan" };
  // Someone already answered the customer after this draft was made (operator, another draft, the AI).
  const answered = await prisma.conversationMessage.findFirst({
    where: { conversationId: draft.conversationId, author: { not: "CUSTOMER" }, createdAt: { gt: draft.createdAt } },
    select: { id: true },
  });
  if (answered) {
    await prisma.aiDraft.update({ where: { id: draftId }, data: { status: "SUPERSEDED", error: "Suhbatda keyinroq javob yozilgan" } });
    return { ok: false, error: "Mijozga bu orada boshqa javob yozilgan — qoralama eskirdi" };
  }
  const target = await loadSendable(workspaceId, draft.conversationId);
  if ("error" in target) {
    await prisma.aiDraft.update({ where: { id: draftId }, data: { status: "FAILED", error: target.error } });
    return { ok: false, error: target.error };
  }
  const delivered = await deliverReply(target.conversation, target.token, text, { javobai: true, intent: draft.intent ?? undefined, draftId });
  if (!delivered) {
    await prisma.aiDraft.update({ where: { id: draftId }, data: { status: "FAILED", error: "Instagram xabarni qabul qilmadi" } });
    return { ok: false, error: "Instagram xabarni qabul qilmadi" };
  }
  await prisma.conversation.update({ where: { id: draft.conversationId }, data: { botMessageCount: { increment: 1 }, lastBotMessageAt: new Date() } });
  if (draft.shadowTurnId) {
    const now = new Date();
    await prisma.aiShadowTurn
      .update({
        where: { id: draft.shadowTurnId },
        data: {
          operatorReply: text,
          operatorRepliedAt: now,
          ...(edited ? {} : { judgeMatch: true, judgeScore: 1, critical: "none", judgeNotes: "Qoralama o'zgarishsiz yuborildi", judgedAt: now }),
        },
      })
      .catch(() => {});
  }
  await logEvent(workspaceId, draft.conversationId, "ladder_draft_sent", { draftId, edited, by });
  return { ok: true };
}

/**
 * A manager answered from Telegram: sent as the business (author OPERATOR,
 * so it pairs with the AI's silent draft) and the handoff counts as taken.
 */
export async function sendManagerReply(workspaceId: string, conversationId: string, text: string, by: string): Promise<HumanSendResult> {
  const body = text.trim();
  if (!body) return { ok: false, error: "Matn bo'sh" };
  const target = await loadSendable(workspaceId, conversationId);
  if ("error" in target) return { ok: false, error: target.error };
  const { conversation, token } = target;
  try {
    const response = await sendDirectMessage(token, conversation.instagramAccount.instagramId, conversation.igUserId, body.slice(0, 1000));
    await prisma.conversationMessage
      .create({ data: { conversationId, mid: response.message_id, author: "OPERATOR", text: body.slice(0, 1000) } })
      .catch(() => {});
  } catch (error) {
    if (error instanceof TokenExpiredError) await markTokenBroken(conversation.instagramAccount.id, error.message);
    return { ok: false, error: "Instagram xabarni qabul qilmadi" };
  }
  const state = await prisma.aiConversationState.findUnique({ where: { conversationId }, select: { handoffState: true } });
  if (state?.handoffState === "HANDOFF_PENDING") await acceptHandoff(conversationId, by);
  await logEvent(workspaceId, conversationId, "manager_reply_sent", { by });
  return { ok: true };
}

// ─── AI quick-reply action (Comment 2.0 → JavobAI) ────────────────────────────

export interface HandThreadInput {
  account: Pick<InstagramAccount, "id" | "workspaceId" | "instagramId">;
  igUserId: string;
  igUsername?: string | null;
  /** The tap's message id (idempotency of the inbound job and the stored message). */
  messageId: string;
  /** What the customer "said" by tapping (the chip's label). */
  text: string;
  context: { campaignName: string; executionId: string; quickReplyLabel: string; mainMessage?: string | null };
}

/**
 * A customer tapped a quick reply with action AI on a LIVE account: the
 * production conversation becomes a CAMPAIGN one, the campaign context is
 * kept for the prompt, a closed / pending handoff is reopened and JavobAI
 * answers the tap text through its normal inbound path. While an operator
 * holds the thread (accepted handoff or the production hard mute) the tap
 * changes nothing but the stored context: a chip must not cut a human off.
 */
export async function handJavobAiThread(input: HandThreadInput): Promise<void> {
  const conversation = await upsertConversation(input.account, input.igUserId);
  await prisma.conversation.update({
    where: { id: conversation.id },
    data: { source: "CAMPAIGN", igUsername: conversation.igUsername ?? input.igUsername ?? null },
  });
  const state = await ensureAiState(conversation);
  await prisma.aiConversationState.update({
    where: { id: state.id },
    data: { context: { ...readContext(state.context), ...input.context, source: "trigger" } },
  });
  const operatorActive =
    state.handoffState === "OPERATOR_ACTIVE" || Boolean(conversation.operatorActiveUntil && conversation.operatorActiveUntil > new Date());
  if (operatorActive) {
    await logEvent(input.account.workspaceId, conversation.id, "ai_action_operator_active", {
      executionId: input.context.executionId,
      handoffState: state.handoffState,
    });
    return;
  }
  if (state.handoffState !== "AI_ACTIVE") await reopenAi(conversation.id);
  await enqueueJavobAiInbound({
    instagramAccountId: input.account.instagramId,
    senderId: input.igUserId,
    messageId: input.messageId,
    text: input.text,
    hasAttachment: false,
    shadow: false,
    source: "trigger",
  });
}

// ─── Maintenance ──────────────────────────────────────────────────────────────

/** Every minute from the worker: inactivity auto-close of accepted handoffs, budget alerts (4.4). */
export async function runJavobAiMaintenance(): Promise<void> {
  try {
    const closed = await autoCloseInactiveHandoffs();
    if (closed > 0) console.log(`[JavobAI] auto-closed ${closed} inactive handoff(s)`);
  } catch (error) {
    console.error("[JavobAI] maintenance failed:", error instanceof Error ? error.message : error);
  }
  try {
    await runLadderMaintenance();
  } catch (error) {
    console.error("[JavobAI] ladder maintenance failed:", error instanceof Error ? error.message : error);
  }
  try {
    const escalated = await escalatePendingHandoffs();
    if (escalated > 0) console.log(`[JavobAI] escalated ${escalated} unanswered handoff(s)`);
  } catch (error) {
    console.error("[JavobAI] escalation failed:", error instanceof Error ? error.message : error);
  }
  try {
    const alerts = await runBudgetAlerts();
    if (alerts.alerted || alerts.reset || alerts.failed) console.log("[JavobAI] budget alerts:", JSON.stringify(alerts));
  } catch (error) {
    console.error("[JavobAI] budget alerts failed:", error instanceof Error ? error.message : error);
  }
}

/**
 * Trust ladder upkeep, at most every 5 minutes across workers: pair operator
 * replies, judge them (cheap model, tooling usage), expire stale drafts, pull
 * AUTO intents back on expired facts / complaints.
 */
export async function runLadderMaintenance(now = new Date()): Promise<void> {
  const tick = await getRedisConnection().set("javobai:ladder:tick", "1", "EX", 290, "NX").catch(() => "OK");
  if (tick !== "OK") return;
  const { pairOperatorReplies, expireStaleDrafts, runLadderChecks } = await import("./ladder-service");
  const { runLadderJudge } = await import("./judge");
  const paired = await pairOperatorReplies(now);
  const judged = await runLadderJudge(25, now);
  const expired = await expireStaleDrafts(now);
  const checks = await runLadderChecks(now);
  if (paired || judged.judged || judged.demoted || judged.facts || expired || checks.demoted) {
    console.log("[JavobAI] ladder:", JSON.stringify({ paired, ...judged, expired, demotedByChecks: checks.demoted }));
  }
}
