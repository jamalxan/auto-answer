import { notFound } from "next/navigation";
import CreateAutomation from "@/components/triggers/create-automation";
import { prisma } from "@/lib/db/client";
import { isTriggerDevSession } from "@/lib/triggers/access";
import { getCurrentWorkspaceContext } from "@/lib/workspace-access";

export const dynamic = "force-dynamic";

export const metadata = { title: "Automation yaratish (dev)", robots: { index: false } };

export default async function NewTriggerAutomationPage() {
  if (!(await isTriggerDevSession())) notFound();
  const ctx = await getCurrentWorkspaceContext();
  if (!ctx) notFound();

  const accounts = await prisma.instagramAccount.findMany({
    where: { workspaceId: ctx.workspaceId },
    orderBy: { connectedAt: "desc" },
    select: { id: true, username: true, tokenStatus: true },
  });
  return <CreateAutomation accounts={accounts} />;
}
