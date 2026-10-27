/**
 * Instagram behind the ChannelAdapter (T0). A thin layer over the existing,
 * battle-tested Meta client (lib/meta/client, lib/meta/publish): the same
 * endpoints, the same error mapping, now reachable through one interface and
 * mapped onto ChannelError kinds.
 *
 * Existing production paths (comment worker, JavobAI runtime, Content
 * Scheduler) still call lib/meta directly and keep doing so until each is
 * moved with its own regression tests; every NEW caller uses this adapter.
 */

import { getUserInfo, getMediaInsights, MetaApiError, PermissionError, RateLimitError, refreshLongLivedToken, sendCommentReply, sendDirectMessage, sendPrivateReply, setCommentHidden, TokenExpiredError } from "@/lib/meta/client";
import { createContainer, getContainerStatus, publishContainer } from "@/lib/meta/publish";
import { capabilitiesOf } from "./capabilities";
import { ChannelError, type ChannelAdapter, type InboundEvent, type PostVariant, type PublishResult } from "./types";

function mapError(error: unknown): never {
  if (error instanceof ChannelError) throw error;
  if (error instanceof TokenExpiredError) throw new ChannelError("auth", "Instagram ulanishi eskirgan — qayta ulang");
  if (error instanceof PermissionError) throw new ChannelError("permission", "Instagram ruxsati yetarli emas");
  if (error instanceof RateLimitError) throw new ChannelError("rate_limit", "Instagram so'rovlarni cheklab qo'ydi", 600);
  if (error instanceof MetaApiError) {
    // 10 / 2534022: outside the messaging window; 551: user unavailable
    if (error.code === 10 || error.subcode === 2534022) throw new ChannelError("window_closed", "Xabar yuborish oynasi yopiq");
    throw new ChannelError("invalid", "Instagram so'rovni qabul qilmadi");
  }
  throw new ChannelError("transient", "Instagram bilan aloqa xatosi");
}

async function guard<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    mapError(error);
  }
}

function mediaTypeFor(post: PostVariant): "REELS" | "STORIES" | "CAROUSEL" | undefined {
  if (post.format === "reel" || post.format === "video") return "REELS";
  if (post.format === "story") return "STORIES";
  if (post.format === "carousel") return "CAROUSEL";
  return undefined;
}

const isVideoUrl = (url: string) => /\.(mp4|mov|m4v)(\?|$)/i.test(url);

export const instagramAdapter: ChannelAdapter = {
  channel: "instagram",
  capabilities: () => capabilitiesOf("instagram"),

  async connect(creds) {
    const me = await guard(() => getUserInfo(creds.accessToken));
    return { externalAccountId: String(me.user_id ?? me.id), username: me.username ?? null };
  },

  async refreshCredentials(creds) {
    const next = await guard(() => refreshLongLivedToken(creds.accessToken));
    return { accessToken: next.accessToken, refreshToken: null, expiresAt: new Date(Date.now() + next.expiresIn * 1000) };
  },

  async checkCredentials(creds) {
    try {
      await getUserInfo(creds.accessToken);
      return { ok: true };
    } catch (error) {
      return { ok: false, error: error instanceof TokenExpiredError ? "auth" : error instanceof Error ? error.name : "unknown" };
    }
  },

  async publish(creds, post): Promise<PublishResult> {
    const caps = capabilitiesOf("instagram");
    if (!caps.publish_formats.includes(post.format)) throw new ChannelError("not_supported", `Instagram ${post.format} formatini qabul qilmaydi`);
    const urls = post.mediaUrls ?? [];
    if (urls.length === 0) throw new ChannelError("invalid", "Instagram uchun media kerak");
    return guard(async () => {
      const mediaType = mediaTypeFor(post);
      let containerId: string;
      if (post.format === "carousel") {
        const children: string[] = [];
        for (const url of urls.slice(0, 10)) {
          const child = await createContainer(creds.accessToken, creds.externalAccountId, isVideoUrl(url) ? { videoUrl: url, isCarouselItem: true } : { imageUrl: url, isCarouselItem: true });
          children.push(child.id);
        }
        containerId = (await createContainer(creds.accessToken, creds.externalAccountId, { mediaType: "CAROUSEL", children, caption: post.text ?? undefined })).id;
      } else {
        const url = urls[0];
        const video = isVideoUrl(url) || post.format === "reel" || post.format === "video";
        containerId = (
          await createContainer(creds.accessToken, creds.externalAccountId, {
            ...(video ? { videoUrl: url } : { imageUrl: url }),
            mediaType,
            caption: post.format === "story" ? undefined : (post.text ?? undefined),
            coverUrl: post.coverUrl ?? undefined,
            trialStrategy: post.trial ?? undefined,
          })
        ).id;
      }
      return { status: "processing", pollToken: containerId, retryAfterSec: 30 } as const;
    });
  },

  async continuePublish(creds, pollToken) {
    return guard(async () => {
      const status = await getContainerStatus(creds.accessToken, pollToken);
      if (status.status === "IN_PROGRESS") return { status: "processing", pollToken, retryAfterSec: 30 } as const;
      if (status.status !== "FINISHED") throw new ChannelError("invalid", `Instagram media qayta ishlanmadi: ${status.status}`);
      const published = await publishContainer(creds.accessToken, creds.externalAccountId, pollToken);
      return { status: "published", externalId: published.id } as const;
    });
  },

  async replyComment(creds, commentId, text) {
    const r = await guard(() => sendCommentReply(creds.accessToken, commentId, text));
    return { externalId: r.id };
  },

  async hideComment(creds, commentId, hide) {
    await guard(() => setCommentHidden(creds.accessToken, commentId, hide));
  },

  async sendDm(creds, recipientId, text) {
    const r = await guard(() => sendDirectMessage(creds.accessToken, creds.externalAccountId, recipientId, text));
    return { externalId: r.message_id };
  },

  async privateReply(creds, commentId, text) {
    const r = await guard(() => sendPrivateReply(creds.accessToken, creds.externalAccountId, commentId, text));
    return { externalId: r.message_id };
  },

  async fetchInsights(creds, mediaId, metrics) {
    const rows = await guard(() => getMediaInsights(creds.accessToken, mediaId, metrics));
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(rows as unknown as Record<string, unknown>)) if (typeof v === "number") out[k] = v;
    return { externalId: mediaId, metrics: out, fetchedAt: new Date() };
  },
};

