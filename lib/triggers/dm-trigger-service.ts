/**
 * ETAP 3 — DM-side triggers for the dev UI / API: Direct (TZ 15), Story
 * Mention (TZ 16), click-to-Direct ads and ig.me links (TZ 18). Campaign
 * CRUD with stats, reply variants, quick replies, follow-up steps, logs and
 * the dry-run simulator; plus the one list of every ETAP 3 automation the
 * /triggers home shows.
 *
 * Every query is scoped to one workspace and to `DIRECT_MESSAGE` /
 * `STORY_MENTION`, so a comment or Story Reply campaign can never be read or
 * changed through these routes. An ad message is a Direct campaign with
 * `sourceFilter: ADS`, an ig.me link one with `sourceFilter: LINK`.
 *
 * The person has just written to us, so the 24-hour window is open: there is
 * no opening button and no "main message" — the reply goes out with its
 * quick replies straight away, and follow-ups are counted from it.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import type { InstagramEventType, Prisma } from "@/app/generated/prisma/client";
import {
  ACCOUNT_NOT_FOUND,
  accountInWorkspace,
  approveVariantIn,
  cancelExecutionFollowUpsIn,
  cleanCommentKeywords,
  done,
  executionStats,
  fail,
  followUpsSchema,
  intentKeys,
  listExecutionLogs,
  NOT_FOUND,
  typeWhere,
  variantsInputSchema,
  writeFollowUpSteps,
  writeQuickReplies,
  writeVariants,
  type FollowUpStepsInput,
  type LogQuery,
  type QuickRepliesInput,
  type ServiceResult,
  type VariantInput,
} from "./campaign-editing";
import {
  AD_ID_PATTERN,
  AUDIENCES,
  COMMENT_LIMITS as L,
  DM_FOLLOW_UP_CONDITIONS,
  DM_TRIGGER_KINDS,
  DM_TRIGGER_LIMITS as D,
  MATCHING_MODES,
  REF_PATTERN,
  REPLY_MODES,
  SOURCE_FILTERS,
} from "./comment-limits";
import { simulateDmTrigger } from "./dm-trigger-handler";
import { forgetAccountGate } from "./ingest";

export { firstIssue, quickRepliesInputSchema } from "./campaign-editing";

// ─── Validation ───────────────────────────────────────────────────────────────

export const NO_OPENING_BUTTON =
  "DM triggerlarda ochish tugmasi va \"asosiy xabar\" yo'q: odam o'zi yozgan, 24 soatlik oyna allaqachon ochiq. Javob quick reply'lar bilan darhol yuboriladi.";
export const MENTION_NO_SOURCE =
  "Story mention reklama yoki ig.me havoladan kelmaydi — manba filtrini \"Har qanday\" qiling.";
export const NO_PUBLIC_VARIANTS = "DM triggerlarda ochiq javob yo'q — faqat Direct variantlarini saqlang.";
export const NO_CLICK_NOT_OFFERED =
  "\"Tugmani bosmagan bo'lsa\" sharti DM triggerlarda yo'q — tugma yuborilmaydi. \"Har doim\" yoki \"Odam hali yozmagan bo'lsa\" ni tanlang.";

const hours = (min: number, max: number, what: string) =>
  z
    .number()
    .int(`${what} butun soat bo'lsin`)
    .min(min, `${what} ${min}…${max} soat oralig'ida bo'lsin`)
    .max(max, `${what} ${min}…${max} soat oralig'ida bo'lsin`);

/** Present and not empty → the person tried to set something DM triggers do not have. */
const mustBeEmpty = z.unknown().optional();
const isSet = (value: unknown) => value !== undefined && value !== null && value !== "" && value !== false;

