import CreateAutomation from "@/components/triggers/create-automation";
import { prisma } from "@/lib/db/client";
import { requireDeveloperPage } from "@/lib/developer/access";

export const dynamic = "force-dynamic";

export const metadata = { title: "Automation yaratish (dev)", robots: { index: false } };

export default async function NewTriggerAutomationPage() {
  const ctx = await requireDeveloperPage();

  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { connectedAt: "desc" },
    select: { id: true, username: true, tokenStatus: true },
  });
  return <CreateAutomation accounts={accounts} />;
}
