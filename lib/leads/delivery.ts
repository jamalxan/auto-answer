/**
 * Lead delivery pipeline: one `LeadDelivery` row per (lead, integration, kind).
 * Each runs independently, so a broken amoCRM never blocks Telegram.
 */

import type { Integration, Lead } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { decryptCredentials } from "@/lib/integrations/crypto";
import {
  IntegrationAuthError,
  nextRetryDelayMs,
} from "@/lib/integrations/errors";
import {
  AmoClient,
  LongLivedTokenStrategy,
  renderLeadName,
  type AmoConfig,
} from "@/lib/integrations/amocrm";
import { BitrixClient, type BitrixConfig } from "@/lib/integrations/bitrix24";
import { enqueueDelivery } from "@/lib/queue/assistant-queue";
import { TelegramApiError, editMessageReplyMarkup } from "@/lib/telegram/api";
import {
  buildLeadKeyboard,
  buildLeadText,
  type CrmLink,
} from "@/lib/telegram/lead-message";
import { alertWorkspace, sendWithRetry } from "@/lib/telegram/notify";

export type DeliveryKind = "new" | "repeat";

type LeadWithAccount = Lead & { instagramAccount: { username: string } };

// ─── Scheduling ────────────────────────────────────────────────────────────────

export function integrationAcceptsAccount(
  integration: Pick<Integration, "igAccountFilter">,
  instagramAccountId: string
): boolean {
  return (
    integration.igAccountFilter.length === 0 ||
    integration.igAccountFilter.includes(instagramAccountId)
  );
}

/**
 * Create the pending deliveries for a lead and queue them. Integrations that
 * are currently BROKEN get a PENDING row with no job: it is released
 * automatically once the integration is fixed (`resumeIntegration`).
 */
export async function enqueueLeadDeliveries(
  lead: Pick<Lead, "id" | "workspaceId" | "instagramAccountId">,
  kind: DeliveryKind
): Promise<void> {
  const integrations = await prisma.integration.findMany({
    where: { workspaceId: lead.workspaceId, status: { in: ["ACTIVE", "BROKEN"] } },
  });

  for (const integration of integrations) {
    if (!integrationAcceptsAccount(integration, lead.instagramAccountId)) continue;
    const active = integration.status === "ACTIVE";
    const delivery = await prisma.leadDelivery.upsert({
      where: {
        leadId_integrationId_kind: { leadId: lead.id, integrationId: integration.id, kind },
      },
      create: {
        leadId: lead.id,
        integrationId: integration.id,
        kind,
        status: "PENDING",
        nextAttemptAt: active ? new Date() : null,
      },
      update: {},
    });
    if (active && delivery.status === "PENDING") await enqueueDelivery(delivery.id);
  }
}

// ─── Per-provider senders ──────────────────────────────────────────────────────

interface SendResult {
  externalId: string | null;
  externalUrl: string | null;
}

async function loadLead(leadId: string): Promise<LeadWithAccount | null> {
  return prisma.lead.findUnique({
    where: { id: leadId },
    include: { instagramAccount: { select: { username: true } } },
  });
}

function leadMessageInput(lead: LeadWithAccount, extraFieldLabel: string | null) {
  return {
    id: lead.id,
    igAccountUsername: lead.instagramAccount.username,
    name: lead.name,
    igUsername: lead.igUsername,
    phoneE164: lead.phoneE164,
    productInterest: lead.productInterest,
    extraField: lead.extraField,
    extraFieldLabel,
    source: lead.source,
    campaignName: lead.campaignName,
    triggerKeyword: lead.triggerKeyword,
    summary: lead.summary,
    flag: lead.flag,
    isTest: lead.isTest,
    isRepeat: lead.isRepeat,
    conversationId: lead.conversationId,
    contactedAt: lead.contactedAt,
  };
}

/** CRM links already delivered for this lead (shown as Telegram buttons). */
async function crmLinksFor(leadId: string): Promise<CrmLink[]> {
  const deliveries = await prisma.leadDelivery.findMany({
    where: { leadId, status: "SENT", externalUrl: { not: null }, integration: { type: { in: ["AMOCRM", "BITRIX24"] } } },
    include: { integration: { select: { type: true } } },
  });
  return deliveries.map((d) => ({
    label: d.integration.type === "AMOCRM" ? "amoCRM" : "Bitrix24",
    url: d.externalUrl!,
  }));
}

