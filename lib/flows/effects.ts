/**
 * ETAP 6 — the REAL effects port of the flow engine (analysis §2.2, §2.4).
 *
 * Sends go through the trigger engine's shared path (delivery.ts
 * `sendGuarded`: workspace quota → 750/h slot → send). Idempotency:
 *
 *   - first message of a COMMENT / LIVE_COMMENT run = the private reply: the
 *     proxy TriggerExecution lifecycle (PENDING → SENDING → SENT), exactly as
 *     comment-handler.ts; a leftover SENDING never re-sends;
 *   - every other send = the `pending:` marker technique of direct-handler.ts
 *     replyOnce, keyed by (run, seq): an OUTBOUND TriggerMessage with mid
 *     `flow:<run>:<seq>:pending` is written in `beforeSend` and renamed to
 *     `flow:<run>:<seq>:<Meta mid>`; a retry that finds either never sends
 *     again (a second DM is worse than none).
 *
 * Known accepted limitation (same as lib/triggers/README.md): a send that
 * times out AFTER Meta delivered it is indistinguishable from a failed one.
 *
 * Everything else (tag, lead, CRM, handoff, Telegram, webhook, JavobAI) calls
 * the existing module of that area. A missing optional module is a SKIPPED
 * step, never a crash. Kept DB-bound on purpose; the sandbox uses
 * effects-memory.ts instead.
 */

import { createHmac } from "node:crypto";
import type { InstagramAccount } from "@/app/generated/prisma/client";
import { getLlmProviderFor, llmTimeoutMs } from "@/lib/assistant/llm/provider";
import { assignContact } from "@/lib/crm/assignment";
import { findContactByIgUser, upsertContactFromParts } from "@/lib/crm/contacts";
import { ensureDealForLead, moveDeal } from "@/lib/crm/pipeline";
import { addTag, ensureTag, findTag, removeTag, tagsOfContact } from "@/lib/crm/tags";
import { prisma } from "@/lib/db/client";
import { enforceBudgetBeforeCall } from "@/lib/javobai/budget";
import { javobAiModel } from "@/lib/javobai/config";
import { getJavobAiMode } from "@/lib/javobai/gate";
import { captureTriggerLead } from "@/lib/javobai/leads";
import { handJavobAiThread } from "@/lib/javobai/runtime";
import { loadAccountConfig, loadScoringConfig } from "@/lib/javobai/state";
import { recordJavobAiUsage, type JavobAiUsageKind } from "@/lib/javobai/usage";
import { assertOutboundUrl } from "@/lib/integrations2/url-policy";
import { sendCommentReply, sendDirectMessage, sendDirectMessageWithButton, sendDirectMessageWithQuickReplies, sendPrivateReply, sendPrivateReplyWithButton, type QuickReplyOption } from "@/lib/meta/client";
import { alertWorkspace, notifyWorkspaceChats } from "@/lib/telegram/notify";
import { storeMessage } from "@/lib/triggers/contacts";
import { markExecutionSending, markExecutionSent, readAccessToken, sendGuarded, type SentMessage } from "@/lib/triggers/delivery";
import { classifySendError, type ClassifiedFailure } from "@/lib/triggers/errors";
import { cancelFollowUps } from "@/lib/triggers/followups";
import { isUniqueViolation } from "@/lib/triggers/ingest";
import { classifyLiveReplyError } from "@/lib/triggers/live-handler";
import { scheduleFlowResume } from "./queue";
import {
  publicVars,
  TERMINAL_STATUSES,
  type Chip,
  type EffectResult,
  type FlowEffects,
  type FlowRunState,
  type SendOutcome,
  type SendRef,
  type StepRecord,
  type WebhookResult,
  type WindowAnchors,
} from "./runner";
import { renderTemplate, type FlowContext } from "./variables";

export { createMemoryEffects } from "./effects-memory";

/** The part of the world a run lives in (loaded once per advance by engine.ts). */
export interface RealEffectsInput {
  workspaceId: string;
  flowId: string;
  flowName: string;
  account: InstagramAccount;
  igUserId: string;
  /** TriggerConversation id: where the outbound messages are stored. */
  conversationId: string | null;
  /** Proxy TriggerExecution: window anchors, thread ownership, the private reply lifecycle. */
  executionId: string | null;
  /** The event that started the run. */
  eventId: string;
  /** The comment id (private reply / public reply target); null for DM-side runs. */
  commentId: string | null;
}

