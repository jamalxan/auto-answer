/**
 * Event Parser + Normalizer.
 *
 * Turns a raw Instagram webhook payload into the engine's internal events, one
 * per thing that happened, whatever shape Meta delivered it in:
 *
 *   messaging[].message.reply_to.story         → STORY_REPLY
 *   messaging[].message.attachments[story_mention] → STORY_MENTION
 *   any other inbound messaging[].message      → DIRECT_MESSAGE
 *   changes[field=comments]                    → COMMENT
 *   changes[field=live_comments]               → LIVE_COMMENT
 *
 * STORY_REACTION is deliberately not produced: what a story reaction looks
 * like in the webhook has to be confirmed against real deliveries first, not
 * guessed. Echoes (the account's own sends), deletions, read receipts and
 * postbacks are not customer events and are dropped here.
 *
 * Pure: no database, no network — so it is cheap to test against fixtures.
 */

export type NormalizedEventType =
  | "STORY_REPLY"
  | "STORY_MENTION"
  | "DIRECT_MESSAGE"
  | "LIVE_COMMENT"
  | "STORY_REACTION"
  | "COMMENT";

export interface NormalizedInstagramEvent {
  type: NormalizedEventType;
  /** Instagram professional account id (webhook entry.id). */
  instagramAccountId: string;
  senderId: string;
  senderUsername?: string;
  /** Meta message id (mid) or comment id — the dedup key. */
  messageId: string;
  storyId?: string;
  storyUrl?: string;
  mediaId?: string;
  text: string;
  hasAttachment: boolean;
  timestamp: Date;
  /** The single messaging item / change this event came from. */
  raw: Record<string, unknown>;
}

interface RawAttachment {
  type?: string;
  payload?: { url?: string; id?: string };
}

interface RawMessaging {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  message?: {
    mid?: string;
    text?: string;
    is_echo?: boolean;
    is_deleted?: boolean;
    is_unsupported?: boolean;
    attachments?: RawAttachment[];
    reply_to?: {
      mid?: string;
      story?: { id?: string; url?: string };
    };
  };
}

interface RawChange {
  field?: string;
  value?: {
    id?: string;
    comment_id?: string;
    text?: string;
    timestamp?: number | string;
    from?: { id?: string; username?: string };
    media?: { id?: string };
    media_id?: string;
  };
}

interface RawEntry {
  id?: string;
  time?: number;
  messaging?: RawMessaging[];
  changes?: RawChange[];
}

export interface RawWebhookPayload {
  object?: string;
  entry?: RawEntry[];
}

/** Meta sends some timestamps in seconds and some in milliseconds. */
export function toDate(value: number | string | undefined, fallback: Date): Date {
  if (value === undefined || value === null || value === "") return fallback;
  if (typeof value === "string" && !/^\d+$/.test(value)) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? fallback : parsed;
  }
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return new Date(n < 1e12 ? n * 1000 : n);
}

function normalizeMessaging(
  entryId: string,
  item: RawMessaging,
  fallbackTime: Date
): NormalizedInstagramEvent | null {
  const message = item.message;
  if (!message) return null; // read receipts, postbacks, reactions
  if (message.is_echo || message.is_deleted) return null;

  const messageId = message.mid;
  const senderId = item.sender?.id;
  const accountId = entryId || item.recipient?.id;
  if (!messageId || !senderId || !accountId) return null;
  if (senderId === accountId) return null;

  const text = message.text?.trim() ?? "";
  const attachments = message.attachments ?? [];
  const hasAttachment = attachments.length > 0 || Boolean(message.is_unsupported);
  const timestamp = toDate(item.timestamp, fallbackTime);
  const base = {
    instagramAccountId: accountId,
    senderId,
    messageId,
    text,
    hasAttachment,
    timestamp,
    raw: item as unknown as Record<string, unknown>,
  };

  const story = message.reply_to?.story;
  if (story) {
    return { ...base, type: "STORY_REPLY", storyId: story.id, storyUrl: story.url };
  }

  const mention = attachments.find((a) => a.type === "story_mention");
  if (mention) {
    return { ...base, type: "STORY_MENTION", storyUrl: mention.payload?.url, storyId: mention.payload?.id };
  }

  if (!text && !hasAttachment) return null;
  return { ...base, type: "DIRECT_MESSAGE" };
}

function normalizeChange(
  entryId: string,
  change: RawChange,
  fallbackTime: Date
): NormalizedInstagramEvent | null {
  const type: NormalizedEventType | null =
    change.field === "comments" ? "COMMENT" : change.field === "live_comments" ? "LIVE_COMMENT" : null;
  if (!type) return null;

  const value = change.value ?? {};
  const messageId = value.id ?? value.comment_id;
  const senderId = value.from?.id;
  if (!entryId || !messageId || !senderId) return null;
  // The account's own comments and replies are not customer events.
  if (senderId === entryId) return null;

  return {
    type,
    instagramAccountId: entryId,
    senderId,
    senderUsername: value.from?.username,
    messageId,
    mediaId: value.media?.id ?? value.media_id,
    text: value.text?.trim() ?? "",
    hasAttachment: false,
    timestamp: toDate(value.timestamp, fallbackTime),
    raw: { field: change.field, value: change.value } as Record<string, unknown>,
  };
}

export function normalizeWebhookPayload(
  payload: RawWebhookPayload,
  now: Date = new Date()
): NormalizedInstagramEvent[] {
  if (!payload || payload.object !== "instagram") return [];
  const events: NormalizedInstagramEvent[] = [];
  const seen = new Set<string>();

  for (const entry of payload.entry ?? []) {
    const entryId = entry.id ?? "";
    const entryTime = toDate(entry.time, now);

    const candidates = [
      ...(entry.messaging ?? []).map((m) => normalizeMessaging(entryId, m, entryTime)),
      ...(entry.changes ?? []).map((c) => normalizeChange(entryId, c, entryTime)),
    ];

    for (const event of candidates) {
      if (!event) continue;
      // The same item twice in one delivery is still one event.
      const key = `${event.instagramAccountId}|${event.messageId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      events.push(event);
    }
  }

  return events;
}
