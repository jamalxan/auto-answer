import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { LINK_CODE_TTL_MS, createLinkCode } from "@/lib/telegram/link-code";
import { getBotUsername, isTelegramConfigured } from "@/lib/telegram/api";

export const dynamic = "force-dynamic";

/** One-time code (10 min, stored hashed) plus the private-chat and add-to-group deep links. */
export async function POST() {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const username = getBotUsername();
  if (!isTelegramConfigured() || !username) {
    return jsonError("Telegram bot is not configured", 503, { code: "bot_not_configured" });
  }

  const code = await createLinkCode({ workspaceId: auth.ctx.workspaceId, purpose: "link", userId: auth.ctx.userId, ttlMs: LINK_CODE_TTL_MS });
  return jsonOk({
    code,
    expiresInMinutes: LINK_CODE_TTL_MS / 60_000,
    privateUrl: `https://t.me/${username}?start=${code}`,
    groupUrl: `https://t.me/${username}?startgroup=${code}`,
  });
}
