/**
 * Data access for the dev UI / API: campaigns, logs, contacts, manual retry
 * and the dry-run simulator. Every query is scoped to one workspace.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { InstagramEventStatus, InstagramEventType, Prisma } from "@/app/generated/prisma/client";
import { forgetAccountGate } from "./ingest";
import { cleanKeywords, evaluateCampaign, selectCampaign, type CampaignVerdict } from "./matching";
import { enqueueEvent } from "./queue";

// Instagram rejects DM text over 1000 characters.
export const MAX_RESPONSE_LENGTH = 1000;

/** Trigger types the builder accepts today. Others join as their module ships. */
export const SUPPORTED_TRIGGERS = ["STORY_REPLY"] as const;

export const campaignInputSchema = z
  .object({
    name: z.string().trim().min(1, "Nom kiriting").max(120),
    instagramAccountId: z.string().min(1, "Instagram akkauntni tanlang"),
    triggerType: z.enum(SUPPORTED_TRIGGERS),
    storyScope: z.enum(["ALL", "SPECIFIC"]),
    storyIds: z.array(z.string().trim().min(1).max(64)).max(50).default([]),
    matchingMode: z.enum(["EVERY", "CONTAINS", "EXACT"]),
    keywords: z.array(z.string().max(100)).max(50).default([]),
    responseType: z.literal("SEND_MESSAGE").default("SEND_MESSAGE"),
    responseMessage: z
      .string()
      .trim()
      .min(1, "Javob matnini kiriting")
      .max(MAX_RESPONSE_LENGTH, `Javob ${MAX_RESPONSE_LENGTH} belgidan oshmasin`),
    active: z.boolean().default(true),
  })
  .transform((input) => ({
    ...input,
    keywords: input.matchingMode === "EVERY" ? [] : cleanKeywords(input.keywords),
    storyIds: input.storyScope === "ALL" ? [] : [...new Set(input.storyIds)],
  }))
  .superRefine((input, ctx) => {
    if (input.matchingMode !== "EVERY" && input.keywords.length === 0) {
      ctx.addIssue({ code: "custom", path: ["keywords"], message: "Kamida bitta kalit so'z kiriting" });
    }
    if (input.storyScope === "SPECIFIC" && input.storyIds.length === 0) {
      ctx.addIssue({ code: "custom", path: ["storyIds"], message: "Kamida bitta story tanlang" });
    }
  });

export type CampaignInput = z.infer<typeof campaignInputSchema>;

export function firstIssue(error: z.ZodError): string {
  return error.issues[0]?.message ?? "Noto'g'ri ma'lumot";
}

async function accountInWorkspace(workspaceId: string, accountId: string) {
  return prisma.instagramAccount.findFirst({
    where: { id: accountId, workspaceId },
    select: { id: true, instagramId: true, username: true },
  });
}

// ─── Campaigns ────────────────────────────────────────────────────────────────

export async function listCampaigns(workspaceId: string) {
  const campaigns = await prisma.triggerCampaign.findMany({
    where: { workspaceId },
    orderBy: { createdAt: "desc" },
    include: { instagramAccount: { select: { username: true } } },
  });
  if (campaigns.length === 0) return [];

  const grouped = await prisma.triggerExecution.groupBy({
    by: ["campaignId", "status"],
    where: { campaignId: { in: campaigns.map((c) => c.id) } },
    _count: { _all: true },
  });
  const stats = new Map<string, Record<string, number>>();
  for (const row of grouped) {
    const entry = stats.get(row.campaignId) ?? {};
    entry[row.status] = row._count._all;
    stats.set(row.campaignId, entry);
  }

  return campaigns.map((campaign) => ({
    ...campaign,
    stats: {
      sent: stats.get(campaign.id)?.SENT ?? 0,
      failed: stats.get(campaign.id)?.FAILED ?? 0,
      retrying: stats.get(campaign.id)?.RETRYING ?? 0,
    },
  }));
}

export async function getCampaign(workspaceId: string, id: string) {
  return prisma.triggerCampaign.findFirst({ where: { id, workspaceId } });
}

export async function createCampaign(workspaceId: string, input: CampaignInput) {
  const account = await accountInWorkspace(workspaceId, input.instagramAccountId);
  if (!account) return { ok: false as const, error: "Instagram akkaunt topilmadi" };
  const campaign = await prisma.triggerCampaign.create({ data: { ...input, workspaceId } });
  forgetAccountGate(account.instagramId);
  return { ok: true as const, campaign };
}

export async function updateCampaign(workspaceId: string, id: string, input: CampaignInput) {
  const existing = await getCampaign(workspaceId, id);
  if (!existing) return { ok: false as const, error: "Campaign topilmadi", status: 404 };
  const account = await accountInWorkspace(workspaceId, input.instagramAccountId);
  if (!account) return { ok: false as const, error: "Instagram akkaunt topilmadi", status: 400 };
  const campaign = await prisma.triggerCampaign.update({ where: { id }, data: input });
  forgetAccountGate();
  return { ok: true as const, campaign };
}