// ─── Inbound normalisation ────────────────────────────────────────────────────

interface IgEntry {
  id?: string;
  time?: number;
  changes?: Array<{ field?: string; value?: Record<string, unknown> }>;
  messaging?: Array<Record<string, unknown>>;
}

/**
 * Meta's Instagram webhook payload → InboundEvent[]. Pure. Echoes (our own
 * sends) and read receipts are not inbound events and are skipped.
 */
export function normalizeInstagramWebhook(payload: unknown, rawRef: string | null = null): InboundEvent[] {
  const entries = ((payload as { entry?: IgEntry[] })?.entry ?? []) as IgEntry[];
  const out: InboundEvent[] = [];
  for (const entry of entries) {
    const accountId = String(entry.id ?? "");
    if (!accountId) continue;
    for (const change of entry.changes ?? []) {
      const v = change.value ?? {};
      const from = (v.from ?? {}) as { id?: string; username?: string };
      if (change.field === "comments" || change.field === "live_comments") {
        const media = (v.media ?? {}) as { id?: string; original_media_id?: string };
        if (!v.id || !from.id || from.id === accountId) continue;
        out.push({
          tenantId: null,
          channel: "instagram",
          accountId,
          kind: v.parent_id ? "reply" : "comment",
          externalId: String(v.id),
          threadId: media.id ?? null,
          parentId: media.original_media_id ?? (v.parent_id ? String(v.parent_id) : null),
          author: { externalId: String(from.id), username: from.username ?? null },
          text: String(v.text ?? ""),
          media: [],
          createdAt: entry.time ? new Date(entry.time * (entry.time > 1e12 ? 1 : 1000)) : new Date(),
          rawRef,
        });
      } else if (change.field === "mentions") {
        if (!v.comment_id && !v.media_id) continue;
        out.push({
          tenantId: null,
          channel: "instagram",
          accountId,
          kind: "mention",
          externalId: String(v.comment_id ?? v.media_id),
          threadId: v.media_id ? String(v.media_id) : null,
          author: { externalId: "" },
          text: "",
          media: [],
          createdAt: entry.time ? new Date(entry.time * 1000) : new Date(),
          rawRef,
        });
      }
    }
    for (const m of entry.messaging ?? []) {
      const sender = (m.sender ?? {}) as { id?: string };
      const message = m.message as { mid?: string; text?: string; is_echo?: boolean; attachments?: Array<{ type?: string; payload?: { url?: string } }>; reply_to?: { story?: unknown } } | undefined;
      const postback = m.postback as { mid?: string; title?: string; payload?: string } | undefined;
      const ts = typeof m.timestamp === "number" ? new Date(m.timestamp) : new Date();
      if (message && !message.is_echo && message.mid && sender.id && sender.id !== accountId) {
        out.push({
          tenantId: null,
          channel: "instagram",
          accountId,
          kind: message.reply_to?.story ? "story_reply" : "dm",
          externalId: message.mid,
          threadId: sender.id,
          author: { externalId: sender.id },
          text: message.text ?? "",
          media: (message.attachments ?? []).map((a) => ({
            type: a.type === "image" ? "image" : a.type === "video" || a.type === "ig_reel" || a.type === "reel" ? "video" : a.type === "audio" ? "audio" : a.type === "file" ? "file" : "other",
            url: a.payload?.url ?? null,
          })),
          createdAt: ts,
          rawRef,
        });
      } else if (postback && sender.id && sender.id !== accountId) {
        out.push({
          tenantId: null,
          channel: "instagram",
          accountId,
          kind: "postback",
          externalId: postback.mid ?? `${sender.id}:${ts.getTime()}`,
          threadId: sender.id,
          author: { externalId: sender.id },
          text: postback.title ?? postback.payload ?? "",
          media: [],
          createdAt: ts,
          rawRef,
        });
      }
    }
  }
  return out;
}
