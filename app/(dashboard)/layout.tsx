import { redirect } from "next/navigation";
import DashboardShell from "@/components/dashboard-shell";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser } from "@/lib/workspace";
import { isAdminEmail } from "@/lib/admin";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";
import { isTelegramConfigured } from "@/lib/telegram/api";

export default async function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  const session = await auth();

  if (!session?.user?.id) {
    redirect("/login");
  }

  const workspace = await ensureWorkspaceForUser(
    session.user.id,
    session.user.email
  );
  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId: workspace.id },
    orderBy: { connectedAt: "desc" },
    select: { username: true, tokenStatus: true },
  });

  // B-27: warnings go to Telegram; with no active chat they reach nobody.
  const telegramMissing =
    accounts.length > 0 &&
    isTelegramConfigured() &&
    (await prisma.telegramChat
      .count({ where: { active: true, integration: { workspaceId: workspace.id, type: "TELEGRAM", status: "ACTIVE" } } })
      .catch(() => 1)) === 0;

  const locale = await getServerLocale();
  const brokenAccounts = accounts.filter((a) => a.tokenStatus === "BROKEN");
  const banner = dictionaries[locale].assistant.tokenBanner;

  return (
    <DashboardShell
      workspaceName={workspace.name}
      userEmail={session.user.email ?? null}
      instagramUsername={accounts[0]?.username ?? null}
      instagramAccountCount={accounts.length}
      isAdmin={isAdminEmail(session.user.email)}
      tokenBanner={
        brokenAccounts.length > 0
          ? {
              title: banner.title,
              body: banner.body(brokenAccounts.map((a) => `@${a.username}`).join(", ")),
              cta: banner.cta,
            }
          : null
      }
      telegramBanner={telegramMissing ? dictionaries[locale].assistant.telegramBanner : null}
      suspendedBanner={
        workspace.isSuspended ? dictionaries[locale].workspaceSuspendedBanner : null
      }
    >
      {children}
    </DashboardShell>
  );
}
