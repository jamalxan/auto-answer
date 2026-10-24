/**
 * Comment-to-DM campaign (legacy Automation engine) creation, shared by the
 * main dashboard route (POST /api/automations) and the Content Scheduler's
 * inline "Yangi kampaniya" (ETAP 13 FR-L1). One place holds the field
 * normalisation (opening DM, follow gate, follow-up, public reply variants,
 * tracked links), so both callers create identical campaigns.
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { generateReportShareSlug } from "@/lib/reports/share";
import { generateTrackedLinkSlug } from "@/lib/tracking/server";

export const createAutomationBaseSchema = z
  .object({
    name: z.string().min(1).max(100),
    goal: z.string().min(1).max(120).optional().nullable(),
    instagramAccountId: z.string().min(1).optional().nullable(),
    postId: z.string().min(1).optional().nullable(),
    postUrl: z.string().url().optional().nullable(),
    pendingNextReel: z.boolean().optional().default(false),
    matchAnyPost: z.boolean().optional().default(false),
    keywords: z.array(z.string().min(1).max(50)).max(10).optional().default([]),
    matchAnyWord: z.boolean().optional().default(false),
    dmTriggerEnabled: z.boolean().optional().default(false),
    handoffToAssistant: z.boolean().optional().default(false),
    dmMessage: z.string().min(1).max(1000),
    openingDmEnabled: z.boolean().optional().default(false),
    openingDmMessage: z.string().max(1000).optional().nullable(),
    openingDmButtonLabel: z.string().max(64).optional().nullable(),
    linkButtonLabel: z.string().max(20).optional().nullable(),
    requireFollow: z.boolean().optional().default(false),
    followPromptMessage: z.string().max(1000).optional().nullable(),
    followPromptButtonLabel: z.string().max(20).optional().nullable(),
    followUpEnabled: z.boolean().optional().default(false),
    followUpMessage: z.string().max(1000).optional().nullable(),
    // Minutes to wait before the follow-up. Capped at 24h so it stays inside
    // Instagram's messaging window.
    followUpDelayMinutes: z.number().int().min(0).max(1440).optional().default(0),
    publicReplyEnabled: z.boolean().optional().default(false),
    publicReplyMessage: z.string().max(1000).optional().nullable(),
    publicReplyMessages: z
      .array(z.string().max(1000))
      .max(10)
      .optional()
      .default([]),
    // Empty string means "no tracked link"; a URL sets one.
    trackedDestinationUrl: z
      .union([z.string().url(), z.literal("")])
      .optional()
      .nullable(),
    // Optional second tracked link, rendered as a second DM button.
    secondaryDestinationUrl: z
      .union([z.string().url(), z.literal("")])
      .optional()
      .nullable(),
    secondaryButtonLabel: z.string().max(20).optional().nullable(),
    isActive: z.boolean().optional().default(true),
    wholeWordMatch: z.boolean().optional().default(true),
  });

/** The dashboard's create body: the base fields plus the targeting rules. */
export const createAutomationSchema = createAutomationBaseSchema
  // A campaign must target a specific post, any post, or the next reel.
  .refine(
    (d) => d.matchAnyPost || d.pendingNextReel || Boolean(d.postId),
    { message: "Choose which post(s) trigger the campaign", path: ["postId"] }
  )
  // And it must match either specific words or any word.
  .refine((d) => d.matchAnyWord || d.keywords.length >= 1, {
    message: "Add at least one keyword, or match any word",
    path: ["keywords"],
  })
  // An opening DM needs both a message and a button label.
  .refine(
    (d) =>
      !d.openingDmEnabled ||
      (Boolean(d.openingDmMessage?.trim()) &&
        Boolean(d.openingDmButtonLabel?.trim())),
    { message: "Opening DM needs a message and a button label", path: ["openingDmMessage"] }
  );

export type CreateAutomationData = z.output<typeof createAutomationBaseSchema>;

export interface CreateAutomationExtra {
  /** ETAP 13: park the new campaign on a scheduled post (inactive, no media). */
  scheduledPostId?: string | null;
}

