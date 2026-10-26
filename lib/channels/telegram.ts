/**
 * Telegram adapter (audit 2026-10-26, T3). Variant A of the audit: the
 * platform bot (TELEGRAM_BOT_TOKEN) is an admin of the customer's channel, so
 * credentials carry no secret, only the channel:
 *
 *   externalAccountId   channel chat id
 *   extra.linkedChatId  discussion group (comments)
 *   extra.dmChatId      channel Direct Messages chat (Bot API 9.2)
 *
 * A published post's externalId is every message id it took, comma-joined
 * ("12,13,14" for an album, plus the long-caption text message), so edit and
 * delete reach all of them.
 *
 * Telegram fetches media by URL up to 5 MB (photos) / 20 MB (other files);
 * bigger files are downloaded and uploaded (Bot API limit 50 MB, photos 10 MB).
 */

import {
  TelegramApiError,
  deleteMessage,
  editMessageCaption,
  editMessageText,
  getChat,
  getChatMember,
  sendMediaGroup,
  sendMessage,
  sendPhoto,
  sendVideo,
  tgUpload,
  withFloodRetry,
} from "@/lib/telegram/api";
import { botIdFromToken } from "@/lib/telegram/channel";
import { capabilitiesOf } from "./capabilities";
import { ChannelError, type ChannelAdapter, type ChannelCredentials, type PostVariant, type PublishResult } from "./types";

export const CAPTION_LIMIT = 1024;
export const TEXT_LIMIT = 4096;
const URL_PHOTO_MAX = 5 * 1024 * 1024;
const URL_FILE_MAX = 20 * 1024 * 1024;
const UPLOAD_PHOTO_MAX = 10 * 1024 * 1024;
const UPLOAD_FILE_MAX = 50 * 1024 * 1024;

type MediaKind = "photo" | "video";

export function toChannelError(error: unknown): ChannelError {
  if (error instanceof ChannelError) return error;
  if (error instanceof TelegramApiError) {
    const text = error.description.toLowerCase();
    if (error.isRateLimited) return new ChannelError("rate_limit", "Telegram cheklovi", error.retryAfter ?? 30);
    if (error.status === 401) return new ChannelError("auth", "Bot tokeni yaroqsiz");
    if (error.isForbidden || text.includes("not enough rights") || text.includes("need administrator rights") || text.includes("chat not found")) {
      return new ChannelError("permission", `Botda huquq yo'q: ${error.description}`);
    }
    if (error.status >= 500) return new ChannelError("transient", error.description);
    return new ChannelError("invalid", error.description);
  }
  return new ChannelError("transient", error instanceof Error ? error.message : String(error));
}

function chatOf(creds: ChannelCredentials): string {
  if (!creds.externalAccountId) throw new ChannelError("invalid", "Kanal ko'rsatilmagan");
  return creds.externalAccountId;
}

function sizes(post: PostVariant): number[] {
  const raw = post.options?.sizes;
  return Array.isArray(raw) ? raw.map((n) => Number(n) || 0) : [];
}

function kinds(post: PostVariant): MediaKind[] {
  const raw = post.options?.kinds;
  if (Array.isArray(raw)) return raw.map((k) => (k === "video" ? "video" : "photo"));
  const one: MediaKind = post.format === "image" ? "photo" : "video";
  return (post.mediaUrls ?? []).map(() => one);
}

function needsUpload(kind: MediaKind, size: number): boolean {
  if (!size) return false;
  const limit = kind === "photo" ? URL_PHOTO_MAX : URL_FILE_MAX;
  if (size <= limit) return false;
  if (size > (kind === "photo" ? UPLOAD_PHOTO_MAX : UPLOAD_FILE_MAX)) {
    throw new ChannelError("invalid", kind === "photo" ? "Rasm 10 MB dan katta — Telegram qabul qilmaydi" : "Video 50 MB dan katta — Telegram bot API qabul qilmaydi");
  }
  return true;
}

async function download(url: string): Promise<Buffer> {
  const response = await fetch(url);
  if (!response.ok) throw new ChannelError("transient", `Media yuklab olinmadi (${response.status})`);
  return Buffer.from(await response.arrayBuffer());
}

function fileOf(kind: MediaKind, data: Buffer, index: number) {
  return kind === "photo"
    ? { data, filename: `photo${index}.jpg`, contentType: "image/jpeg" }
    : { data, filename: `video${index}.mp4`, contentType: "video/mp4" };
}

