import { redirect } from "next/navigation";
import DashboardShell from "@/components/dashboard-shell";
import { auth } from "@/lib/auth";
import { prisma } from "@/lib/db/client";
import { ensureWorkspaceForUser } from "@/lib/workspace";
import { isAdminEmail } from "@/lib/admin";
import { getServerLocale } from "@/lib/i18n/get-locale";
import { dictionaries } from "@/lib/i18n/translations";

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

  const locale = await getServerLocale();
  const brokenAccounts = accounts.filter((a) => a.tokenStatus === "BROKEN");
  const banner = dictionaries[locale].assistant.tokenBanner;

  return (
    <DashboardShell
      workspaceName={workspace.name}
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
      suspendedBanner={
        workspace.isSuspended ? dictionaries[locale].workspaceSuspendedBanner : null
      }
    >
      {children}
    </DashboardShell>
  );
}
