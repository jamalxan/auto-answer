/**
 * Thin Telegram Bot API client over fetch.
 *
 * One platform-wide bot (TELEGRAM_BOT_TOKEN) serves lead delivery and the
 * owner onboarding Q&A. We deliberately avoid a framework: the bot runs on
 * webhooks inside the Next.js app, state lives in Postgres/Redis.
 */

export class TelegramApiError extends Error {
  constructor(
    public method: string,
    public status: number,
    public description: string,
    public retryAfter?: number
  ) {
    super(`Telegram ${method} failed: ${status} ${description}`);
    this.name = "TelegramApiError";
  }

  /** Bot was kicked from the group / user blocked the bot. */
  get isForbidden() {
    return this.status === 403;
  }

  get isRateLimited() {
    return this.status === 429;
  }
}

export function getBotToken(): string {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) throw new Error("TELEGRAM_BOT_TOKEN environment variable is required");
  return token;
}

export function getBotUsername(): string | null {
  return process.env.TELEGRAM_BOT_USERNAME?.replace(/^@/, "") ?? null;
}

export function isTelegramConfigured(): boolean {
  return Boolean(process.env.TELEGRAM_BOT_TOKEN);
}

export async function tgCall<T = unknown>(
  method: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const response = await fetch(
    `https://api.telegram.org/bot${getBotToken()}/${method}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(params),
    }
  );

  let data: {
    ok?: boolean;
    result?: T;
    description?: string;
    error_code?: number;
    parameters?: { retry_after?: number };
  } = {};
  try {
    data = await response.json();
  } catch {
    // fall through with an empty body
  }

  if (!response.ok || !data.ok) {
    throw new TelegramApiError(
      method,
      data.error_code ?? response.status,
      data.description ?? "unknown error",
      data.parameters?.retry_after
    );
  }

  return data.result as T;
}

export interface InlineButton {
  text: string;
  callback_data?: string;
  url?: string;
}

export type InlineKeyboard = InlineButton[][];

export interface SendOptions {
  keyboard?: InlineKeyboard;
  replyKeyboard?: string[][];
  removeReplyKeyboard?: boolean;
  parseMode?: "HTML" | null;
  disablePreview?: boolean;
}

function buildMarkup(options: SendOptions) {
  if (options.keyboard) return { inline_keyboard: options.keyboard };
  if (options.replyKeyboard) {
    return {
      keyboard: options.replyKeyboard.map((row) => row.map((text) => ({ text }))),
      resize_keyboard: true,
    };
  }
  if (options.removeReplyKeyboard) return { remove_keyboard: true };
  return undefined;
}

export async function sendMessage(
  chatId: string | number,
  text: string,
  options: SendOptions = {}
): Promise<{ message_id: number }> {
  return tgCall("sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: options.parseMode === null ? undefined : "HTML",
    disable_web_page_preview: options.disablePreview ?? true,
    reply_markup: buildMarkup(options),
  });
}

export async function editMessageText(
  chatId: string | number,
  messageId: number,
  text: string,
  options: SendOptions = {}
) {
  return tgCall("editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: options.parseMode === null ? undefined : "HTML",
    disable_web_page_preview: options.disablePreview ?? true,
    reply_markup: options.keyboard ? { inline_keyboard: options.keyboard } : undefined,
  });
}

export async function editMessageReplyMarkup(
  chatId: string | number,
  messageId: number,
  keyboard: InlineKeyboard
) {
  return tgCall("editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: { inline_keyboard: keyboard },
  });
}

export async function answerCallbackQuery(id: string, text?: string) {
  return tgCall("answerCallbackQuery", { callback_query_id: id, text });
}

export async function getFileInfo(fileId: string) {
  return tgCall<{ file_id: string; file_path?: string; file_size?: number }>(
    "getFile",
    { file_id: fileId }
  );
}

export async function downloadFile(filePath: string): Promise<Buffer> {
  const response = await fetch(
    `https://api.telegram.org/file/bot${getBotToken()}/${filePath}`
  );
  if (!response.ok) {
    throw new TelegramApiError("downloadFile", response.status, "download failed");
  }
  return Buffer.from(await response.arrayBuffer());
}

export async function setWebhook(url: string, secretToken: string) {
  return tgCall("setWebhook", {
    url,
    secret_token: secretToken,
    allowed_updates: ["message", "callback_query", "my_chat_member"],
  });
}

/** Escape text for Telegram HTML parse mode. */
export function esc(value: string | null | undefined): string {
  return (value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