async function sendSingle(chatId: string, kind: MediaKind, url: string, size: number, caption: string | undefined): Promise<number> {
  if (needsUpload(kind, size)) {
    const data = await download(url);
    const method = kind === "photo" ? "sendPhoto" : "sendVideo";
    const sent = await withFloodRetry(() =>
      tgUpload<{ message_id: number }>(method, { chat_id: chatId, caption, supports_streaming: kind === "video" ? "true" : undefined }, { [kind]: fileOf(kind, data, 0) })
    );
    return sent.message_id;
  }
  const options = { caption, parseMode: null } as const;
  const sent = await withFloodRetry(() => (kind === "photo" ? sendPhoto(chatId, url, options) : sendVideo(chatId, url, options)));
  return sent.message_id;
}

async function sendAlbum(chatId: string, urls: string[], kindList: MediaKind[], sizeList: number[], caption: string | undefined): Promise<number[]> {
  const items = urls.slice(0, 10).map((url, i) => ({ url, kind: kindList[i] ?? "photo", size: sizeList[i] ?? 0 }));
  const uploads = items.map((item) => needsUpload(item.kind, item.size));
  if (!uploads.some(Boolean)) {
    const sent = await withFloodRetry(() =>
      sendMediaGroup(
        chatId,
        items.map((item, i) => ({ type: item.kind, media: item.url, caption: i === 0 ? caption : undefined }))
      )
    );
    return sent.map((m) => m.message_id);
  }
  const files: Record<string, ReturnType<typeof fileOf>> = {};
  const media: Array<{ type: MediaKind; media: string; caption?: string }> = [];
  for (const [i, item] of items.entries()) {
    let ref = item.url;
    if (uploads[i]) {
      files[`f${i}`] = fileOf(item.kind, await download(item.url), i);
      ref = `attach://f${i}`;
    }
    media.push({ type: item.kind, media: ref, caption: i === 0 ? caption : undefined });
  }
  const sent = await withFloodRetry(() => tgUpload<Array<{ message_id: number }>>("sendMediaGroup", { chat_id: chatId, media }, files));
  return sent.map((m) => m.message_id);
}

/** Publish one post; returns every message id it took, in order. */
export async function publishToTelegram(chatId: string, post: PostVariant): Promise<number[]> {
  const text = (post.text ?? "").trim();
  const urls = post.mediaUrls ?? [];
  if (post.format === "text" || urls.length === 0) {
    if (!text) throw new ChannelError("invalid", "Bo'sh post");
    if (text.length > TEXT_LIMIT) throw new ChannelError("invalid", `Matn ${TEXT_LIMIT} belgidan uzun`);
    const sent = await withFloodRetry(() => sendMessage(chatId, text, { parseMode: null, disablePreview: false }));
    return [sent.message_id];
  }
  if (!["image", "video", "reel", "short", "carousel"].includes(post.format)) {
    throw new ChannelError("not_supported", `Telegram'da «${post.format}» formati yo'q`);
  }
  if (text.length > TEXT_LIMIT) throw new ChannelError("invalid", `Matn ${TEXT_LIMIT} belgidan uzun`);
  // A caption over 1024 goes as a separate message right after the media.
  const caption = text && text.length <= CAPTION_LIMIT ? text : undefined;
  const kindList = kinds(post);
  const sizeList = sizes(post);
  const ids =
    urls.length > 1
      ? await sendAlbum(chatId, urls, kindList, sizeList, caption)
      : [await sendSingle(chatId, kindList[0] ?? "photo", urls[0], sizeList[0] ?? 0, caption)];
  if (text && !caption) {
    const sent = await withFloodRetry(() => sendMessage(chatId, text, { parseMode: null, replyTo: ids[0] }));
    ids.push(sent.message_id);
  }
  return ids;
}

export function parseExternalIds(externalId: string): number[] {
  return externalId
    .split(",")
    .map((id) => Number(id))
    .filter((id) => Number.isInteger(id) && id > 0);
}