export const dmCampaignSchema = z
  .object({
    name: z
      .string()
      .trim()
      .min(1, "Kampaniya nomini kiriting")
      .max(L.nameLength, `Nom ${L.nameLength} belgidan oshmasin`),
    instagramAccountId: z.string().min(1, "Instagram akkauntni tanlang"),
    triggerType: z.enum(DM_TRIGGER_KINDS, "Trigger turini tanlang: Direct yoki Story mention"),
    matchingMode: z.enum(MATCHING_MODES).default("CONTAINS"),
    keywords: z
      .array(z.string().max(L.keywordLength, `Kalit so'z ${L.keywordLength} belgidan oshmasin`))
      .max(L.keywords, `Ko'pi bilan ${L.keywords} ta kalit so'z`)
      .default([]),
    intents: z.array(z.string().max(40)).max(30).default([]),
    audience: z.enum(AUDIENCES).default("ANY"),
    reopenAfterHours: hours(D.reopenMinHours, D.reopenMaxHours, "Qayta ochilish muddati").default(D.reopenDefaultHours),
    cooldownHours: hours(D.cooldownMinHours, D.cooldownMaxHours, "Takroriy javob oralig'i").default(
      D.cooldownDefaultHours
    ),
    sourceFilter: z.enum(SOURCE_FILTERS).default("ANY"),
    adIds: z
      .array(z.string().trim())
      .max(D.adIds, `Ko'pi bilan ${D.adIds} ta reklama ID`)
      .default([]),
    refs: z
      .array(z.string().trim())
      .max(D.refs, `Ko'pi bilan ${D.refs} ta havola (ref)`)
      .default([]),
    priority: z
      .number()
      .int("Prioritet butun son bo'lsin")
      .min(L.priorityMin, `Prioritet ${L.priorityMin}…${L.priorityMax} oralig'ida bo'lsin`)
      .max(L.priorityMax, `Prioritet ${L.priorityMin}…${L.priorityMax} oralig'ida bo'lsin`)
      .default(0),
    replyMode: z.enum(REPLY_MODES).default("RANDOM"),
    stopOnReply: z.boolean().default(true),
    stopOnLead: z.boolean().default(true),
    stopOnHandoff: z.boolean().default(true),
    stopOnPurchase: z.boolean().default(true),
    responseMessage: z
      .string()
      .trim()
      .min(1, "Zaxira DM matnini kiriting — tasdiqlangan variant bo'lmasa shu yuboriladi")
      .max(L.messageLength, `DM matni ${L.messageLength} belgidan oshmasin (Meta cheklovi)`),
    active: z.boolean().default(true),
    // Comment-only settings: refused below with an explanation, never stored.
    openingButtonLabel: mustBeEmpty,
    mainMessage: mustBeEmpty,
  })
  .superRefine((input, ctx) => {
    if (isSet(input.openingButtonLabel) || isSet(input.mainMessage)) {
      ctx.addIssue({ code: "custom", path: ["openingButtonLabel"], message: NO_OPENING_BUTTON });
    }
    if (input.triggerType === "STORY_MENTION" && input.sourceFilter !== "ANY") {
      ctx.addIssue({ code: "custom", path: ["sourceFilter"], message: MENTION_NO_SOURCE });
    }
    if (input.sourceFilter === "ADS") {
      const bad = input.adIds.find((id) => id && !AD_ID_PATTERN.test(id));
      if (bad) {
        ctx.addIssue({
          code: "custom",
          path: ["adIds"],
          message: `"${bad}" reklama ID emas — Ads Manager'dagi "Ad ID" faqat raqamlardan iborat`,
        });
      }
    }
    if (input.sourceFilter === "LINK") {
      const bad = input.refs.find((ref) => ref && (!REF_PATTERN.test(ref) || ref.length > D.refLength));
      if (bad) {
        ctx.addIssue({
          code: "custom",
          path: ["refs"],
          message: `"${bad}" yaroqsiz ref: faqat lotin harflari, raqam, "_" va "-" (${D.refLength} belgigacha)`,
        });
      }
    }
  })
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- refused above, dropped here
  .transform(({ openingButtonLabel: _button, mainMessage: _main, ...input }) => {
    // Mentions carry no text: they are always answered as "every mention".
    const mention = input.triggerType === "STORY_MENTION";
    const every = mention || input.matchingMode === "EVERY";
    return {
      ...input,
      matchingMode: every ? ("EVERY" as const) : input.matchingMode,
      keywords: every ? [] : cleanCommentKeywords(input.keywords),
      intents: every ? [] : [...new Set(input.intents)],
      adIds: input.sourceFilter === "ADS" ? [...new Set(input.adIds.filter(Boolean))] : [],
      refs: input.sourceFilter === "LINK" ? [...new Set(input.refs.filter(Boolean))] : [],
    };
  })
  .superRefine((input, ctx) => {
    if (input.matchingMode !== "EVERY" && input.keywords.length === 0 && input.intents.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["keywords"],
        message: "Kamida bitta kalit so'z yoki intent tanlang (yoki \"Har bir xabar\" rejimini yoqing)",
      });
    }
    const known = new Set(intentKeys());
    const unknown = input.intents.find((key) => !known.has(key));
    if (unknown) {
      ctx.addIssue({ code: "custom", path: ["intents"], message: `Noma'lum intent: ${unknown}` });
    }
  });

