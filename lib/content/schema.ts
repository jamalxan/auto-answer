/**
 * ETAP 13 — Zod shapes of everything the content API accepts. The field
 * matrix (which field each post type allows) lives in validate.ts; these
 * schemas only guarantee types, lengths and formats.
 */

import { z } from "zod";
import { CONTENT_LIMITS } from "./config";
import { USERNAME_RE } from "./text";

export const POST_TYPES = ["FEED_IMAGE", "FEED_VIDEO", "CAROUSEL", "REEL", "TRIAL_REEL", "STORY"] as const;
export type PostTypeValue = (typeof POST_TYPES)[number];

export const POST_STATUSES = [
  "DRAFT",
  "PENDING_REVIEW",
  "SCHEDULED",
  "PAUSED",
  "PREPARING",
  "READY_TO_PUBLISH",
  "PUBLISHING",
  "PUBLISHED",
  "NEEDS_MANUAL",
  "PUBLISHED_MANUAL",
  "FAILED",
  "REJECTED",
  "EXPIRED_REVIEW",
  "CANCELED",
] as const;
export type PostStatusValue = (typeof POST_STATUSES)[number];

const coord = z.number().min(0).max(1).transform((v) => Math.round(v * 10_000) / 10_000);

export const userTagSchema = z.object({
  username: z
    .string()
    .trim()
    .transform((v) => v.replace(/^@+/, ""))
    .pipe(z.string().regex(USERNAME_RE, "username noto'g'ri")),
  x: coord.optional(),
  y: coord.optional(),
});
export type UserTag = z.infer<typeof userTagSchema>;

export const cropRectSchema = z.object({ x: coord, y: coord, w: coord, h: coord });

export const mediaItemInputSchema = z.object({
  mediaId: z.string().min(1, "media kiritilmagan"),
  altText: z.string().max(CONTENT_LIMITS.altTextChars, `alt matn ${CONTENT_LIMITS.altTextChars} belgidan oshmasin`).optional(),
  userTags: z.array(userTagSchema).max(20, "20 tadan ko'p odam belgilab bo'lmaydi").optional(),
  cropRect: cropRectSchema.optional(),
});
export type MediaItemInput = z.infer<typeof mediaItemInputSchema>;

/**
 * FR-L1: a new comment-to-DM campaign typed in the composer. It becomes a
 * legacy Automation (the engine the main dashboard creates today, the only
 * one with the follow gate) through lib/campaigns/create-automation.
 */
export const newCampaignSchema = z.object({
  name: z.string().trim().max(100).optional(),
  keywords: z
    .array(z.string().trim().max(50, "kalit so'z 50 belgidan oshmasin"))
    .transform((list) => list.filter((k, i) => k && list.findIndex((x) => x.toLowerCase() === k.toLowerCase()) === i))
    .pipe(z.array(z.string()).min(1, "kamida bitta kalit so'z kiriting").max(10, "ko'pi bilan 10 ta kalit so'z")),
  publicReply: z.string().trim().max(1000).optional(),
  dmMessage: z.string().trim().min(1, "DM matnini kiriting").max(1000, "DM matni 1000 belgidan oshmasin"),
  link: z.union([z.string().trim().url("havola noto'g'ri"), z.literal("")]).optional(),
  linkButtonLabel: z.string().trim().max(20, "tugma nomi 20 belgidan oshmasin").optional(),
  requireFollow: z.boolean().optional(),
});
export type NewCampaignInput = z.infer<typeof newCampaignSchema>;

export const linkCampaignSchema = z
  .object({
    automationId: z.string().min(1).optional(),
    triggerCampaignId: z.string().min(1).optional(),
    create: newCampaignSchema.optional(),
  })
  .refine((v) => Boolean(v.automationId || v.triggerCampaignId || v.create), "kampaniya tanlanmagan");

export const postInputSchema = z.object({
  instagramAccountId: z.string().min(1, "akkaunt tanlanmagan"),
  type: z.enum(POST_TYPES),
  caption: z.string().max(10_000).optional(),
  firstComment: z.string().max(10_000).optional(),
  collaborators: z.array(z.string().trim()).max(10).optional(),
  shareToFeed: z.boolean().optional(),
  coverMediaId: z.string().min(1).nullable().optional(),
  thumbOffsetMs: z.number().int().min(0).max(15 * 60_000).nullable().optional(),
  trialStrategy: z.enum(["MANUAL", "SS_PERFORMANCE"]).nullable().optional(),
  audioName: z.string().max(100).nullable().optional(),
  locationId: z.string().max(64).nullable().optional(),
  isAiGenerated: z.boolean().optional(),
  autoPublish: z.boolean().optional(),
  manualReason: z.enum(["STORY_STICKER", "MUSIC", "API_REJECTED", "USER_CHOICE"]).nullable().optional(),
  media: z.array(mediaItemInputSchema).max(20),
  labels: z.array(z.string().trim().min(1).max(32)).max(20).optional(),
  linkCampaign: linkCampaignSchema.nullable().optional(),
});
export type PostInput = z.infer<typeof postInputSchema>;

/** PATCH body: any subset plus the version the client last saw. */
export const postUpdateSchema = postInputSchema.partial().extend({
  version: z.number().int().min(1, "version kiritilmagan"),
});
export type PostUpdateInput = z.infer<typeof postUpdateSchema>;

const wallClock = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "sana YYYY-MM-DD bo'lsin"),
  time: z.string().regex(/^\d{2}:\d{2}$/, "vaqt HH:mm bo'lsin"),
  timezone: z.string().min(1),
});

export const scheduleInputSchema = z.object({
  scheduledAt: z.union([z.string().datetime({ offset: true }), wallClock]),
});
export type ScheduleInput = z.infer<typeof scheduleInputSchema>;

export const postsQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: z.coerce.date().optional(),
  account: z.string().optional(),
  status: z.enum(POST_STATUSES).optional(),
  type: z.enum(POST_TYPES).optional(),
  q: z.string().trim().max(100).optional(),
  linked: z.enum(["yes", "no"]).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(100),
});
export type PostsQuery = z.infer<typeof postsQuerySchema>;

export const duplicateInputSchema = z.object({
  instagramAccountId: z.string().min(1).optional(),
});
