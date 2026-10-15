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
 *   messaging[].postback with payload "c2:…"  → DIRECT_MESSAGE (+ payload)
 *   messaging[].message.quick_reply "c2:…"    → DIRECT_MESSAGE (+ payload)
 *
 * ETAP 3:
 *   messaging[].message.referral   → the type the message gets anyway, plus
 *                                    referralSource / adId / ref (click-to-Direct
 *                                    ad, ig.me link)
 *   messaging[].referral, no message → DIRECT_MESSAGE with text "" + referral
 *                                    (messaging_referral: ig.me link opened on
 *                                    an existing thread)
 *   messaging[].reaction           → MESSAGE_REACTION, react and unreact
 *                                    (observation only, never answered)
 *
 * Referral opens and reactions carry no mid of their own: their id is built
 * from sender + timestamp (+ reacted mid / action), so a redelivered webhook
 * hits the same unique (account, messageId) row and is dropped.
 *
 * STORY_REACTION is deliberately not produced: what a story reaction looks
 * like in the webhook has to be confirmed against real deliveries first, not
 * guessed — every reaction is kept as MESSAGE_REACTION meanwhile. Echoes (the account's own sends), deletions and read receipts are
 * not customer events and are dropped here. Postbacks are dropped too unless
 * they carry Comment 2.0's own "c2:" payload — "reveal:" / "followcheck:"
 * belong to the production comment campaigns (lib/queue/dm-worker.ts).
 *
 * Pure: no database, no network — so it is cheap to test against fixtures.
 */

export type NormalizedEventType =
  | "STORY_REPLY"
  | "STORY_MENTION"
  | "DIRECT_MESSAGE"
  | "LIVE_COMMENT"
  | "STORY_REACTION"
  | "COMMENT"
  | "MESSAGE_REACTION";

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
  /** Comment 2.0 button / quick-reply payload ("c2:…"); absent otherwise. */
  payload?: string;
  /** referral.source: "ADS" for a click-to-Direct ad, else the ig.me link source. */
  referralSource?: string;
  /** referral.ad_id (click-to-Direct ad). */
  adId?: string;
  /** referral.ref (ig.me link "?ref=…"). */
  ref?: string;
  /** MESSAGE_REACTION: the emoji (or Meta's reaction name); absent on unreact. */
  reaction?: string;
  /** MESSAGE_REACTION: mid of the message reacted to. */
  reactedMid?: string;
  hasAttachment: boolean;
  timestamp: Date;
  /** The single messaging item / change this event came from. */
  raw: Record<string, unknown>;
}

interface RawAttachment {
  type?: string;
  payload?: { url?: string; id?: string };
}

interface RawReferral {
  ref?: string;
  ad_id?: string;
  source?: string;
  type?: string;
}