export type DmCampaignInput = z.infer<typeof dmCampaignSchema>;

export const toggleSchema = z.object({ active: z.boolean() }).strict();

/** Direct variants only: a DM trigger never writes under a post. */
export const dmVariantsInputSchema = variantsInputSchema.superRefine((input, ctx) => {
  if (input.variants.some((v) => v.kind !== "DM")) {
    ctx.addIssue({ code: "custom", path: ["variants"], message: NO_PUBLIC_VARIANTS });
  }
});

export const dmFollowUpsInputSchema = followUpsSchema(DM_FOLLOW_UP_CONDITIONS, NO_CLICK_NOT_OFFERED);

export const dmSimulateInputSchema = z.object({
  instagramAccountId: z.string().min(1, "Akkauntni tanlang"),
  eventType: z.enum(DM_TRIGGER_KINDS).default("DIRECT_MESSAGE"),
  text: z.string().trim().max(2000).default(""),
  referralSource: z.enum(["ADS", "LINK"]).nullish().transform((v) => v ?? undefined),
  adId: z.string().trim().max(40).nullish().transform((v) => v || undefined),
  ref: z.string().trim().max(D.refLength).nullish().transform((v) => v || undefined),
  contactState: z.enum(["NEW", "RETURNING", "REOPENED"]).default("NEW"),
  /** The campaign being edited — tested even while it is off (draft / paused). */
  campaignId: z.string().trim().max(64).nullish().transform((v) => v || null),
});

// ─── Scoping helpers ──────────────────────────────────────────────────────────

const DM_TYPES = typeWhere(DM_TRIGGER_KINDS);

// A published flow's hidden proxy row (kind FLOW, ETAP 6) is never listed or editable here.
const isProxy = (row: { kind?: string | null } | null | undefined) => row?.kind === "FLOW";

function campaignWhere(workspaceId: string, id: string): Prisma.TriggerCampaignWhereInput {
  return { id, workspaceId, triggerType: DM_TYPES };
}

async function findCampaign(workspaceId: string, id: string) {
  const row = await prisma.triggerCampaign.findFirst({
    where: campaignWhere(workspaceId, id),
    select: { id: true, kind: true, triggerType: true, instagramAccount: { select: { instagramId: true } } },
  });
  return isProxy(row) ? null : row;
}

// ─── Campaigns ────────────────────────────────────────────────────────────────

export async function listDmCampaigns(workspaceId: string) {
  const found = await prisma.triggerCampaign.findMany({
    where: { workspaceId, triggerType: DM_TYPES },
    orderBy: [{ active: "desc" }, { priority: "desc" }, { createdAt: "desc" }],
    include: {
      instagramAccount: { select: { username: true, tokenStatus: true } },
      replyVariants: { select: { approvedAt: true } },
      _count: { select: { quickReplies: true, followUpSteps: true } },
    },
  });
  const campaigns = found.filter((c) => !isProxy(c));
  const stats = await executionStats(
    workspaceId,
    campaigns.map((c) => c.id)
  );
  return campaigns.map(({ replyVariants, ...campaign }) => ({
    ...campaign,
    variants: {
      dmApproved: replyVariants.filter((v) => v.approvedAt).length,
      unapproved: replyVariants.filter((v) => !v.approvedAt).length,
    },
    stats: stats.get(campaign.id)!,
  }));
}

