import DeveloperShell from "@/components/developer/developer-shell";
import { isAdminEmail } from "@/lib/admin";
import { auth } from "@/lib/auth";
import { requireDeveloperPage } from "@/lib/developer/access";
import { navigableModules } from "@/lib/developer/modules";

// Every developer screen sits behind this: developer login + app session.
export const dynamic = "force-dynamic";

export default async function DeveloperSecureLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireDeveloperPage();
  // ctx already carries the workspace row: no second query per RSC request.
  // The admin flag is cosmetic (shows ops notes), so a failed session read
  // must never take the whole shell down.
  const isPlatformAdmin = await auth()
    .then((session) => isAdminEmail(session?.user?.email))
    .catch(() => false);

  const nav = [
    { href: "/developer", label: "Umumiy" },
    ...navigableModules().map((m) => ({ href: m.href!, label: m.title, etap: m.etap })),
  ];

  return (
    <DeveloperShell nav={nav} workspaceName={ctx.workspace.name ?? ""} isPlatformAdmin={isPlatformAdmin}>
      {children}
    </DeveloperShell>
  );
}