async function sendToTelegram(
  integration: Integration,
  lead: LeadWithAccount
): Promise<SendResult> {
  const chats = await prisma.telegramChat.findMany({
    where: { integrationId: integration.id, active: true },
  });
  if (chats.length === 0) {
    throw new Error("Telegram integration has no active chats");
  }

  const profile = await prisma.assistantProfile.findFirst({
    where: { workspaceId: lead.workspaceId },
    select: { extraFieldLabel: true },
  });
  const text = buildLeadText(leadMessageInput(lead, profile?.extraFieldLabel ?? null));
  const keyboard = buildLeadKeyboard(lead, await crmLinksFor(lead.id));

  const sent: Array<{ chatId: string; messageId: number }> = [];
  let lastError: unknown = null;
  for (const chat of chats) {
    try {
      const message = await sendWithRetry(chat.chatId, text, { keyboard });
      sent.push({ chatId: chat.chatId, messageId: message.message_id });
    } catch (error) {
      lastError = error;
      if (error instanceof TelegramApiError && error.isForbidden) {
        await prisma.telegramChat.update({ where: { id: chat.id }, data: { active: false } });
      }
    }
  }
  if (sent.length === 0) throw lastError ?? new Error("Telegram delivery failed");
  return { externalId: JSON.stringify(sent), externalUrl: null };
}

function amoClientFor(integration: Integration) {
  const credentials = decryptCredentials<{ token: string }>(integration.credentialsEncrypted);
  const config = integration.config as unknown as AmoConfig;
  return {
    client: new AmoClient(config, new LongLivedTokenStrategy(credentials.token), integration.id),
    config,
  };
}

function bitrixClientFor(integration: Integration) {
  const credentials = decryptCredentials<{ webhookUrl: string }>(integration.credentialsEncrypted);
  return new BitrixClient(
    credentials.webhookUrl,
    integration.config as unknown as BitrixConfig,
    integration.id
  );
}

async function transcriptOf(lead: Lead): Promise<string> {
  return lead.transcript ?? "";
}

/** The CRM lead that the original (non-repeat) delivery created. */
async function originalExternalId(lead: Lead, integrationId: string): Promise<string | null> {
  if (!lead.repeatOfId) return null;
  const original = await prisma.leadDelivery.findFirst({
    where: { leadId: lead.repeatOfId, integrationId, status: "SENT", kind: "new" },
    select: { externalId: true },
  });
  return original?.externalId ?? null;
}

async function sendToAmo(
  integration: Integration,
  lead: LeadWithAccount,
  kind: DeliveryKind
): Promise<SendResult> {
  const { client, config } = amoClientFor(integration);
  const note = await transcriptOf(lead);

  if (kind === "repeat") {
    const existingId = await originalExternalId(lead, integration.id);
    if (existingId) {
      const leadId = Number(existingId);
      await client.addNote(leadId, `🔁 Takroriy murojaat\n${note}`);
      return {
        externalId: existingId,
        externalUrl: `https://${config.subdomain}.${config.zone}/leads/detail/${leadId}`,
      };
    }
  }

  const result = await client.deliverLead(
    {
      name: renderLeadName(config.leadNameTemplate, {
        name: lead.name,
        product_interest: lead.productInterest,
        username: lead.igUsername,
      }),
      phoneE164: lead.phoneE164,
      contactName: lead.name,
      igUsername: lead.igUsername,
      campaignName: lead.campaignName,
    },
    note
  );
  return { externalId: String(result.leadId), externalUrl: result.url };
}

