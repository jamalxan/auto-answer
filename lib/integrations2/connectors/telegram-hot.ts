/**
 * ETAP 8.1 — Telegram HOT card: a subscription on the workspace's TELEGRAM
 * integration (owner decision: the same chat as the lead card, enriched).
 * The subscription's filter decides which leads qualify (default for the
 * HOT preset: temperature HOT); `shouldSendHotCard` additionally requires a
 * HOT payload so a mis-configured filter can never spam cold leads.
 * The production lead card (lib/telegram/lead-message.ts) is untouched.
 */

import type { Integration } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { TelegramApiError } from "@/lib/telegram/api";
import { buildLeadKeyboard } from "@/lib/telegram/lead-message";
import { sendWithRetry } from "@/lib/telegram/notify";
import { maskSnippet } from "../events";
import { buildHotLeadText, shouldSendHotCard } from "./telegram-hot-text";
import type { ConnectionCheckResult, ConnectorResult, OutboundConnector, SendContext } from "./types";

export const HOT_EVENT_TYPES = ["lead.created", "lead.hot"] as const;

/** Synthetic test payloads carry sample ids; the "Bog'lanildi" button would point at nothing. */
const isSampleLead = (id: string | undefined) => !id || id.startsWith("lead_sample");

export const telegramHotConnector: OutboundConnector = {
  supports: (type) => (HOT_EVENT_TYPES as readonly string[]).includes(type),

  async send(context: SendContext): Promise<ConnectorResult> {
    const { payload, filter, integration } = context;
    if (!shouldSendHotCard(filter, payload)) {
      return { outcome: "skipped", note: "Lead HOT emas yoki obuna filtriga mos kelmaydi" };
    }
    const chats = await prisma.telegramChat.findMany({ where: { integrationId: integration.id, active: true } });
    if (chats.length === 0) return { outcome: "dead", note: "Telegram integratsiyasida faol chat yo'q" };

    const text = buildHotLeadText(payload);
    const lead = payload.lead;
    const keyboard =
      lead && !isSampleLead(lead.id)
        ? buildLeadKeyboard({ id: lead.id, conversationId: lead.conversation_id, contactedAt: null }, [])
        : undefined;

    const sent: Array<{ chatId: string; messageId: number }> = [];
    let lastError: unknown = null;
    for (const chat of chats) {
      try {
        const message = await sendWithRetry(chat.chatId, text, keyboard?.length ? { keyboard } : {});
        sent.push({ chatId: chat.chatId, messageId: message.message_id });
      } catch (error) {
        lastError = error;
        if (error instanceof TelegramApiError && error.isForbidden) {
          await prisma.telegramChat.update({ where: { id: chat.id }, data: { active: false } });
        }
      }
    }
    if (sent.length === 0) {
      return { outcome: "retry", note: `Telegram yuborilmadi: ${maskSnippet(lastError instanceof Error ? lastError.message : "xato", 150)}` };
    }
    return { outcome: "sent", externalId: JSON.stringify(sent), responseSnippet: `${sent.length} chat` };
  },

  async check(integration: Integration): Promise<ConnectionCheckResult> {
    const chats = await prisma.telegramChat.count({ where: { integrationId: integration.id, active: true } });
    return chats > 0 ? { ok: true } : { ok: false, reason: "error", message: "no_active_chats" };
  },
};