export async function getDmCampaign(workspaceId: string, id: string) {
  const row = await prisma.triggerCampaign.findFirst({
    where: campaignWhere(workspaceId, id),
    include: {
      instagramAccount: { select: { username: true, tokenStatus: true } },
      replyVariants: { where: { kind: "DM" }, orderBy: { sort: "asc" } },
      quickReplies: { orderBy: { sort: "asc" } },
      followUpSteps: { orderBy: { sort: "asc" } },
    },
  });
  return isProxy(row) ? null : row;
}

/** What a DM campaign row always holds besides the input: none of the comment-only settings. */
const DM_FIXED = {
  responseType: "SEND_MESSAGE" as const,
  mediaScope: "ANY" as const,
  mediaIds: [],
  publicReplyEnabled: false,
  openingButtonLabel: null,
  mainMessage: null,
};

export async function createDmCampaign(
  workspaceId: string,
  input: DmCampaignInput
): Promise<ServiceResult<{ id: string }>> {
  const account = await accountInWorkspace(workspaceId, input.instagramAccountId);
  if (!account) return fail(400, ACCOUNT_NOT_FOUND);
  const campaign = await prisma.triggerCampaign.create({
    data: { ...input, ...DM_FIXED, workspaceId },
    select: { id: true },
  });
  forgetAccountGate(account.instagramId);
  return done(campaign);
}

export async function updateDmCampaign(
  workspaceId: string,
  id: string,
  input: DmCampaignInput
): Promise<ServiceResult<{ id: string }>> {
  const existing = await findCampaign(workspaceId, id);
  if (!existing) return fail(404, NOT_FOUND);
  const account = await accountInWorkspace(workspaceId, input.instagramAccountId);
  if (!account) return fail(400, ACCOUNT_NOT_FOUND);
  await prisma.triggerCampaign.update({ where: { id }, data: { ...input, ...DM_FIXED } });
  forgetAccountGate(existing.instagramAccount.instagramId);
  forgetAccountGate(account.instagramId);
  return done({ id });
}

export async function setDmCampaignActive(workspaceId: string, id: string, active: boolean) {
  const existing = await findCampaign(workspaceId, id);
  if (!existing) return false;
  await prisma.triggerCampaign.update({ where: { id }, data: { active } });
  forgetAccountGate(existing.instagramAccount.instagramId);
  return true;
}

export async function deleteDmCampaign(workspaceId: string, id: string) {
  const existing = await findCampaign(workspaceId, id);
  if (!existing) return false;
  await prisma.triggerCampaign.delete({ where: { id } });
  forgetAccountGate(existing.instagramAccount.instagramId);
  return true;
}

// ─── Variants, quick replies, follow-ups ──────────────────────────────────────

export async function saveDmVariants(workspaceId: string, campaignId: string, input: VariantInput[]) {
  const campaign = await findCampaign(workspaceId, campaignId);
  if (!campaign) return fail(404, NOT_FOUND);
  if (input.some((v) => v.kind !== "DM")) return fail(422, NO_PUBLIC_VARIANTS);
  return done(await writeVariants(campaignId, input));
}

export async function setDmVariantApproved(workspaceId: string, variantId: string, approved: boolean) {
  return approveVariantIn(workspaceId, variantId, approved, DM_TRIGGER_KINDS);
}

export async function saveDmQuickReplies(workspaceId: string, campaignId: string, input: QuickRepliesInput) {
  const campaign = await findCampaign(workspaceId, campaignId);
  if (!campaign) return fail(404, NOT_FOUND);
  return done(await writeQuickReplies(campaignId, input));
}

export async function saveDmFollowUpSteps(workspaceId: string, campaignId: string, input: FollowUpStepsInput) {
  const campaign = await findCampaign(workspaceId, campaignId);
  if (!campaign) return fail(404, NOT_FOUND);
  if (input.some((s) => !(DM_FOLLOW_UP_CONDITIONS as readonly string[]).includes(s.condition))) {
    return fail(422, NO_CLICK_NOT_OFFERED);
  }
  return done(await writeFollowUpSteps(campaignId, input));
}

// ─── Logs ─────────────────────────────────────────────────────────────────────

export async function listDmCampaignLogs(workspaceId: string, campaignId: string, query: LogQuery) {
  const campaign = await findCampaign(workspaceId, campaignId);
  if (!campaign) return null;
  return listExecutionLogs(workspaceId, campaignId, query);
}