export async function setCampaignActive(workspaceId: string, id: string, active: boolean) {
  const result = await prisma.triggerCampaign.updateMany({ where: { id, workspaceId }, data: { active } });
  return result.count > 0;
}

export async function deleteCampaign(workspaceId: string, id: string) {
  const existing = await prisma.triggerCampaign.findFirst({
    where: { id, workspaceId },
    select: { instagramAccount: { select: { instagramId: true } } },
  });
  if (!existing) return false;
  await prisma.triggerCampaign.delete({ where: { id } });
  forgetAccountGate(existing.instagramAccount.instagramId);
  return true;
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

const EVENT_TYPES: InstagramEventType[] = [
  "STORY_REPLY",
  "STORY_MENTION",
  "DIRECT_MESSAGE",
  "LIVE_COMMENT",
  "STORY_REACTION",
  "COMMENT",
];
const EVENT_STATUSES: InstagramEventStatus[] = ["PENDING", "PROCESSING", "PROCESSED", "IGNORED", "RETRYING", "FAILED"];

export interface EventQuery {
  type?: string | null;
  status?: string | null;
  campaignId?: string | null;
  accountId?: string | null;
  q?: string | null;
  page?: number;
  limit?: number;
}

export async function listEvents(workspaceId: string, query: EventQuery) {
  const page = Math.max(1, query.page ?? 1);
  const limit = Math.min(100, Math.max(1, query.limit ?? 25));
  const where: Prisma.InstagramEventWhereInput = { workspaceId };

  if (query.type && EVENT_TYPES.includes(query.type as InstagramEventType)) {
    where.eventType = query.type as InstagramEventType;
  }
  if (query.status && EVENT_STATUSES.includes(query.status as InstagramEventStatus)) {
    where.processingStatus = query.status as InstagramEventStatus;
  }
  if (query.accountId) where.instagramAccountId = query.accountId;
  if (query.campaignId) where.executions = { some: { campaignId: query.campaignId } };
  if (query.q?.trim()) {
    const q = query.q.trim().replace(/^@/, "");
    where.OR = [
      { text: { contains: q, mode: "insensitive" } },
      { senderUsername: { contains: q, mode: "insensitive" } },
      { contact: { username: { contains: q, mode: "insensitive" } } },
      { senderId: q },
      { storyId: q },
    ];
  }

  const [total, events] = await Promise.all([
    prisma.instagramEvent.count({ where }),
    prisma.instagramEvent.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: (page - 1) * limit,
      take: limit,
      select: {
        id: true,
        eventType: true,
        senderId: true,
        senderUsername: true,
        messageId: true,
        storyId: true,
        storyUrl: true,
        text: true,
        timestamp: true,
        processingStatus: true,
        error: true,
        attempts: true,
        processedAt: true,
        createdAt: true,
        instagramAccount: { select: { username: true } },
        contact: { select: { id: true, username: true, name: true } },
        executions: {
          orderBy: { createdAt: "asc" },
          select: {
            id: true,
            status: true,
            matchedKeyword: true,
            error: true,
            attempts: true,
            nextRetryAt: true,
            sentAt: true,
            campaign: { select: { id: true, name: true } },
          },
        },
      },
    }),
  ]);

  return { events, pagination: { page, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

export async function getEventDetail(workspaceId: string, id: string) {
  const event = await prisma.instagramEvent.findFirst({
    where: { id, workspaceId },
    include: {
      instagramAccount: { select: { username: true, instagramId: true } },
      contact: true,
      executions: { include: { campaign: { select: { id: true, name: true } } }, orderBy: { createdAt: "asc" } },
    },
  });
  if (!event) return null;
  const messages = event.conversationId
    ? await prisma.triggerMessage.findMany({
        where: { conversationId: event.conversationId },
        orderBy: { createdAt: "desc" },
        take: 20,
      })
    : [];
  return { event, messages: messages.reverse() };
}

/**
 * Manual re-run from the logs, for FAILED and IGNORED events (e.g. after
 * fixing a token or adding a campaign). The admin decides here, so a SENDING
 * execution left by a crash is released too. A SENT execution is never reset:
 * the engine still refuses to send the same DM twice.
 */
export async function retryEvent(workspaceId: string, id: string) {
  const event = await prisma.instagramEvent.findFirst({
    where: { id, workspaceId },
    select: { id: true, processingStatus: true },
  });
  if (!event) return { ok: false as const, status: 404, error: "Event topilmadi" };
  if (event.processingStatus !== "FAILED" && event.processingStatus !== "IGNORED") {
    return { ok: false as const, status: 409, error: "Faqat xato yoki e'tiborsiz qolgan eventni qayta ishlash mumkin" };
  }

  await prisma.$transaction([
    prisma.triggerExecution.updateMany({
      where: { eventId: id, status: { in: ["FAILED", "SENDING", "RETRYING"] } },
      data: { status: "PENDING", error: null, errorDetail: null, nextRetryAt: null },
    }),
    prisma.instagramEvent.update({
      where: { id },
      data: {
        processingStatus: "PENDING",
        attempts: 0,
        error: null,
        errorDetail: null,
        processedAt: null,
        processingStartedAt: null,
      },
    }),
  ]);
  await enqueueEvent(id, { suffix: `manual${Date.now()}` });
  return { ok: true as const };
}

// ─── Contacts ─────────────────────────────────────────────────────────────────

export async function listContacts(workspaceId: string, page = 1, limit = 25) {
  const safePage = Math.max(1, page);
  const where = { workspaceId };
  const [total, contacts] = await Promise.all([
    prisma.instagramContact.count({ where }),
    prisma.instagramContact.findMany({
      where,
      orderBy: { lastInteractionAt: "desc" },
      skip: (safePage - 1) * limit,
      take: limit,
      include: {
        instagramAccount: { select: { username: true } },
        conversation: { select: { id: true, _count: { select: { messages: true } } } },
      },
    }),
  ]);
  return { contacts, pagination: { page: safePage, limit, total, totalPages: Math.max(1, Math.ceil(total / limit)) } };
}

// ─── Overview ─────────────────────────────────────────────────────────────────

export async function getEngineOverview(workspaceId: string) {
  const since = new Date(Date.now() - 24 * 3600_000);
  const [byStatus, byType, campaigns, contacts] = await Promise.all([
    prisma.instagramEvent.groupBy({
      by: ["processingStatus"],
      where: { workspaceId, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.instagramEvent.groupBy({
      by: ["eventType"],
      where: { workspaceId, createdAt: { gte: since } },
      _count: { _all: true },
    }),
    prisma.triggerCampaign.count({ where: { workspaceId, active: true } }),
    prisma.instagramContact.count({ where: { workspaceId } }),
  ]);
  const sent = await prisma.triggerExecution.count({
    where: { workspaceId, status: "SENT", sentAt: { gte: since } },
  });
  return {
    last24h: {
      byStatus: Object.fromEntries(byStatus.map((r) => [r.processingStatus, r._count._all])),
      byType: Object.fromEntries(byType.map((r) => [r.eventType, r._count._all])),
      sent,
    },
    activeCampaigns: campaigns,
    contacts,
  };
}

/** Story ids people have actually replied to, newest first — the story picker's fallback. */
export async function recentRepliedStories(workspaceId: string, accountId: string) {
  const rows = await prisma.instagramEvent.findMany({
    where: { workspaceId, instagramAccountId: accountId, eventType: "STORY_REPLY", storyId: { not: null } },
    orderBy: { createdAt: "desc" },
    take: 200,
    select: { storyId: true, storyUrl: true, createdAt: true },
  });
  const seen = new Map<string, { storyId: string; storyUrl: string | null; lastReplyAt: Date; replies: number }>();
  for (const row of rows) {
    if (!row.storyId) continue;
    const entry = seen.get(row.storyId);
    if (entry) entry.replies++;
    else seen.set(row.storyId, { storyId: row.storyId, storyUrl: row.storyUrl, lastReplyAt: row.createdAt, replies: 1 });
  }
  return [...seen.values()].slice(0, 30);
}

// ─── Simulator ────────────────────────────────────────────────────────────────

const VERDICT_TEXT: Record<Exclude<CampaignVerdict, { matched: true }>["reason"], string> = {
  inactive: "O'chirilgan",
  wrong_trigger: "Boshqa trigger",
  story_scope: "Bu story campaign ro'yxatida yo'q",
  no_keywords: "Kalit so'z kiritilmagan",
  keyword: "Kalit so'z mos kelmadi",
};

/** Dry run: which campaign would answer this reply, and with what. Writes nothing. */
export async function simulateStoryReply(
  workspaceId: string,
  input: { instagramAccountId: string; text: string; storyId?: string | null }
) {
  const campaigns = await prisma.triggerCampaign.findMany({
    where: { workspaceId, instagramAccountId: input.instagramAccountId, triggerType: "STORY_REPLY" },
    orderBy: { createdAt: "asc" },
  });
  const event = { type: "STORY_REPLY" as const, text: input.text, storyId: input.storyId || null };
  const selection = selectCampaign(campaigns, event);

  return {
    selected: selection.campaign
      ? {
          id: selection.campaign.id,
          name: selection.campaign.name,
          matchedKeyword: selection.matchedKeyword,
          responseMessage: selection.campaign.responseMessage,
        }
      : null,
    ignoredReason: selection.ignoredReason,
    campaigns: campaigns.map((campaign) => {
      const verdict = evaluateCampaign(campaign, event);
      return {
        id: campaign.id,
        name: campaign.name,
        matched: verdict.matched,
        matchedKeyword: verdict.matched ? verdict.matchedKeyword : null,
        reason: verdict.matched ? null : VERDICT_TEXT[verdict.reason],
      };
    }),
  };
}
