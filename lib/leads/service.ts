import { randomUUID } from "node:crypto";
import type { Lead } from "@/app/generated/prisma/client";
import { prisma } from "@/lib/db/client";
import { maskPhone } from "@/lib/integrations/crypto";
import { enqueueDelivery, enqueueNotify } from "@/lib/queue/assistant-queue";
import { enqueueLeadDeliveries } from "./delivery";
import { buildTranscript } from "./transcript";

export const REPEAT_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

export interface Collected {
  name?: string | null;
  phone_e164?: string | null;
  phone_raw?: string | null;
  product_interest?: string | null;
  extra_field?: string | null;
  language?: string | null;
}

export function readCollected(value: unknown): Collected {
  return value && typeof value === "object" ? (value as Collected) : {};
}

/**
 * Same phone within 30 days in the same workspace = repeat inquiry (TZ 7.4):
 * a new lead row is kept for the record, but CRMs get a note on the original
 * and Telegram gets a "🔁 Takroriy murojaat" message.
 */
export async function findOriginalLead(
  workspaceId: string,
  phoneE164: string,
  now = new Date()
): Promise<Lead | null> {
  return prisma.lead.findFirst({
    where: {
      workspaceId,
      phoneE164,
      isTest: false,
      isRepeat: false,
      createdAt: { gte: new Date(now.getTime() - REPEAT_WINDOW_MS) },
    },
    orderBy: { createdAt: "asc" },
  });
}

export interface CreateLeadOptions {
  /** "complaint" -> 🔴, "no_phone" -> 🟡 */
  flag?: "complaint" | "no_phone" | null;
  summary?: string | null;
}

/**
 * Create the single lead of a conversation (idempotent) and queue deliveries.
 * Called when the assistant reaches CAPTURED / FALLBACK, or when a customer
 * replies to a campaign DM with a phone number and no assistant is active.
 */
export async function createLeadForConversation(
  conversationId: string,
  options: CreateLeadOptions = {}
): Promise<Lead | null> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    include: {
      instagramAccount: { select: { username: true } },
      messages: { orderBy: { createdAt: "asc" }, take: 200 },
    },
  });
  if (!conversation) return null;

  const idempotencyKey = `${conversation.id}:${conversation.leadCycle}`;
  const existing = await prisma.lead.findUnique({ where: { idempotencyKey } });
  if (existing) return existing;

  const collected = readCollected(conversation.collected);
  const phone = collected.phone_e164 ?? null;

  let campaignName: string | null = null;
  let postUrl: string | null = null;
  let triggerKeyword: string | null = null;
  if (conversation.campaignId) {
    const campaign = await prisma.automation.findUnique({
      where: { id: conversation.campaignId },
      select: { name: true, postUrl: true },
    });
    campaignName = campaign?.name ?? null;
    postUrl = campaign?.postUrl ?? null;
    const log = await prisma.dmLog.findFirst({
      where: {
        automationId: conversation.campaignId,
        commenterId: conversation.igUserId,
      },
      orderBy: { createdAt: "desc" },
      select: { matchedKeyword: true },
    });
    triggerKeyword = log?.matchedKeyword ?? null;
  }

  const original = phone ? await findOriginalLead(conversation.workspaceId, phone) : null;
  const name = collected.name ?? conversation.igName ?? null;
  const source = conversation.campaignId ? "CAMPAIGN" : conversation.source;

  const transcript = buildTranscript(
    {
      name,
      igUsername: conversation.igUsername,
      phoneE164: phone,
      productInterest: collected.product_interest ?? null,
      campaignName,
      triggerKeyword,
      postUrl,
      source,
      summary: options.summary ?? null,
    },
    conversation.messages.map((m) => ({
      author: m.author,
      text: m.text,
      createdAt: m.createdAt,
    }))
  );

  const clicked = conversation.campaignId
    ? (await prisma.linkClick.count({
        where: { automationId: conversation.campaignId, instagramAccountId: conversation.instagramAccountId },
      })) > 0
    : false;

  let lead: Lead;
  try {
    lead = await prisma.lead.create({
      data: {
        workspaceId: conversation.workspaceId,
        instagramAccountId: conversation.instagramAccountId,
        conversationId: conversation.id,
        idempotencyKey,
        igUserId: conversation.igUserId,
        igUsername: conversation.igUsername,
        name,
        phoneE164: phone,
        phoneRaw: collected.phone_raw ?? null,
        productInterest: collected.product_interest ?? null,
        extraField: collected.extra_field ?? null,
        language: collected.language ?? null,
        source,
        campaignId: conversation.campaignId,
        campaignName,
        triggerKeyword,
        postUrl,
        summary: options.summary ?? null,
        transcript,
        flag: options.flag ?? (phone ? null : "no_phone"),
        isRepeat: Boolean(original),
        repeatOfId: original?.id ?? null,
        trackedLinkClicked: clicked,
      },
    });
  } catch (error) {
    // Two workers racing on the same conversation: the unique key makes the
    // loser a no-op rather than a duplicate lead.
    const raced = await prisma.lead.findUnique({ where: { idempotencyKey } });
    if (raced) return raced;
    throw error;
  }

  if (original) {
    await prisma.lead.update({
      where: { id: original.id },
      data: { repeatCount: { increment: 1 } },
    });
  }

  await enqueueLeadDeliveries(lead, original ? "repeat" : "new");
  console.log(
    `[Leads] lead ${lead.id} created for ${conversation.instagramAccountId} phone=${maskPhone(phone)} repeat=${Boolean(original)}`
  );
  return lead;
}