/** Edit the post's text: the caption of its first message, or the text message itself. */
export async function editTelegramPost(chatId: string, messageIds: number[], text: string, hasMedia: boolean): Promise<void> {
  const body = text.trim();
  if (!body) throw new ChannelError("invalid", "Bo'sh matn");
  try {
    if (!hasMedia) {
      await withFloodRetry(() => editMessageText(chatId, messageIds[0], body, { parseMode: null }));
    } else if (body.length <= CAPTION_LIMIT) {
      await withFloodRetry(() => editMessageCaption(chatId, messageIds[0], body));
    } else {
      throw new ChannelError("invalid", `Media ostidagi matn ${CAPTION_LIMIT} belgidan oshmasin`);
    }
  } catch (error) {
    // "message is not modified" is success.
    if (error instanceof TelegramApiError && error.description.toLowerCase().includes("not modified")) return;
    throw toChannelError(error);
  }
}

/** Delete every message of a post; true when all are gone (already deleted counts). */
export async function deleteTelegramPost(chatId: string, messageIds: number[]): Promise<boolean> {
  let ok = true;
  for (const id of messageIds) {
    try {
      await withFloodRetry(() => deleteMessage(chatId, id));
    } catch (error) {
      if (error instanceof TelegramApiError && error.description.toLowerCase().includes("message to delete not found")) continue;
      ok = false;
      if (!(error instanceof TelegramApiError)) throw error;
    }
  }
  return ok;
}

export const telegramAdapter: ChannelAdapter = {
  channel: "telegram",
  capabilities: () => capabilitiesOf("telegram"),

  async connect(creds) {
    try {
      const chat = await getChat(chatOf(creds));
      return { externalAccountId: String(chat.id), username: chat.username ?? null };
    } catch (error) {
      throw toChannelError(error);
    }
  },

  // The platform bot token does not expire.
  async refreshCredentials(creds) {
    return { accessToken: creds.accessToken, refreshToken: creds.refreshToken ?? null, expiresAt: null };
  },

  async checkCredentials(creds) {
    const botId = botIdFromToken();
    if (!botId) return { ok: false, error: "auth" };
    try {
      const member = await getChatMember(chatOf(creds), botId);
      if (member.status !== "administrator" && member.status !== "creator") return { ok: false, error: "auth" };
      if (member.status === "administrator" && member.can_post_messages !== true) return { ok: false, error: "auth" };
      return { ok: true };
    } catch (error) {
      const mapped = toChannelError(error);
      return { ok: false, error: mapped.kind === "permission" || mapped.kind === "auth" ? "auth" : mapped.message };
    }
  },

  async publish(creds, post): Promise<PublishResult> {
    try {
      const ids = await publishToTelegram(chatOf(creds), post);
      const username = typeof creds.extra?.username === "string" ? creds.extra.username : null;
      return { status: "published", externalId: ids.join(","), permalink: username ? `https://t.me/${username}/${ids[0]}` : null };
    } catch (error) {
      throw toChannelError(error);
    }
  },

  async continuePublish() {
    throw new ChannelError("not_supported", "Telegram posts publish synchronously");
  },

  async replyComment(creds, commentId, text) {
    const group = creds.extra?.linkedChatId;
    if (typeof group !== "string" || !group) throw new ChannelError("not_supported", "Kanalda muhokama guruhi yo'q");
    try {
      const sent = await withFloodRetry(() => sendMessage(group, text, { parseMode: null, replyTo: Number(commentId) }));
      return { externalId: String(sent.message_id) };
    } catch (error) {
      throw toChannelError(error);
    }
  },

  async hideComment() {
    throw new ChannelError("not_supported", "Telegram'da kommentni yashirib bo'lmaydi (faqat o'chirish)");
  },

  async sendDm(creds, _recipientId, text, threadId) {
    const dmChat = creds.extra?.dmChatId;
    if (typeof dmChat !== "string" || !dmChat || !threadId) throw new ChannelError("not_supported", "Kanal DM chati topilmadi");
    try {
      const sent = await withFloodRetry(() => sendMessage(dmChat, text, { parseMode: null, directMessagesTopicId: Number(threadId) }));
      return { externalId: String(sent.message_id) };
    } catch (error) {
      throw toChannelError(error);
    }
  },

  async privateReply() {
    throw new ChannelError("not_supported", "Telegram'da private reply yo'q");
  },

  async fetchInsights() {
    // Bot API has no view counts; MTProto is a later phase (audit "Cheklov").
    throw new ChannelError("not_supported", "Telegram statistikasi Bot API'da yo'q");
  },
};
