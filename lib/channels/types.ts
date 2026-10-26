/**
 * Channel layer (audit 2026-10-26, T0): one abstraction for every social
 * channel. Business logic (campaigns, JavobAI, Content Scheduler, policy
 * engine) talks to a ChannelAdapter, never to a channel SDK directly; adding
 * a channel means a new adapter + a capabilities entry, nothing else.
 *
 * What a channel can do lives in capabilities.json (config, not code), so a
 * Meta policy change is a config edit.
 */

export const CHANNELS = ["instagram", "facebook", "threads", "youtube", "telegram"] as const;
export type ChannelId = (typeof CHANNELS)[number];

export type InboundKind = "comment" | "dm" | "mention" | "reply" | "channel_dm" | "business_dm" | "story_reply" | "postback";

/** Every incoming event, whatever the channel, normalised before it reaches a queue. */
export interface InboundEvent {
  tenantId: string | null;
  channel: ChannelId;
  /** The connected account / page / channel / bot on our side (external id). */
  accountId: string;
  kind: InboundKind;
  /** Channel's own id of the event (comment id, message id, update id): the dedup key. */
  externalId: string;
  /** Conversation / post / topic the event belongs to. */
  threadId: string | null;
  author: { externalId: string; username?: string | null; name?: string | null };
  text: string;
  media: Array<{ type: "image" | "video" | "audio" | "file" | "sticker" | "other"; url?: string | null; externalId?: string | null }>;
  createdAt: Date;
  /** Where the raw payload is kept (e.g. "webhook_event:<id>"), never the payload itself. */
  rawRef: string | null;
  /** Comment on an ad: the organic post it came from, etc. */
  parentId?: string | null;
}

export interface ChannelCapabilities {
  supports_dm: boolean;
  /** Only one private reply per comment. */
  private_reply_once: boolean;
  /** How long after a comment a private reply is allowed (days), null = no private reply. */
  private_reply_window_days: number | null;
  /** Messaging window after the customer's last message (hours), null = no window rule. */
  dm_window_hours: number | null;
  /** Platform publish cap per 24 h, null = none known. */
  publish_daily_limit: number | null;
  supports_hide: boolean;
  /** Instagram Trial Reels and similar. */
  supports_trial: boolean;
  supports_publish: boolean;
  supports_insights: boolean;
  /** Media formats the publish path accepts. */
  publish_formats: Array<"text" | "image" | "video" | "carousel" | "reel" | "story" | "short">;
}

/** One post as a channel will receive it (Content Scheduler keeps the master copy). */
export interface PostVariant {
  format: "text" | "image" | "video" | "carousel" | "reel" | "story" | "short";
  text?: string | null;
  /** Public, short-lived URLs (presigned) of the media, in order. */
  mediaUrls?: string[];
  coverUrl?: string | null;
  /** Instagram Trial Reels. */
  trial?: "MANUAL" | "SS_PERFORMANCE" | null;
  /** Channel-specific extras (privacyStatus for YouTube, reply_control for Threads…). */
  options?: Record<string, unknown>;
  /** Caller's idempotency key: the same key never publishes twice. */
  idempotencyKey: string;
}

export type PublishResult =
  | { status: "published"; externalId: string; permalink?: string | null }
  /** The platform is still processing (Instagram containers, YouTube upload): call continuePublish later. */
  | { status: "processing"; pollToken: string; retryAfterSec: number };

export interface InsightsResult {
  externalId: string;
  metrics: Record<string, number>;
  fetchedAt: Date;
}

/** The secret material an adapter needs; produced by the credential vault, never logged. */
export interface ChannelCredentials {
  accessToken: string;
  refreshToken?: string | null;
  /** The account's own id on the channel (IG user id, page id, bot id…). */
  externalAccountId: string;
  expiresAt?: Date | null;
  extra?: Record<string, unknown>;
}

export interface RefreshedCredentials {
  accessToken: string;
  refreshToken?: string | null;
  expiresAt: Date | null;
}

export type ChannelErrorKind = "auth" | "permission" | "rate_limit" | "not_supported" | "invalid" | "window_closed" | "transient";

export class ChannelError extends Error {
  constructor(
    readonly kind: ChannelErrorKind,
    message: string,
    readonly retryAfterSec: number | null = null
  ) {
    super(message);
    this.name = "ChannelError";
  }
}

export interface ChannelAdapter {
  readonly channel: ChannelId;
  capabilities(): ChannelCapabilities;
  /** OAuth / bot linking happens in routes; connect() validates fresh credentials and returns the account's identity. */
  connect(creds: ChannelCredentials): Promise<{ externalAccountId: string; username: string | null }>;
  refreshCredentials(creds: ChannelCredentials): Promise<RefreshedCredentials>;
  /** Cheap liveness check of the credentials (debug_token, getMe…). */
  checkCredentials(creds: ChannelCredentials): Promise<{ ok: boolean; error?: string }>;
  publish(creds: ChannelCredentials, post: PostVariant): Promise<PublishResult>;
  continuePublish(creds: ChannelCredentials, pollToken: string): Promise<PublishResult>;
  replyComment(creds: ChannelCredentials, commentId: string, text: string): Promise<{ externalId: string }>;
  hideComment(creds: ChannelCredentials, commentId: string, hide: boolean): Promise<void>;
  sendDm(creds: ChannelCredentials, recipientId: string, text: string, threadId?: string | null): Promise<{ externalId: string }>;
  privateReply(creds: ChannelCredentials, commentId: string, text: string): Promise<{ externalId: string }>;
  fetchInsights(creds: ChannelCredentials, mediaId: string, metrics: string[]): Promise<InsightsResult>;
}
