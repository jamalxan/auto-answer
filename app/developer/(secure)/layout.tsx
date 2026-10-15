import DeveloperShell from "@/components/developer/developer-shell";
import { prisma } from "@/lib/db/client";
import { requireDeveloperPage } from "@/lib/developer/access";
import { navigableModules } from "@/lib/developer/modules";

// Every developer screen sits behind this: developer login + app session.
export const dynamic = "force-dynamic";

export default async function DeveloperSecureLayout({ children }: { children: React.ReactNode }) {
  const ctx = await requireDeveloperPage();
  const workspace = await prisma.workspace.findUnique({
    where: { id: ctx.workspaceId },
    select: { name: true },
  });

  const nav = [
    { href: "/developer", label: "Umumiy" },
    ...navigableModules().map((m) => ({ href: m.href!, label: m.title, etap: m.etap })),
  ];

  return (
    <DeveloperShell nav={nav} workspaceName={workspace?.name ?? ""}>
      {children}
    </DeveloperShell>
  );
}
