import { prisma } from "@/lib/db/client";
import { sendEmail } from "@/lib/email";
import { TelegramApiError, isTelegramConfigured, sendMessage, type SendOptions } from "./api";

/** Active Telegram chats connected to a workspace (all Telegram integrations). */
export async function getWorkspaceChats(workspaceId: string) {
  return prisma.telegramChat.findMany({
    where: {
      active: true,
      integration: { workspaceId, type: "TELEGRAM", status: "ACTIVE" },
    },
    select: { id: true, chatId: true, integrationId: true },
  });
}

/**
 * Send a message to every connected chat of the workspace. A 403 (bot kicked or
 * blocked) deactivates that chat; 429 waits `retry_after` once. Returns the
 * number of chats that received it.
 */
export async function notifyWorkspaceChats(
  workspaceId: string,
  text: string,
  options: SendOptions = {}
): Promise<number> {
  if (!isTelegramConfigured()) return 0;
  const chats = await getWorkspaceChats(workspaceId);
  let delivered = 0;
  for (const chat of chats) {
    try {
      await sendWithRetry(chat.chatId, text, options);
      delivered++;
    } catch (error) {
      if (error instanceof TelegramApiError && error.isForbidden) {
        await prisma.telegramChat.update({
          where: { id: chat.id },
          data: { active: false },
        });
      }
    }
  }
  return delivered;
}

export async function sendWithRetry(
  chatId: string,
  text: string,
  options: SendOptions = {}
) {
  try {
    return await sendMessage(chatId, text, options);
  } catch (error) {
    if (error instanceof TelegramApiError && error.isRateLimited) {
      await new Promise((resolve) =>
        setTimeout(resolve, Math.min((error.retryAfter ?? 1) * 1000, 15_000))
      );
      return sendMessage(chatId, text, options);
    }
    throw error;
  }
}

/** Telegram to the workspace chats + email to the workspace owner. Best effort. */
export async function alertWorkspace(
  workspaceId: string,
  subject: string,
  htmlText: string,
  plainText: string
): Promise<void> {
  await notifyWorkspaceChats(workspaceId, htmlText).catch(() => 0);

  try {
    const workspace = await prisma.workspace.findUnique({
      where: { id: workspaceId },
      select: { owner: { select: { email: true } } },
    });
    const to = workspace?.owner.email;
    if (to) await sendEmail({ to, subject, text: plainText });
  } catch {
    // Email is a secondary channel; never let it fail the caller.
  }
}