/** A synthetic [TEST] lead sent to exactly one integration. */
export async function sendTestLead(integrationId: string): Promise<string | null> {
  const integration = await prisma.integration.findUnique({ where: { id: integrationId } });
  if (!integration) return null;
  const account = await prisma.instagramAccount.findFirst({
    where: {
      workspaceId: integration.workspaceId,
      ...(integration.igAccountFilter.length ? { id: { in: integration.igAccountFilter } } : {}),
    },
    select: { id: true, username: true },
  });
  if (!account) throw new Error("Avval Instagram akkauntni ulang");

  const summary = "Bu sinov lidi — haqiqiy mijoz emas.";
  const lead = await prisma.lead.create({
    data: {
      workspaceId: integration.workspaceId,
      instagramAccountId: account.id,
      idempotencyKey: `test:${randomUUID()}`,
      igUserId: "test",
      igUsername: "test_user",
      name: "[TEST] Sinov",
      phoneE164: "+998901234567",
      productInterest: "sinov mahsulot",
      source: "INBOUND_DM",
      summary,
      isTest: true,
      transcript: buildTranscript(
        {
          name: "[TEST] Sinov",
          igUsername: "test_user",
          phoneE164: "+998901234567",
          productInterest: "sinov mahsulot",
          source: "INBOUND_DM",
          summary,
          isTest: true,
        },
        [
          { author: "CUSTOMER", text: "Salom, bu sinov xabari", createdAt: new Date() },
          { author: "ASSISTANT", text: "Assalomu alaykum!", createdAt: new Date() },
        ]
      ),
    },
  });

  const delivery = await prisma.leadDelivery.create({
    data: { leadId: lead.id, integrationId, kind: "new", nextAttemptAt: new Date() },
  });
  await enqueueDelivery(delivery.id);
  return lead.id;
}

/** "Mijoz yana yozdi" — at most one notification per 5 minutes per conversation. */
export async function notifyCustomerWroteAgain(conversationId: string): Promise<void> {
  const conversation = await prisma.conversation.findUnique({
    where: { id: conversationId },
    select: { lastNotifiedAt: true },
  });
  if (!conversation) return;
  const now = Date.now();
  if (conversation.lastNotifiedAt && now - conversation.lastNotifiedAt.getTime() < 5 * 60_000) {
    return;
  }
  await prisma.conversation.update({
    where: { id: conversationId },
    data: { lastNotifiedAt: new Date(now) },
  });
  await enqueueNotify({ kind: "customer_wrote_again", conversationId });
}