export async function cancelDmExecutionFollowUps(workspaceId: string, executionId: string) {
  return cancelExecutionFollowUpsIn(workspaceId, executionId, DM_TRIGGER_KINDS);
}

// ─── Simulator ────────────────────────────────────────────────────────────────

export async function simulateDmDryRun(workspaceId: string, input: z.infer<typeof dmSimulateInputSchema>) {
  const account = await accountInWorkspace(workspaceId, input.instagramAccountId);
  if (!account) return fail(404, "Instagram akkaunt topilmadi");
  const mention = input.eventType === "STORY_MENTION";
  return done(
    await simulateDmTrigger(workspaceId, {
      instagramAccountId: account.id,
      eventType: input.eventType,
      // A mention has no text and never comes from an ad or a link.
      text: mention ? "" : input.text,
      // Meta marks ad clicks with source "ADS"; an ig.me link is known by its ref.
      referralSource: !mention && input.referralSource === "ADS" ? "ADS" : undefined,
      adId: !mention && input.referralSource === "ADS" ? input.adId : undefined,
      ref: !mention && input.referralSource === "LINK" ? input.ref : undefined,
      contactState: input.contactState,
      includeCampaignId: input.campaignId,
    })
  );
}

// ─── All ETAP 3 automations (the /triggers home) ────────────────────

/**
 * How the home list names a campaign. Ad messages and ig.me links are Direct
 * campaigns with a source filter, but people think of them as their own kind.
 */
export type AutomationKind = "DIRECT" | "AD_MESSAGE" | "LINK" | "STORY_MENTION" | "STORY_REPLY" | "LIVE_COMMENT";

export function automationKind(campaign: { triggerType: string; sourceFilter?: string | null }): AutomationKind | null {
  switch (campaign.triggerType) {
    case "DIRECT_MESSAGE":
      return campaign.sourceFilter === "ADS" ? "AD_MESSAGE" : campaign.sourceFilter === "LINK" ? "LINK" : "DIRECT";
    case "STORY_MENTION":
    case "STORY_REPLY":
    case "LIVE_COMMENT":
      return campaign.triggerType;
    default:
      return null;
  }
}

/** Where a campaign is edited: each kind keeps its own builder. */
export function automationHref(kind: AutomationKind, id: string): string {
  if (kind === "STORY_REPLY") return `/triggers/${id}`;
  if (kind === "LIVE_COMMENT") return `/comments/${id}`;
  return `/triggers/dm/${id}`;
}

const ETAP3_TYPES: InstagramEventType[] = ["DIRECT_MESSAGE", "STORY_MENTION", "STORY_REPLY", "LIVE_COMMENT"];

/** Every ETAP 3 campaign in one list: kind, account, status, the condition in short, and stats. */
export async function listAutomations(workspaceId: string) {
  const campaigns = await prisma.triggerCampaign.findMany({
    where: { workspaceId, triggerType: { in: ETAP3_TYPES }, kind: "CAMPAIGN" },
    orderBy: [{ active: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      name: true,
      triggerType: true,
      active: true,
      createdAt: true,
      matchingMode: true,
      keywords: true,
      intents: true,
      storyScope: true,
      storyIds: true,
      audience: true,
      sourceFilter: true,
      adIds: true,
      refs: true,
      responseMessage: true,
      instagramAccount: { select: { username: true, tokenStatus: true } },
      replyVariants: { where: { approvedAt: null }, select: { id: true } },
    },
  });
  const stats = await executionStats(
    workspaceId,
    campaigns.map((c) => c.id)
  );
  return campaigns.flatMap(({ replyVariants, ...campaign }) => {
    const kind = automationKind(campaign);
    if (!kind) return [];
    const s = stats.get(campaign.id)!;
    const e = s.executions;
    return [
      {
        ...campaign,
        kind,
        href: automationHref(kind, campaign.id),
        unapprovedVariants: replyVariants.length,
        stats: {
          sent: e.SENT,
          queued: e.PENDING + e.SENDING + e.RETRYING,
          failed: e.FAILED,
          skipped: e.SKIPPED,
          leads: s.leads,
          followUpsScheduled: s.followUps.SCHEDULED ?? 0,
        },
      },
    ];
  });
}
