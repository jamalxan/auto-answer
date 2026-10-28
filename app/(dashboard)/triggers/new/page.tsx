import CreateAutomation from "@/components/triggers/create-automation";
import { requireWorkspacePage } from "@/lib/channels/guard";
import { listWorkspaceAccounts } from "@/lib/triggers/comment-service";
import { BUILT_IN_INTENTS } from "@/lib/triggers/keywords";

export const dynamic = "force-dynamic";

export const metadata = { title: "Automation yaratish", robots: { index: false } };

type Props = { searchParams: Promise<{ type?: string | string[] }> };

/** `?type=DIRECT|AD_MESSAGE|LINK|STORY_MENTION|STORY_REPLY` opens that builder directly. */
export default async function NewTriggerAutomationPage({ searchParams }: Props) {
  const ctx = await requireWorkspacePage();
  const [accounts, { type }] = await Promise.all([listWorkspaceAccounts(ctx.workspaceId), searchParams]);

  return (
    <CreateAutomation
      accounts={accounts}
      intents={BUILT_IN_INTENTS.map(({ key, label, examples }) => ({ key, label, examples }))}
      initialType={typeof type === "string" ? type : null}
    />
  );
}
