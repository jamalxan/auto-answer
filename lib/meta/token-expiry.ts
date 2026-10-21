import { prisma } from "@/lib/db/client";
import { expiryWarningDue } from "@/lib/integrations/service";
import { alertWorkspace } from "@/lib/telegram/notify";

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * B-30: warn once at 7 and once at 1 day before an Instagram token expires.
 * The daily refresh cron renews tokens 10 days ahead, so a warning only
 * reaches the owner when that refresh keeps failing. Same cadence and dedup
 * (tokenWarnedAt) as the amoCRM / Bitrix24 warnings in lib/integrations/expiry.
 * A BROKEN token needs no warning: it already has its own alert.
 */
export async function runInstagramTokenExpiryWarnings(now = new Date()): Promise<number> {
  const accounts = await prisma.instagramAccount.findMany({
    where: {
      accessToken: { not: "" },
      tokenStatus: { not: "BROKEN" },
      tokenExpiresAt: { not: null, lte: new Date(now.getTime() + 8 * DAY_MS) },
    },
    select: { id: true, workspaceId: true, username: true, tokenExpiresAt: true, tokenWarnedAt: true },
  });

  let warned = 0;
  for (const account of accounts) {
    const expiresAt = account.tokenExpiresAt!;
    if (!expiryWarningDue(expiresAt, account.tokenWarnedAt, now)) continue;
    // The threshold says which warning is due; the text says the real days left.
    const daysLeft = Math.max(1, Math.ceil((expiresAt.getTime() - now.getTime()) / DAY_MS));
    const date = expiresAt.toISOString().slice(0, 10);
    await prisma.operationalEvent
      .create({
        data: {
          workspaceId: account.workspaceId,
          source: "TOKEN_REFRESH",
          level: "WARNING",
          message: `@${account.username} Instagram tokeni ${daysLeft} kundan keyin tugaydi (${date}).`.slice(0, 500),
          payload: { instagramAccountId: account.id, username: account.username, daysLeft },
        },
      })
      .catch(() => undefined);
    await alertWorkspace(
      account.workspaceId,
      `@${account.username} Instagram tokeni ${daysLeft} kundan keyin tugaydi`,
      `⏳ <b>@${account.username} Instagram tokeni ${daysLeft} kundan keyin tugaydi</b> (${date}).\nAvtomatik yangilanmadi. Akkauntni qayta ulang: Integratsiyalar bo'limi.`,
      `@${account.username} Instagram tokeni ${daysLeft} kundan keyin (${date}) tugaydi va avtomatik yangilanmadi. Akkauntni qayta ulang.`
    );
    await prisma.instagramAccount.update({ where: { id: account.id }, data: { tokenWarnedAt: now } });
    warned++;
  }
  return warned;
}
