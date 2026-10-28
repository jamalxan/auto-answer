import Link from "next/link";
import CommentBuilder from "@/components/developer/comments/comment-builder";
import { DevBadge } from "@/components/developer/ui";
import { requireWorkspacePage } from "@/lib/channels/guard";
import { listWorkspaceAccounts } from "@/lib/triggers/comment-service";
import { BUILT_IN_INTENTS } from "@/lib/triggers/keywords";

export const dynamic = "force-dynamic";

export const metadata = { title: "Yangi komment kampaniyasi", robots: { index: false } };

type Props = { searchParams: Promise<{ source?: string | string[] }> };

/** `?source=live` opens the builder on "Live efir kommentlari" (linked from the triggers home). */
export default async function NewCommentCampaignPage({ searchParams }: Props) {
  const ctx = await requireWorkspacePage();
  const [accounts, { source }] = await Promise.all([listWorkspaceAccounts(ctx.workspaceId), searchParams]);
  const live = source === "live";

  return (
    <div className="mx-auto max-w-6xl space-y-5">
      <div>
        <Link href={live ? "/triggers" : "/comments"} className="text-sm text-muted hover:text-foreground">
          {live ? "← Instagram Triggers" : "← Comment Automation 2.0"}
        </Link>
        <div className="mt-2 flex items-center gap-2">
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">
            {live ? "Yangi Live komment kampaniyasi" : "Yangi kampaniya"}
          </h1>
          <DevBadge />
        </div>
      </div>
      <CommentBuilder
        accounts={accounts}
        intents={BUILT_IN_INTENTS.map(({ key, label, examples }) => ({ key, label, examples }))}
        initialSource={live ? "LIVE_COMMENT" : "COMMENT"}
      />
    </div>
  );
}