/** Writes the campaign (and its tracked links). The caller checked the workspace and account. */
export async function createAutomationRecord(
  workspaceId: string,
  instagramAccountId: string,
  data: CreateAutomationData,
  extra: CreateAutomationExtra = {}
) {
  // The body below is the dashboard route's, moved here verbatim.
  const parsed = { data };
  const { trackedDestinationUrl, secondaryDestinationUrl, secondaryButtonLabel } =
    parsed.data;

  // The primary link's button title comes from `linkButtonLabel`; the second
  // link stores its own button title in the tracked link's `label` field.
  const linkCreates: {
    workspaceId: string;
    slug: string;
    label: string;
    destinationUrl: string;
  }[] = [];
  if (trackedDestinationUrl) {
    linkCreates.push({
      workspaceId,
      slug: generateTrackedLinkSlug(),
      label: "Primary campaign link",
      destinationUrl: trackedDestinationUrl,
    });
  }
  if (secondaryDestinationUrl) {
    linkCreates.push({
      workspaceId,
      slug: generateTrackedLinkSlug(),
      label: secondaryButtonLabel?.trim() || "Open link",
      destinationUrl: secondaryDestinationUrl,
    });
  }

  const { pendingNextReel, matchAnyPost, matchAnyWord, openingDmEnabled } =
    parsed.data;
  // A post is only stored for the "specific post" trigger.
  const isSpecificPost = !pendingNextReel && !matchAnyPost;
  const publicReplyList = (
    parsed.data.publicReplyMessages.length > 0
      ? parsed.data.publicReplyMessages
      : parsed.data.publicReplyMessage
        ? [parsed.data.publicReplyMessage]
        : []
  )
    .map((m) => m.trim())
    .filter(Boolean);

  const automation = await prisma.automation.create({
    data: {
      name: parsed.data.name,
      goal: parsed.data.goal,
      // A next-reel campaign has no post yet; the cron binds it once a reel is posted.
      postId: isSpecificPost ? parsed.data.postId : null,
      postUrl: isSpecificPost ? parsed.data.postUrl : null,
      pendingNextReel,
      matchAnyPost,
      keywords: matchAnyWord ? [] : parsed.data.keywords,
      matchAnyWord,
      dmTriggerEnabled: parsed.data.dmTriggerEnabled,
      handoffToAssistant: parsed.data.handoffToAssistant,
      dmMessage: parsed.data.dmMessage,
      openingDmEnabled,
      openingDmMessage: openingDmEnabled
        ? parsed.data.openingDmMessage || null
        : null,
      openingDmButtonLabel: openingDmEnabled
        ? parsed.data.openingDmButtonLabel || null
        : null,
      linkButtonLabel: parsed.data.linkButtonLabel || null,
      requireFollow: parsed.data.requireFollow,
      followPromptMessage: parsed.data.requireFollow
        ? parsed.data.followPromptMessage || null
        : null,
      followPromptButtonLabel: parsed.data.requireFollow
        ? parsed.data.followPromptButtonLabel || null
        : null,
      followUpEnabled: parsed.data.followUpEnabled,
      followUpMessage: parsed.data.followUpEnabled
        ? parsed.data.followUpMessage || null
        : null,
      followUpDelayMinutes: parsed.data.followUpEnabled
        ? parsed.data.followUpDelayMinutes
        : 0,
      publicReplyEnabled: parsed.data.publicReplyEnabled,
      publicReplyMessages: parsed.data.publicReplyEnabled
        ? publicReplyList
        : [],
      publicReplyMessage: parsed.data.publicReplyEnabled
        ? publicReplyList[0] ?? parsed.data.publicReplyMessage ?? null
        : null,
      isActive: parsed.data.isActive,
      wholeWordMatch: parsed.data.wholeWordMatch,
      workspaceId,
      instagramAccountId,
      ...(extra.scheduledPostId ? { scheduledPostId: extra.scheduledPostId } : {}),
      reportShareSlug: generateReportShareSlug(),
      ...(linkCreates.length > 0
        ? { trackedLinks: { create: linkCreates } }
        : {}),
    },
    include: {
      trackedLinks: true,
    },
  });
  return automation;
}
