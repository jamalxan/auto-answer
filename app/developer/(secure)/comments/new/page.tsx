import Link from "next/link";
import CommentBuilder from "@/components/developer/comments/comment-builder";
import { DevBadge } from "@/components/developer/ui";
import { requireDeveloperPage } from "@/lib/developer/access";
import { listWorkspaceAccounts } from "@/lib/triggers/comment-service";
import { BUILT_IN_INTENTS } from "@/lib/triggers/keywords";

export const dynamic = "force-dynamic";

export const metadata = { title: "Yangi komment kampaniyasi (dev)", robots: { index: false } };

export default async function NewCommentCampaignPage() {
  const ctx = await requireDeveloperPage();
  const accounts = await listWorkspaceAccounts(ctx.workspaceId);

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <Link href="/developer/comments" className="text-sm text-muted hover:text-foreground">
          ← Comment Automation 2.0
        </Link>
        <div className="mt-2 flex items-center gap-2">
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">Yangi kampaniya</h1>
          <DevBadge />
        </div>
      </div>
      <CommentBuilder
        accounts={accounts}
        intents={BUILT_IN_INTENTS.map(({ key, label, examples }) => ({ key, label, examples }))}
      />
    </div>
  );
}
