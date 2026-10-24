/**
 * ETAP 13 Faza 2 — the Content Scheduler behind the MCP tools (spec §9:
 * list_scheduled_posts, get_scheduled_post, create_post_draft,
 * get_publishing_quota).
 *
 * Same rules as lib/mcp/service.ts: every call takes the TOKEN's
 * workspaceId and goes through the already workspace-scoped content service
 * (a foreign id is "not found"); what leaves is a whitelist (no signed media
 * URLs, no tokens, user text under `untrusted`). The only write is a DRAFT:
 * create_post_draft has no time, status or publish field, and its executor
 * calls createPost, which always stores DRAFT — scheduling and publishing
 * stay in the SocialAuto app (spec §12 "MCP faqat draft").
 */

import { z } from "zod";
import { prisma } from "@/lib/db/client";
import { isContentSchedulerEnabled } from "@/lib/content/config";
import { ContentError } from "@/lib/content/errors";
import { accountQuota } from "@/lib/content/quota";
import { POST_STATUSES, POST_TYPES, postInputSchema } from "@/lib/content/schema";
import { createPost, getPost, listPosts, validateDraft, type PostDetail } from "@/lib/content/service";
import { McpServiceError, notFound } from "./errors";
import { quote, type Preview } from "./service";

export const CONTENT_OFF = "Content Scheduler o'chirilgan (CONTENT_SCHEDULER_DISABLED)";
export const DRAFT_ONLY_NOTE = "MCP faqat DRAFT yaratadi: post rejalashtirilmaydi va chiqmaydi. Rejalashtirish va chiqarish faqat SocialAuto ilovasida, odam tomonidan.";

export function contentToolsEnabled(): boolean {
  return isContentSchedulerEnabled();
}

/** ContentError → McpServiceError (so its Uzbek message reaches the client); anything else stays unexpected. */
async function content<T>(fn: () => Promise<T>): Promise<T> {
  if (!contentToolsEnabled()) throw new McpServiceError(404, CONTENT_OFF);
  try {
    return await fn();
  } catch (error) {
    if (error instanceof ContentError) throw new McpServiceError(error.status, error.message);
    throw error;
  }
}

const iso = (d: Date | string | null | undefined) => (d ? new Date(d).toISOString() : null);
const clip = (text: string | null | undefined, max: number) => (text ? (text.length > max ? `${text.slice(0, max - 1)}…` : text) : null);

// ─── READ ───────────────────────────────────────────────────────────────────

export const listScheduledPostsInput = z.object({
  from: z.string().datetime({ offset: true }).optional().describe("ISO date-time: scheduled at or after."),
  to: z.string().datetime({ offset: true }).optional().describe("ISO date-time: scheduled before."),
  status: z.enum(POST_STATUSES).optional(),
  accountId: z.string().min(1).optional().describe("Instagram account id (from list_instagram_accounts)."),
  limit: z.number().int().min(1).max(100).default(20),
});

export async function listScheduledPostsView(workspaceId: string, input: z.infer<typeof listScheduledPostsInput>) {
  return content(async () => {
    const { items, total } = await listPosts(workspaceId, {
      from: input.from ? new Date(input.from) : undefined,
      to: input.to ? new Date(input.to) : undefined,
      status: input.status,
      account: input.accountId,
      page: 1,
      pageSize: input.limit,
    });
    return {
      total,
      posts: items.map((p) => ({
        id: p.id,
        account: p.accountUsername ? `@${p.accountUsername}` : null,
        instagramAccountId: p.instagramAccountId,
        type: p.type,
        status: p.status,
        scheduledAt: iso(p.scheduledAt),
        publishedAt: iso(p.publishedAt),
        permalink: p.permalink,
        mediaCount: p.mediaCount,
        campaignLinked: p.linked,
        autoPublish: p.autoPublish,
        lastErrorCode: p.lastErrorCode,
        untrusted: { caption: clip(p.caption, 200) },
      })),
    };
  });
}

function postView(p: PostDetail) {
  return {
    id: p.id,
    account: p.accountUsername ? `@${p.accountUsername}` : null,
    instagramAccountId: p.instagramAccountId,
    type: p.type,
    status: p.status,
    scheduledAt: iso(p.scheduledAt),
    timezone: p.timezone,
    publishedAt: iso(p.publishedAt),
    permalink: p.permalink,
    autoPublish: p.autoPublish,
    manualReason: p.manualReason,
    shareToFeed: p.shareToFeed,
    isAiGenerated: p.isAiGenerated,
    labels: p.labels,
    version: p.version,
    lastError: p.lastErrorCode ? { code: p.lastErrorCode, message: p.lastErrorMessage } : null,
    media: p.media.map((m) => ({ mediaId: m.mediaId, position: m.position, kind: m.kind, status: m.status, width: m.width, height: m.height, durationMs: m.durationMs })),
    linkedCampaign: p.linkedCampaign ? { kind: p.linkedCampaign.kind, id: p.linkedCampaign.id, active: p.linkedCampaign.active, waiting: p.linkedCampaign.waiting } : null,
    issues: p.issues.map((i) => i.message),
    untrusted: {
      caption: clip(p.caption, 2200),
      firstComment: clip(p.firstComment, 2200),
      collaborators: p.collaborators,
      altTexts: p.media.map((m) => m.altText),
      userTags: p.media.map((m) => m.userTags.map((t) => t.username)),
      campaignName: p.linkedCampaign?.name ?? null,
    },
  };
}