async function sendToBitrix(
  integration: Integration,
  lead: LeadWithAccount,
  kind: DeliveryKind
): Promise<SendResult> {
  const client = bitrixClientFor(integration);
  const note = await transcriptOf(lead);

  if (kind === "repeat") {
    const existingId = await originalExternalId(lead, integration.id);
    if (existingId) {
      await client.addComment(Number(existingId), `🔁 Takroriy murojaat\n${note}`);
      return {
        externalId: existingId,
        externalUrl: `${new URL(client.webhookUrl).origin}/crm/lead/details/${existingId}/`,
      };
    }
  }

  const source = lead.source === "CAMPAIGN" && lead.campaignName
    ? `SocialAuto · Kampaniya: ${lead.campaignName}${lead.triggerKeyword ? ` · ${lead.triggerKeyword}` : ""}`
    : "SocialAuto · Instagram DM";

  const result = await client.deliverLead(
    {
      title: `Instagram: ${lead.name ?? "mijoz"}${lead.productInterest ? ` — ${lead.productInterest}` : ""}`,
      name: lead.name,
      phoneE164: lead.phoneE164,
      igUsername: lead.igUsername,
      sourceDescription: source,
      comments: lead.summary,
    },
    note
  );
  return { externalId: String(result.leadId), externalUrl: result.url };
}

// ─── Processing ────────────────────────────────────────────────────────────────

export async function markIntegrationBroken(integration: Integration, message: string) {
  if (integration.status === "BROKEN") return;
  await prisma.integration.update({
    where: { id: integration.id },
    data: { status: "BROKEN", lastError: message.slice(0, 500), lastCheckedAt: new Date() },
  });
  await prisma.operationalEvent.create({
    data: {
      workspaceId: integration.workspaceId,
      source: "SYSTEM",
      level: "ERROR",
      message: `${integration.name} integratsiyasi uzildi: ${message}`.slice(0, 500),
      payload: { integrationId: integration.id, type: integration.type },
    },
  });
  const label = integration.type === "AMOCRM" ? "amoCRM" : integration.type === "BITRIX24" ? "Bitrix24" : "Telegram";
  await alertWorkspace(
    integration.workspaceId,
    `${label} ulanishi uzildi`,
    `⚠️ <b>${label} ulanishi uzildi</b>\nQayta ulang — lidlar Telegram'ga yetkazilishda davom etadi, ${label}'ga esa ulanish tiklangach avtomatik yuboriladi.`,
    `${label} ulanishi uzildi. SocialAuto → Integratsiyalar bo'limida qayta ulang. Lidlar ulanish tiklangach avtomatik yuboriladi.`
  );
}

/** Recompute `lead.status` from its delivery rows. */
export async function refreshLeadStatus(leadId: string) {
  const deliveries = await prisma.leadDelivery.findMany({
    where: { leadId, kind: "new" },
    select: { status: true },
  });
  if (deliveries.length === 0) return;
  const sent = deliveries.filter((d) => d.status === "SENT").length;
  const dead = deliveries.filter((d) => d.status === "DEAD").length;
  const status =
    sent === deliveries.length
      ? "SENT"
      : sent > 0
        ? "PARTIAL"
        : dead === deliveries.length
          ? "FAILED"
          : "NEW";
  await prisma.lead.update({ where: { id: leadId }, data: { status } });
}

/** After a CRM delivery succeeded, add its link to the lead's Telegram messages. */
export async function refreshTelegramButtons(leadId: string) {
  const telegram = await prisma.leadDelivery.findMany({
    where: { leadId, status: "SENT", integration: { type: "TELEGRAM" } },
    select: { externalId: true },
  });
  if (telegram.length === 0) return;
  const lead = await prisma.lead.findUnique({ where: { id: leadId } });
  if (!lead) return;
  const keyboard = buildLeadKeyboard(lead, await crmLinksFor(leadId));

  for (const delivery of telegram) {
    let refs: Array<{ chatId: string; messageId: number }> = [];
    try {
      refs = JSON.parse(delivery.externalId ?? "[]");
    } catch {
      continue;
    }
    for (const ref of refs) {
      await editMessageReplyMarkup(ref.chatId, ref.messageId, keyboard).catch(() => {});
    }
  }
}

