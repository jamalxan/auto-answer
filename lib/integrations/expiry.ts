import { prisma } from "@/lib/db/client";
import { alertWorkspace } from "@/lib/telegram/notify";
import { expiryWarningDue } from "./service";

const EXPIRY_TYPES = ["AMOCRM", "BITRIX24"] as const;
const LABELS: Record<(typeof EXPIRY_TYPES)[number], string> = { AMOCRM: "amoCRM", BITRIX24: "Bitrix24" };

/**
 * Hourly: warn once at 7 and once at 1 day before an amoCRM / Bitrix24 token
 * expires (B-04, same cadence as the Instagram token warnings). Each warning
 * is an OperationalEvent (shows in Diagnostics / the error feed) plus the
 * owner's Telegram and email via alertWorkspace. An expired token needs no
 * warning: the 5-minute connection check (health.ts) flips it to BROKEN.
 */
export async function runTokenExpiryWarnings(now = new Date()): Promise<number> {
  const integrations = await prisma.integration.findMany({
    where: {
      type: { in: [...EXPIRY_TYPES] },
      status: "ACTIVE",
      tokenExpiresAt: { not: null, lte: new Date(now.getTime() + 8 * 24 * 60 * 60 * 1000) },
    },
  });

  let warned = 0;
  for (const integration of integrations) {
    const threshold = expiryWarningDue(integration.tokenExpiresAt!, integration.tokenWarnedAt, now);
    if (!threshold) continue;
    const label = LABELS[integration.type as (typeof EXPIRY_TYPES)[number]] ?? integration.type;
    const date = integration.tokenExpiresAt!.toISOString().slice(0, 10);
    await prisma.operationalEvent
      .create({
        data: {
          workspaceId: integration.workspaceId,
          source: "SYSTEM",
          level: "WARNING",
          message: `${label} tokeni ${threshold} kundan keyin tugaydi (${date}).`.slice(0, 500),
          payload: { integrationId: integration.id, type: integration.type, daysLeft: threshold },
        },
      })
      .catch(() => undefined);
    await alertWorkspace(
      integration.workspaceId,
      `${label} token ${threshold} kundan keyin tugaydi`,
      `⏳ <b>${label} tokeni ${threshold} kundan keyin tugaydi</b> (${date}).\nYangi uzoq muddatli token oling va Integratsiyalar bo'limida yangilang.`,
      `${label} tokeni ${threshold} kundan keyin (${date}) tugaydi. Integratsiyalar bo'limida yangi token kiriting.`
    );
    await prisma.integration.update({ where: { id: integration.id }, data: { tokenWarnedAt: now } });
    warned++;
  }
  return warned;
}