export async function scheduledPostView(workspaceId: string, postId: string) {
  return content(async () => postView(await getPost(workspaceId, postId)));
}

export const publishingQuotaInput = z.object({ accountId: z.string().min(1).optional().describe("Instagram account id; all accounts when omitted.") });

export async function publishingQuotaView(workspaceId: string, input: z.infer<typeof publishingQuotaInput>) {
  return content(async () => {
    const accounts = await prisma.instagramAccount.findMany({ where: { workspaceId, ...(input.accountId ? { id: input.accountId } : {}) }, select: { id: true, username: true, canPublish: true } });
    if (input.accountId && accounts.length === 0) throw notFound("Instagram akkaunt topilmadi");
    const quotas = await Promise.all(
      accounts.map(async (a) => {
        const q = await accountQuota(a.id);
        return { instagramAccountId: a.id, account: `@${a.username}`, canPublish: a.canPublish === true, used: q.used, total: q.total, scheduledNext24h: q.scheduledNext24h, remaining: Math.max(0, q.total - q.used - q.scheduledNext24h), resetsAt: iso(q.resetsAt), source: q.source };
      })
    );
    return { window: "24 soat (sirpanuvchi)", accounts: quotas };
  });
}

// ─── WRITE: create_post_draft ───────────────────────────────────────────────

/**
 * Deliberately no scheduledAt / status / publish / autoPublish: the draft
 * can only be scheduled by a person in the app. Media are ids already in
 * the library (MCP cannot upload).
 */
export const createPostDraftInput = z
  .object({
    instagramAccountId: z.string().min(1).describe("Instagram account id (from list_instagram_accounts)."),
    type: z.enum(POST_TYPES).describe("FEED_IMAGE, FEED_VIDEO, CAROUSEL, REEL, TRIAL_REEL or STORY."),
    caption: z.string().max(2200).optional(),
    firstComment: z.string().max(2200).optional(),
    collaborators: z.array(z.string().trim().min(1).max(31)).max(5).optional(),
    mediaIds: z.array(z.string().min(1)).max(20).default([]).describe("Media library ids, in order (e.g. from get_scheduled_post). May be empty: the person adds media in the app."),
    altTexts: z.array(z.string().max(1000)).max(20).optional().describe("Alt text per media item, same order as mediaIds."),
    labels: z.array(z.string().trim().min(1).max(32)).max(10).optional(),
  })
  .strict();
export type CreatePostDraftInput = z.infer<typeof createPostDraftInput>;

function toPostInput(input: CreatePostDraftInput) {
  return postInputSchema.parse({
    instagramAccountId: input.instagramAccountId,
    type: input.type,
    caption: input.caption,
    firstComment: input.firstComment,
    collaborators: input.collaborators,
    media: input.mediaIds.map((mediaId, i) => ({ mediaId, ...(input.altTexts?.[i] ? { altText: input.altTexts[i] } : {}) })),
    labels: [...new Set([...(input.labels ?? []), "mcp"])],
  });
}

async function ownedAccountName(workspaceId: string, accountId: string): Promise<string> {
  const account = await prisma.instagramAccount.findFirst({ where: { id: accountId, workspaceId }, select: { username: true } });
  if (!account) throw notFound("Instagram akkaunt topilmadi");
  return account.username;
}

async function ownedMediaCount(workspaceId: string, ids: string[]): Promise<void> {
  const unique = [...new Set(ids)];
  if (!unique.length) return;
  const found = await prisma.mediaAsset.count({ where: { id: { in: unique }, workspaceId, status: { not: "DELETED" } } });
  if (found !== unique.length) throw notFound("Media topilmadi");
}

export async function previewCreatePostDraft(workspaceId: string, input: CreatePostDraftInput): Promise<Preview> {
  return content(async () => {
    const username = await ownedAccountName(workspaceId, input.instagramAccountId);
    await ownedMediaCount(workspaceId, input.mediaIds);
    const issues = await validateDraft(workspaceId, toPostInput(input));
    const hard = issues.find((i) => i.field === "type");
    if (hard) throw new McpServiceError(400, hard.message);
    return {
      summary: `@${username} uchun ${input.type} draft post yaratiladi (rejalashtirilmaydi, chiqmaydi)`,
      details: {
        account: `@${username}`,
        type: input.type,
        caption: input.caption ? quote(input.caption) : null,
        mediaCount: input.mediaIds.length,
        status: "DRAFT",
        willSchedule: false,
        willPublish: false,
      },
      warnings: [...issues.map((i) => `Rejalashtirishdan oldin tuzatiladi: ${i.message}`), DRAFT_ONLY_NOTE],
    };
  });
}

export async function executeCreatePostDraft(workspaceId: string, raw: unknown) {
  return content(async () => {
    const input = createPostDraftInput.parse(raw);
    await ownedAccountName(workspaceId, input.instagramAccountId);
    await ownedMediaCount(workspaceId, input.mediaIds);
    const post = await createPost(workspaceId, null, toPostInput(input));
    if (post.status !== "DRAFT") throw new McpServiceError(500, "Kutilmagan holat");
    return { postId: post.id, status: post.status, scheduled: false, published: false, notes: [DRAFT_ONLY_NOTE] };
  });
}