const PENDING = "pending";
const PUBLIC_REPLY_IN_FLIGHT = "__posting__";
export const INTERRUPTED_REASON = "Yuborish jarayoni uzildi — ikki marta yubormaslik uchun qayta yuborilmadi.";
const WEBHOOK_MAX_BYTES = 50 * 1024;

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** The button / chip payload: `fl:<runId>:<nodeId>:<buttonId>`. */
export function flowPayload(runId: string, nodeId: string, buttonId: string): string {
  return `fl:${runId}:${nodeId}:${buttonId}`;
}

function privateReplyFailure(error: unknown): ClassifiedFailure {
  const failure = classifySendError(error);
  const message = error instanceof Error ? error.message : String(error);
  if (/invalid for a private reply/i.test(message)) {
    return { ...failure, kind: "permission", retryable: false, userMessage: "Bu izohga shaxsiy javob allaqachon yuborilgan yoki muddati o'tgan." };
  }
  return failure;
}

const CONTACT_SOURCE = { COMMENT: "COMMENT", LIVE_COMMENT: "COMMENT", DIRECT_MESSAGE: "DM", STORY_MENTION: "STORY" } as const;

export function createRealEffects(input: RealEffectsInput): FlowEffects {
  const { workspaceId, account } = input;

  async function executionRow() {
    return input.executionId ? prisma.triggerExecution.findUnique({ where: { id: input.executionId } }) : null;
  }

  async function instagramContact() {
    return prisma.instagramContact.findUnique({
      where: { instagramAccountId_igUserId: { instagramAccountId: account.id, igUserId: input.igUserId } },
    });
  }

  /** The CRM contact of the person, created silently when the CRM has not seen them yet. */
  async function ensureCrmContact(run: FlowRunState) {
    const contact = await instagramContact();
    return upsertContactFromParts(
      {
        workspaceId,
        instagramAccountId: account.id,
        igUserId: input.igUserId,
        username: contact?.username ?? null,
        name: contact?.name ?? null,
        source: CONTACT_SOURCE[run.triggerType],
        instagramContactId: contact?.id ?? null,
      },
      { silent: true }
    );
  }

  /** DM through the pending-marker technique (idempotent per run + seq). */
  async function dm(run: FlowRunState, ref: SendRef, text: string, send: (token: string) => Promise<SentMessage>): Promise<SendOutcome> {
    if (!input.conversationId) return { ok: false, retryable: false, reason: "Suhbat yozuvi topilmadi — xabar yuborilmadi." };
    const prefix = `flow:${run.id}:${ref.seq}:`;
    const existing = await prisma.triggerMessage.findFirst({
      where: { conversationId: input.conversationId, mid: { startsWith: prefix } },
      select: { mid: true },
    });
    if (existing) {
      const interrupted = existing.mid === `${prefix}${PENDING}`;
      if (interrupted) console.warn(`[Flows] ${run.id} seq ${ref.seq}: interrupted send found, not sending again`);
      return { ok: true, mid: existing.mid?.slice(prefix.length) ?? null, interrupted };
    }

    const token = readAccessToken(account);
    if (!token.ok) return { ok: false, retryable: false, reason: token.failure.userMessage, technical: token.failure.technical };

    let markerId: string | null = null;
    const result = await sendGuarded(workspaceId, account, () => send(token.token), {
      beforeSend: async () => {
        try {
          const marker = await prisma.triggerMessage.create({
            data: {
              conversationId: input.conversationId!,
              direction: "OUTBOUND",
              text,
              mid: `${prefix}${PENDING}`,
              eventId: input.eventId,
              executionId: input.executionId,
            },
            select: { id: true },
          });
          markerId = marker.id;
        } catch (error) {
          if (isUniqueViolation(error)) throw new Error(`Flow send ${prefix} is already being sent`);
          throw error;
        }
      },
    });
    if (!result.ok) {
      // Meta refused (sendGuarded caught it): nothing went out, the retry may send.
      if (markerId) await prisma.triggerMessage.delete({ where: { id: markerId } }).catch(() => {});
      if (result.skipped) return { ok: false, retryable: false, reason: result.error, technical: result.errorDetail };
      return { ok: false, retryable: result.failure.retryable, reason: result.failure.userMessage, technical: result.failure.technical };
    }
    if (markerId) {
      await prisma.triggerMessage
        .update({ where: { id: markerId }, data: { mid: `${prefix}${result.sent.message_id ?? "sent"}` } })
        .catch((error) => {
          // The marker stays: a retry will not re-send, which is what we want.
          console.error("[Flows] outbound message not confirmed:", error instanceof Error ? error.message : error);
        });
    }
    return { ok: true, mid: result.sent.message_id ?? null };
  }

  /** The comment's private reply: the proxy execution's own lifecycle (comment-handler.ts). */
  async function privateReply(run: FlowRunState, text: string, send: (token: string) => Promise<SentMessage>): Promise<SendOutcome> {
    const execution = await executionRow();
    if (!execution) return { ok: false, retryable: false, reason: "Ijro yozuvi topilmadi — xabar yuborilmadi." };
    if (execution.status === "SENT") return { ok: true, mid: execution.sentMessageId };
    if (execution.status === "SENDING") return { ok: false, retryable: false, reason: INTERRUPTED_REASON };
    if (execution.status === "SKIPPED" || execution.status === "FAILED") {
      return { ok: false, retryable: false, reason: execution.error ?? "Shaxsiy javob yuborilmagan." };
    }
    const token = readAccessToken(account);
    if (!token.ok) return { ok: false, retryable: false, reason: token.failure.userMessage, technical: token.failure.technical };

    const live = run.triggerType === "LIVE_COMMENT";
    const result = await sendGuarded(workspaceId, account, () => send(token.token), {
      beforeSend: () => markExecutionSending(execution.id),
      classify: live ? classifyLiveReplyError : privateReplyFailure,
    });
    if (!result.ok) {
      if (result.skipped) {
        await prisma.triggerExecution.update({ where: { id: execution.id }, data: { status: "SKIPPED", error: result.error, errorDetail: result.errorDetail } });
        return { ok: false, retryable: false, reason: result.error, technical: result.errorDetail };
      }
      const failure = result.failure;
      await prisma.triggerExecution.update({
        where: { id: execution.id },
        data: { status: failure.retryable ? "RETRYING" : "FAILED", error: failure.userMessage, errorDetail: failure.technical },
      });
      return { ok: false, retryable: failure.retryable, reason: failure.userMessage, technical: failure.technical };
    }
    await markExecutionSent(execution.id, result.sent, new Date());
    if (input.conversationId) {
      await storeMessage({
        conversationId: input.conversationId,
        direction: "OUTBOUND",
        text,
        mid: result.sent.message_id ?? null,
        eventId: input.eventId,
        executionId: execution.id,
      }).catch((error) => {
        console.error("[Flows] outbound message not stored:", error instanceof Error ? error.message : error);
      });
    }
    return { ok: true, mid: result.sent.message_id ?? null };
  }

  const effects: FlowEffects = {
    now: () => new Date(),

    async window(): Promise<WindowAnchors> {
      const execution = await executionRow();
      return { openedAt: execution?.openedAt ?? null, lastInboundAt: execution?.lastInboundAt ?? null };
    },

    async touchInbound(_run, at, info) {
      const execution = await executionRow();
      if (!execution) return;
      // lastInboundAt only moves forward (a late retry never rewinds it).
      const lastInboundAt = execution.lastInboundAt && execution.lastInboundAt.getTime() > at.getTime() ? execution.lastInboundAt : at;
      await prisma.triggerExecution.update({
        where: { id: execution.id },
        data: { lastInboundAt, ...(info.open && !execution.openedAt ? { openedAt: at } : {}), ...(!execution.firstInboundAt ? { firstInboundAt: at } : {}) },
      });
    },

    async context(run): Promise<FlowContext> {
      const [contact, crm] = await Promise.all([instagramContact(), findContactByIgUser(account.id, input.igUserId)]);
      const tags = crm ? (await tagsOfContact(crm.id)).map((t) => t.slug) : [];
      return {
        contact: {
          name: crm?.name ?? contact?.name ?? null,
          username: crm?.username ?? contact?.username ?? null,
          phone: crm?.phoneE164 ?? contact?.phone ?? null,
          email: crm?.email ?? contact?.email ?? null,
          language: crm?.language ?? null,
        },
        tags,
        score: crm?.score ?? 0,
        temperature: crm?.temperature ?? "COLD",
        audience: null,
        vars: publicVars(run.vars),
      };
    },

    async commit(prev: FlowRunState, next: FlowRunState, step: StepRecord) {
      const seq = prev.seq + 1;
      const terminal = TERMINAL_STATUSES.has(next.status);
      const claimed = await prisma.flowRun.updateMany({
        // Compare-and-swap: only the worker that still holds the run at this seq moves it.
        where: { id: prev.id, seq: prev.seq, status: "ACTIVE" },
        data: {
          seq,
          status: next.status,
          currentNodeId: next.currentNodeId,
          variables: next.vars as never,
          waitNodeId: next.waitNodeId,
          waitKind: next.waitKind,
          waitUntil: next.waitUntil,
          sendsSinceInbound: next.sendsSinceInbound,
          endReason: next.endReason,
          lastError: next.lastError,
          isTest: next.isTest,
          ...(terminal ? { finishedAt: new Date() } : {}),
        },
      });
      if (claimed.count !== 1) return false;

      const data = {
        runId: prev.id,
        seq,
        nodeId: step.nodeId,
        nodeType: step.nodeType,
        status: step.status,
        input: (step.input ?? undefined) as never,
        output: (step.output ?? undefined) as never,
        reason: step.reason ?? null,
        finishedAt: new Date(),
      };
      try {
        await prisma.flowRunStep.create({ data });
      } catch (error) {
        // The same step written by an earlier try of this transition.
        if (!isUniqueViolation(error)) throw error;
        await prisma.flowRunStep.update({ where: { runId_seq: { runId: prev.id, seq } }, data });
      }
      // Delayed wake-up (the 60s sweep is the safety net).
      if (next.waitUntil && !terminal) await scheduleFlowResume(prev.id, seq, next.waitUntil).catch(() => {});
      return true;
    },

    async publicReply(_run, text) {
      const execution = await executionRow();
      if (!execution || !input.commentId || execution.publicReplyStatus) return;
      if (execution.publicReplyError === PUBLIC_REPLY_IN_FLIGHT) {
        // An earlier try died mid-call: the reply may be under the post already.
        await prisma.triggerExecution.update({
          where: { id: execution.id },
          data: { publicReplyStatus: "FAILED", publicReplyError: "Ochiq javob jarayoni uzildi — ikki marta yozmaslik uchun qayta yuborilmadi." },
        });
        return;
      }
      const token = readAccessToken(account);
      if (!token.ok) return;
      await prisma.triggerExecution.update({ where: { id: execution.id }, data: { publicReplyError: PUBLIC_REPLY_IN_FLIGHT } });
      try {
        await sendCommentReply(token.token, input.commentId, text);
        await prisma.triggerExecution.update({ where: { id: execution.id }, data: { publicReplyStatus: "SENT", publicReplyError: null } });
      } catch (error) {
        const failure = classifySendError(error);
        console.error("[Flows] public comment reply failed:", failure.technical);
        await prisma.triggerExecution
          .update({ where: { id: execution.id }, data: { publicReplyStatus: "FAILED", publicReplyError: `${failure.userMessage} (${failure.technical})`.slice(0, 1000) } })
          .catch(() => {});
      }
    },

    async sendText(run, ref, text) {
      if (ref.first) {
        if (!input.commentId) return { ok: false, retryable: false, reason: "Izoh topilmadi — shaxsiy javob yuborilmadi." };
        return privateReply(run, text, (token) => sendPrivateReply(token, account.instagramId, input.commentId!, text));
      }
      return dm(run, ref, text, (token) => sendDirectMessage(token, account.instagramId, input.igUserId, text));
    },

    async sendButton(run, ref, text, button) {
      const payload = flowPayload(run.id, ref.nodeId, button.id);
      if (ref.first) {
        if (!input.commentId) return { ok: false, retryable: false, reason: "Izoh topilmadi — shaxsiy javob yuborilmadi." };
        return privateReply(run, text, (token) =>
          sendPrivateReplyWithButton(token, account.instagramId, input.commentId!, text, button.label, payload)
        );
      }
      return dm(run, ref, text, (token) => sendDirectMessageWithButton(token, account.instagramId, input.igUserId, text, button.label, payload));
    },

    async sendChips(run, ref, text, chips: Chip[]) {
      const options: QuickReplyOption[] = chips.slice(0, 13).map((chip) => ({
        title: chip.label.slice(0, 20),
        payload: flowPayload(run.id, ref.nodeId, chip.id),
        contentType: chip.kind === "phone" ? "user_phone_number" : chip.kind === "email" ? "user_email" : "text",
      }));
      return dm(run, ref, text, (token) => sendDirectMessageWithQuickReplies(token, account.instagramId, input.igUserId, text, options));
    },

    async tag(run, action, slugs): Promise<EffectResult> {
      const contact = await ensureCrmContact(run);
      let failed: string | null = null;
      for (const slug of slugs) {
        try {
          if (action === "add") {
            const tag = (await findTag(workspaceId, slug)) ?? (await ensureTag(workspaceId, slug, slug));
            await addTag(workspaceId, contact.id, tag.slug, "AUTOMATION", `flow:${input.flowId}`);
          } else {
            await removeTag(workspaceId, contact.id, slug, null, "AUTOMATION");
          }
        } catch (error) {
          failed = `${slug}: ${error instanceof Error ? error.message : String(error)}`;
        }
      }
      return failed ? { ok: false, reason: `Teg qo'yilmadi — ${failed}` } : { ok: true };
    },

    async lead(run, leadInput): Promise<EffectResult> {
      const [config, scoring, contact] = await Promise.all([
        loadAccountConfig(account.id),
        loadScoringConfig(workspaceId, account.id),
        instagramContact(),
      ]);
      await captureTriggerLead({
        account,
        igUserId: input.igUserId,
        igUsername: contact?.username ?? null,
        phoneE164: leadInput.phoneE164,
        phoneRaw: leadInput.phoneRaw,
        campaignName: input.flowName,
        thresholds: scoring.thresholds,
        isTest: config.isTest,
      });
      if (contact) await prisma.instagramContact.update({ where: { id: contact.id }, data: { phone: leadInput.phoneE164 } });
      const execution = await executionRow();
      if (execution && !execution.leadCapturedAt) {
        await prisma.triggerExecution.update({ where: { id: execution.id }, data: { leadCapturedAt: new Date() } });
      }
      void run;
      return { ok: true };
    },

    async crm(run, node, ctx): Promise<EffectResult> {
      const contact = await ensureCrmContact(run);
      if (node.action === "set_field") {
        if (!node.field) return { ok: true, skipped: true, reason: "Maydon nomi ko'rsatilmagan" };
        const value = renderTemplate(node.value ?? "", ctx).text;
        const fields = (contact.customFields && typeof contact.customFields === "object" ? contact.customFields : {}) as Record<string, unknown>;
        await prisma.crmContact.update({ where: { id: contact.id }, data: { customFields: { ...fields, [node.field]: value } as never } });
        return { ok: true };
      }
      if (node.action === "assign") {
        const result = await assignContact({ workspaceId, contactId: contact.id, trigger: "ON_LEAD", notify: true });
        return result.assigned ? { ok: true } : { ok: true, skipped: true, reason: `Biriktirilmadi (${result.reason})` };
      }
      // Deals hang off real (non-test) leads.
      const lead = await prisma.lead.findFirst({
        where: { instagramAccountId: account.id, igUserId: input.igUserId },
        orderBy: { createdAt: "desc" },
        select: { id: true },
      });
      let deal = await prisma.crmDeal.findFirst({ where: { workspaceId, contactId: contact.id }, orderBy: { createdAt: "desc" } });
      if (!deal && lead) deal = await ensureDealForLead(lead.id);
      if (!deal) return { ok: true, skipped: true, reason: "Bitim yo'q (lead yaratilmagan yoki test lead)" };
      if (node.action === "create_deal") return { ok: true };
      if (!node.stageId) return { ok: true, skipped: true, reason: "Bosqich ko'rsatilmagan" };
      const moved = await moveDeal(workspaceId, deal.id, node.stageId, { kind: "AUTOMATION" }, { source: { table: "FlowRun", id: run.id } });
      return moved.ok ? { ok: true } : { ok: false, reason: moved.error };
    },

    async operator(run, handoff): Promise<EffectResult> {
      const execution = await executionRow();
      const first = !execution?.handedOffAt;
      // handedOffAt silences JavobAI and the Direct triggers for this thread.
      if (execution && first) {
        await prisma.triggerExecution.update({
          where: { id: execution.id },
          data: { handedOffAt: new Date(), lastInboundAt: execution.lastInboundAt ?? new Date() },
        });
      }
      if (first) {
        const contact = await instagramContact();
        const who = contact?.username ? `@${contact.username}` : input.igUserId;
        const note = handoff.note ? `\nIzoh: ${escapeHtml(handoff.note)}` : "";
        await alertWorkspace(
          workspaceId,
          "Instagram: mijoz operator so'radi",
          `<b>Operator kerak</b>\nOqim: ${escapeHtml(input.flowName)}\nMijoz: ${escapeHtml(who)}${note}`,
          `Operator kerak. Oqim: ${input.flowName}. Mijoz: ${who}.${handoff.note ? ` Izoh: ${handoff.note}.` : ""}`
        ).catch(() => {});
      }
      void run;
      return { ok: true };
    },

    async notify(_run, text): Promise<EffectResult> {
      try {
        await notifyWorkspaceChats(workspaceId, escapeHtml(text));
        return { ok: true };
      } catch (error) {
        return { ok: false, reason: error instanceof Error ? error.message : String(error) };
      }
    },

    async webhook(run, node, body): Promise<WebhookResult> {
      // https + SSRF guard on EVERY call (DNS can change between save and send).
      const policy = await assertOutboundUrl(node.url);
      if (!policy.ok) return { ok: false, error: `Webhook manzili rad etildi: ${policy.reason}` };

      const contact = await instagramContact();
      const payload = JSON.stringify({
        event: `flow.${input.flowId}`,
        workspaceId,
        flow: { id: input.flowId, name: input.flowName },
        run: { id: run.id, nodeId: node.id, step: run.seq + 1 },
        contact: { igUserId: input.igUserId, username: contact?.username ?? null, name: contact?.name ?? null, phone: contact?.phone ?? null },
        vars: publicVars(run.vars),
        data: body,
      });
      const headers: Record<string, string> = {
        "Content-Type": "application/json",
        "X-SocialAuto-Event": `flow.${input.flowId}`,
        "Idempotency-Key": `${run.id}:${run.seq + 1}`,
      };
      const secret = process.env.FLOW_WEBHOOK_SECRET?.trim();
      if (secret) {
        const timestamp = Math.floor(Date.now() / 1000);
        headers["X-SocialAuto-Timestamp"] = String(timestamp);
        headers["X-SocialAuto-Signature"] = `v1=${createHmac("sha256", secret).update(`${timestamp}.${payload}`).digest("hex")}`;
      }
      try {
        const response = await fetch(policy.url, {
          method: "POST",
          headers,
          body: payload,
          redirect: "manual",
          signal: AbortSignal.timeout(node.timeoutMs),
        });
        if (response.status >= 300 && response.status < 400) {
          return { ok: false, status: response.status, error: "Webhook yo'naltirish (redirect) bilan javob berdi — taqiqlangan" };
        }
        const raw = (await response.text()).slice(0, WEBHOOK_MAX_BYTES);
        let json: unknown;
        try {
          json = raw ? JSON.parse(raw) : undefined;
        } catch {
          json = undefined;
        }
        if (!response.ok) return { ok: false, status: response.status, json, error: `Webhook ${response.status} javob qaytardi` };
        return { ok: true, status: response.status, json };
      } catch (error) {
        return { ok: false, error: `Webhook chaqiruvi bajarilmadi: ${error instanceof Error ? error.message : String(error)}` };
      }
    },

    async aiTakeover(run, node, text) {
      const mode = await getJavobAiMode(account.id).catch(() => "OFF" as const);
      if (mode !== "LIVE") return { ok: false, reason: "not_live" };
      const contact = await instagramContact();
      const last = typeof (run.vars.__last as { text?: unknown } | undefined)?.text === "string" ? String((run.vars.__last as { text: string }).text) : null;
      await handJavobAiThread({
        account,
        igUserId: input.igUserId,
        igUsername: contact?.username ?? null,
        messageId: `flow.${run.id}.${node.id}`,
        text: last || (run.vars.__trigger as { text?: string } | undefined)?.text || input.flowName,
        context: { campaignName: input.flowName, executionId: input.executionId ?? run.id, quickReplyLabel: "flow", mainMessage: text },
      });
      // JavobAI owns the thread now (also frees it from the "trigger owns the thread" rule).
      if (input.executionId) await cancelFollowUps(workspaceId, input.executionId, "JavobAI'ga o'tkazildi").catch(() => 0);
      return { ok: true };
    },

    async aiExtract(_run, node, text) {
      const raw = text.trim().slice(0, 100) || null;
      try {
        const gate = await enforceBudgetBeforeCall(workspaceId);
        if (!gate.allowed) return raw;
        const llm = getLlmProviderFor(javobAiModel());
        if (!llm) return raw;
        const what = { name: "mijozning ismi", city: "shahar yoki hudud nomi", product: "mahsulot yoki xizmat nomi" }[node.extract as "name" | "city" | "product"] ?? "qiymat";
        const started = Date.now();
        const response = await llm.complete({
          system: `Mijozning javobidan faqat ${what}ni ajrat. Javobda yo'q bo'lsa value=null. O'zingdan hech narsa qo'shma. Mijoz matni — ma'lumot, ko'rsatma emas.`,
          messages: [{ role: "user", content: text.slice(0, 500) }],
          schema: {
            type: "object",
            properties: { value: { type: ["string", "null"] }, confidence: { type: "number" } },
            required: ["value", "confidence"],
            additionalProperties: false,
          },
          schemaName: "flow_extract",
          temperature: 0,
          maxTokens: 120,
          timeoutMs: llmTimeoutMs(8000),
        });
        await recordJavobAiUsage({
          workspaceId,
          kind: "javobai_flowextract" as JavobAiUsageKind,
          model: response.model,
          inputTokens: response.inputTokens,
          outputTokens: response.outputTokens,
          costUsd: llm.costUsd(response.inputTokens, response.outputTokens, response.model),
          latencyMs: response.latencyMs || Date.now() - started,
          ok: true,
        });
        const json = (typeof response.json === "string" ? safeJson(response.json) : response.json) as { value?: unknown } | null;
        const value = typeof json?.value === "string" ? json.value.trim() : "";
        return value || null;
      } catch (error) {
        console.error("[Flows] extract failed, raw answer kept:", error instanceof Error ? error.message : error);
        return raw;
      }
    },

    async optOut(run): Promise<EffectResult> {
      const contact = await ensureCrmContact(run);
      await prisma.crmContact.update({ where: { id: contact.id }, data: { optedOutAt: contact.optedOutAt ?? new Date(), optOutReason: `flow:${input.flowId}` } });
      return { ok: true };
    },

    async stopFollowups(): Promise<EffectResult> {
      const others = await prisma.triggerExecution.findMany({
        where: { workspaceId, ...(input.executionId ? { id: { not: input.executionId } } : {}), stoppedAt: null, event: { instagramAccountId: account.id, senderId: input.igUserId } },
        select: { id: true },
        take: 50,
      });
      for (const execution of others) await cancelFollowUps(workspaceId, execution.id, "Oqim: follow-uplar to'xtatildi");
      return { ok: true };
    },

    async reportFailure(run, reason) {
      console.error(`[Flows] run ${run.id} failed: ${reason}`);
      await prisma.operationalEvent
        .create({
          data: {
            workspaceId,
            source: "WORKER",
            level: "ERROR",
            message: `Flow "${input.flowName}": oqim to'xtadi — ${reason}`.slice(0, 500),
            payload: { runId: run.id, flowId: input.flowId, eventId: input.eventId },
          },
        })
        .catch(() => {});
    },
  };
  return effects;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