export async function processDelivery(deliveryId: string): Promise<void> {
  const delivery = await prisma.leadDelivery.findUnique({
    where: { id: deliveryId },
    include: { integration: true },
  });
  if (!delivery || delivery.status === "SENT" || delivery.status === "DEAD") return;

  const { integration } = delivery;
  if (integration.status !== "ACTIVE") {
    // Held until the integration is repaired.
    await prisma.leadDelivery.update({
      where: { id: delivery.id },
      data: { nextAttemptAt: null },
    });
    return;
  }

  const lead = await loadLead(delivery.leadId);
  if (!lead) return;
  const kind = delivery.kind as DeliveryKind;

  try {
    let result: SendResult;
    if (integration.type === "TELEGRAM") result = await sendToTelegram(integration, lead);
    else if (integration.type === "AMOCRM") result = await sendToAmo(integration, lead, kind);
    else result = await sendToBitrix(integration, lead, kind);

    await prisma.leadDelivery.update({
      where: { id: delivery.id },
      data: {
        status: "SENT",
        attempts: { increment: 1 },
        sentAt: new Date(),
        nextAttemptAt: null,
        lastError: null,
        externalId: result.externalId,
        externalUrl: result.externalUrl,
      },
    });
    if (integration.type !== "TELEGRAM") await refreshTelegramButtons(lead.id);
    await refreshLeadStatus(lead.id);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);

    if (error instanceof IntegrationAuthError) {
      // Credentials are dead: stop retrying, keep the delivery pending.
      await prisma.leadDelivery.update({
        where: { id: delivery.id },
        data: { lastError: message.slice(0, 500), nextAttemptAt: null },
      });
      await markIntegrationBroken(integration, message);
      return;
    }

    const attempts = delivery.attempts + 1;
    const delay = nextRetryDelayMs(attempts);
    if (delay === null) {
      await prisma.leadDelivery.update({
        where: { id: delivery.id },
        data: { status: "DEAD", attempts, lastError: message.slice(0, 500), nextAttemptAt: null },
      });
      await refreshLeadStatus(lead.id);
      await alertWorkspace(
        lead.workspaceId,
        "Lid yetkazilmadi",
        `❌ <b>Lid yetkazilmadi</b> (${integration.name})\n${lead.name ?? "—"} ${lead.phoneE164 ?? ""}\nLidlar sahifasida «Qayta yuborish» tugmasini bosing.`,
        `Lid ${integration.name} ga 5 urinishdan keyin ham yetkazilmadi. Lidlar sahifasida qayta yuboring.`
      );
      return;
    }

    const nextAttemptAt = new Date(Date.now() + delay);
    await prisma.leadDelivery.update({
      where: { id: delivery.id },
      data: { status: "FAILED", attempts, lastError: message.slice(0, 500), nextAttemptAt },
    });
    await enqueueDelivery(delivery.id, delay);
  }
}

/** Put every held delivery of a repaired integration back in the queue. */
export async function resumeIntegration(integrationId: string): Promise<number> {
  const held = await prisma.leadDelivery.findMany({
    where: { integrationId, status: { in: ["PENDING", "FAILED"] } },
    select: { id: true },
  });
  for (const { id } of held) {
    await prisma.leadDelivery.update({ where: { id }, data: { nextAttemptAt: new Date() } });
    await enqueueDelivery(id);
  }
  return held.length;
}

/**
 * Safety net run by the worker: anything due that has no live queue job (Redis
 * flushed, worker crashed between DB write and enqueue) is queued again.
 */
export async function sweepDueDeliveries(limit = 100): Promise<number> {
  const due = await prisma.leadDelivery.findMany({
    where: {
      status: { in: ["PENDING", "FAILED"] },
      nextAttemptAt: { lte: new Date(Date.now() - 60_000) },
      integration: { status: "ACTIVE" },
    },
    select: { id: true },
    take: limit,
  });
  for (const { id } of due) await enqueueDelivery(id);
  return due.length;
}

/** Manual "Qayta yuborish" from the leads page. */
export async function redeliverLead(leadId: string): Promise<number> {
  const deliveries = await prisma.leadDelivery.findMany({
    where: { leadId, status: { in: ["DEAD", "FAILED", "PENDING"] } },
    include: { integration: { select: { status: true } } },
  });
  let queued = 0;
  for (const d of deliveries) {
    if (d.integration.status !== "ACTIVE") continue;
    await prisma.leadDelivery.update({
      where: { id: d.id },
      data: { status: "PENDING", attempts: 0, nextAttemptAt: new Date() },
    });
    await enqueueDelivery(d.id);
    queued++;
  }
  return queued;
}
