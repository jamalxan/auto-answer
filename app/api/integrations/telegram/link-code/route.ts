import { randomBytes } from "node:crypto";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { getBotUsername, isTelegramConfigured } from "@/lib/telegram/api";

export const dynamic = "force-dynamic";

const LINK_CODE_TTL_MS = 15 * 60_000;

/** One-time code (15 min) plus the private-chat and add-to-group deep links. */
export async function POST() {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const username = getBotUsername();
  if (!isTelegramConfigured() || !username) {
    return jsonError("Telegram bot is not configured", 503, { code: "bot_not_configured" });
  }

  const code = randomBytes(12).toString("base64url");
  await prisma.telegramLinkCode.create({
    data: {
      code,
      workspaceId: auth.ctx.workspaceId,
      purpose: "link",
      userId: auth.ctx.userId,
      expiresAt: new Date(Date.now() + LINK_CODE_TTL_MS),
    },
  });
  return jsonOk({
    code,
    expiresInMinutes: 15,
    privateUrl: `https://t.me/${username}?start=${code}`,
    groupUrl: `https://t.me/${username}?startgroup=${code}`,
  });
}