interface RawMessaging {
  sender?: { id?: string };
  recipient?: { id?: string };
  timestamp?: number;
  postback?: { mid?: string; title?: string; payload?: string };
  referral?: RawReferral;
  reaction?: { mid?: string; action?: string; reaction?: string; emoji?: string };
  message?: {
    referral?: RawReferral;
    mid?: string;
    text?: string;
    quick_reply?: { payload?: string };
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
  if (!message) {
    if (item.reaction) return normalizeReaction(entryId, item, fallbackTime);
    if (item.referral) return normalizeReferralOpen(entryId, item, fallbackTime);
    return normalizePostback(entryId, item, fallbackTime); // read receipts → null
  }
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
  const referral = referralFields(message.referral ?? item.referral);
  const base = {
    instagramAccountId: accountId,
    senderId,
    messageId,
    text,
    hasAttachment,
    timestamp,
    ...referral,
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

  const quickReplyPayload = message.quick_reply?.payload;
  if (isC2Payload(quickReplyPayload)) {
    return { ...base, type: "DIRECT_MESSAGE", payload: quickReplyPayload };
  }

  if (!text && !hasAttachment && !hasReferral(referral)) return null;
  return { ...base, type: "DIRECT_MESSAGE" };
}

type ReferralFields = Pick<NormalizedInstagramEvent, "referralSource" | "adId" | "ref">;

/** message.referral / messaging.referral → the event's referral fields (only those present). */
function referralFields(referral: RawReferral | undefined): ReferralFields {
  const out: ReferralFields = {};
  if (!referral) return out;
  const clean = (value: unknown) => (typeof value === "string" && value.trim() ? value.trim() : undefined);
  const source = clean(referral.source);
  const adId = clean(referral.ad_id);
  const ref = clean(referral.ref);
  if (source) out.referralSource = source;
  if (adId) out.adId = adId;
  if (ref) out.ref = ref;
  return out;
}

function hasReferral(fields: ReferralFields): boolean {
  return Boolean(fields.referralSource || fields.adId || fields.ref);
}

/**
 * An ig.me link (or ad) opened on an existing thread before the person types
 * anything (messaging_referral). A DIRECT_MESSAGE with empty text, so a LINK /
 * ADS campaign can greet it. No mid from Meta: the id is built from the sender
 * and the timestamp, identical on a redelivery.
 */
function normalizeReferralOpen(
  entryId: string,
  item: RawMessaging,
  fallbackTime: Date
): NormalizedInstagramEvent | null {
  const senderId = item.sender?.id;
  const accountId = entryId || item.recipient?.id;
  if (!senderId || !accountId || senderId === accountId) return null;
  const referral = referralFields(item.referral);
  if (!hasReferral(referral)) return null;

  const timestamp = toDate(item.timestamp, fallbackTime);
  return {
    type: "DIRECT_MESSAGE",
    instagramAccountId: accountId,
    senderId,
    messageId: `ref:${senderId}:${timestamp.getTime()}`,
    text: "",
    ...referral,
    hasAttachment: false,
    timestamp,
    raw: item as unknown as Record<string, unknown>,
  };
}

/**
 * message_reactions: a reaction to one of the thread's messages (react or
 * unreact). Stored for observation only — whether a story reaction arrives
 * this way is not documented, so nothing answers it. `text` is the action.
 */
function normalizeReaction(
  entryId: string,
  item: RawMessaging,
  fallbackTime: Date
): NormalizedInstagramEvent | null {
  const reaction = item.reaction;
  const senderId = item.sender?.id;
  const accountId = entryId || item.recipient?.id;
  if (!reaction || !senderId || !accountId || senderId === accountId) return null;

  const timestamp = toDate(item.timestamp, fallbackTime);
  const action = reaction.action?.trim() || "react";
  const mid = reaction.mid?.trim() || undefined;
  return {
    type: "MESSAGE_REACTION",
    instagramAccountId: accountId,
    senderId,
    messageId: `reaction:${mid ?? "-"}:${senderId}:${action}:${timestamp.getTime()}`,
    text: action,
    reaction: reaction.emoji?.trim() || reaction.reaction?.trim() || undefined,
    reactedMid: mid,
    hasAttachment: false,
    timestamp,
    raw: item as unknown as Record<string, unknown>,
  };
}

/** Comment 2.0's own button / quick-reply payloads all start with "c2:". */
export const C2_PAYLOAD_PREFIX = "c2:";

export function isC2Payload(payload: string | null | undefined): payload is string {
  return typeof payload === "string" && payload.startsWith(C2_PAYLOAD_PREFIX);
}

/**
 * A tap on a Comment 2.0 button arrives as a postback. It becomes a
 * DIRECT_MESSAGE with the button title as text; every other postback stays
 * with production.
 */
function normalizePostback(
  entryId: string,
  item: RawMessaging,
  fallbackTime: Date
): NormalizedInstagramEvent | null {
  const postback = item.postback;
  if (!postback || !isC2Payload(postback.payload)) return null;
  const senderId = item.sender?.id;
  const accountId = entryId || item.recipient?.id;
  if (!senderId || !accountId || senderId === accountId) return null;

  const timestamp = toDate(item.timestamp, fallbackTime);
  return {
    type: "DIRECT_MESSAGE",
    instagramAccountId: accountId,
    senderId,
    // Instagram gives every postback a mid; the fallback only keeps a malformed
    // delivery deduplicated rather than dropped.
    messageId: postback.mid ?? `postback:${senderId}:${timestamp.getTime()}:${postback.payload}`,
    text: postback.title?.trim() ?? "",
    payload: postback.payload,
    hasAttachment: false,
    timestamp,
    raw: item as unknown as Record<string, unknown>,
  };
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
