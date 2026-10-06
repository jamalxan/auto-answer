/**
 * Dev-only: long-polls Telegram and feeds updates into the same handler the
 * webhook uses, so the bot can be tried locally without a public URL.
 *   npx tsx --env-file=.env scripts/telegram-poll.ts [--link]
 * `--link` also prints a one-time deep link for the newest workspace owner.
 * Do not run while a webhook is registered (Telegram refuses getUpdates then).
 */
import { randomBytes } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { handleTelegramUpdate, type TgUpdate } from "@/lib/telegram/bot";
import { tgCall } from "@/lib/telegram/api";

async function printLink() {
  const email = process.env.TELEGRAM_DEV_OWNER_EMAIL;
  const member = await prisma.workspaceMember.findFirst({
    where: { role: "OWNER", ...(email ? { user: { email } } : {}) },
    orderBy: { createdAt: "asc" },
  });
  if (!member) return console.log("No workspace owner found in the database.");
  const code = `onb_${randomBytes(12).toString("base64url")}`;
  await prisma.telegramLinkCode.create({
    data: { code, workspaceId: member.workspaceId, purpose: "onboarding", userId: member.userId, expiresAt: new Date(Date.now() + 30 * 60_000) },
  });
  console.log(`Open: https://t.me/${process.env.TELEGRAM_BOT_USERNAME}?start=${code}`);
}

async function main() {
  await tgCall("deleteWebhook", {});
  if (process.argv.includes("--link")) await printLink();
  console.log("Polling Telegram... (Ctrl+C to stop)");
  let offset = 0;
  for (;;) {
    try {
      const updates = await tgCall<TgUpdate[]>("getUpdates", { offset, timeout: 25, allowed_updates: ["message", "callback_query", "my_chat_member"] });
      for (const update of updates) {
        offset = update.update_id + 1;
        console.log("update:", JSON.stringify(update).slice(0, 200));
        await handleTelegramUpdate(update);
      }
    } catch (error) {
      console.error("poll error:", error instanceof Error ? error.message : error);
      await new Promise((r) => setTimeout(r, 3000));
    }
  }
}
void main();
