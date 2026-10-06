import { prisma } from "@/lib/db/client";
import { alertWorkspace } from "@/lib/telegram/notify";
import { expiryWarningDue } from "./service";

/** Hourly: warn once at 14 and once at 3 days before an amoCRM token expires. */
export async function runTokenExpiryWarnings(now = new Date()): Promise<number> {
  const integrations = await prisma.integration.findMany({
    where: {
      type: "AMOCRM",
      status: "ACTIVE",
      tokenExpiresAt: { not: null, lte: new Date(now.getTime() + 15 * 24 * 60 * 60 * 1000) },
    },
  });

  let warned = 0;
  for (const integration of integrations) {
    const threshold = expiryWarningDue(integration.tokenExpiresAt!, integration.tokenWarnedAt, now);
    if (!threshold) continue;
    const date = integration.tokenExpiresAt!.toISOString().slice(0, 10);
    await alertWorkspace(
      integration.workspaceId,
      `amoCRM token ${threshold} kundan keyin tugaydi`,
      `⏳ <b>amoCRM tokeni ${threshold} kundan keyin tugaydi</b> (${date}).\nYangi uzoq muddatli token oling va Integratsiyalar bo'limida yangilang.`,
      `amoCRM tokeni ${threshold} kundan keyin (${date}) tugaydi. Integratsiyalar bo'limida yangi token kiriting.`
    );
    await prisma.integration.update({ where: { id: integration.id }, data: { tokenWarnedAt: now } });
    warned++;
  }
  return warned;
}
