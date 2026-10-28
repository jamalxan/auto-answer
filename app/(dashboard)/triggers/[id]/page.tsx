import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import StoryReplyBuilder from "@/components/triggers/story-reply-builder";
import { DevBadge } from "@/components/developer/ui";
import { prisma } from "@/lib/db/client";
import { automationHref, automationKind } from "@/lib/triggers/dm-trigger-service";
import { getCampaign } from "@/lib/triggers/service";
import { requireWorkspacePage } from "@/lib/channels/guard";

export const dynamic = "force-dynamic";

export const metadata = { title: "Campaign", robots: { index: false } };

type Props = { params: Promise<{ id: string }> };

export default async function EditTriggerCampaignPage({ params }: Props) {
  const ctx = await requireWorkspacePage();
  const { id } = await params;

  const [campaign, accounts] = await Promise.all([
    getCampaign(ctx.workspaceId, id),
    prisma.instagramAccount.findMany({
      where: { workspaceId: ctx.workspaceId },
      orderBy: { connectedAt: "desc" },
      select: { id: true, username: true, tokenStatus: true },
    }),
  ]);
  if (!campaign) {
    // Not a Story Reply: an older link to a Direct / mention / live campaign
    // opens its own builder instead of a 404.
    const other = await prisma.triggerCampaign.findFirst({
      where: { id, workspaceId: ctx.workspaceId },
      select: { triggerType: true, sourceFilter: true },
    });
    const kind = other && automationKind(other);
    if (kind && kind !== "STORY_REPLY") redirect(automationHref(kind, id));
    notFound();
  }

  return (
    <div className="mx-auto max-w-6xl space-y-6">
      <div>
        <Link href="/triggers?tab=campaigns" className="text-sm text-muted hover:text-foreground">
          ← Instagram Triggers
        </Link>
        <div className="mt-2 flex items-center gap-2">
          <h1 className="font-display text-2xl font-extrabold tracking-tight text-foreground">{campaign.name}</h1>
          <DevBadge />
        </div>
      </div>
      <StoryReplyBuilder
        accounts={accounts}
        campaign={{
          id: campaign.id,
          name: campaign.name,
          instagramAccountId: campaign.instagramAccountId,
          storyScope: campaign.storyScope,
          storyIds: campaign.storyIds,
          matchingMode: campaign.matchingMode,
          keywords: campaign.keywords,
          responseMessage: campaign.responseMessage,
          active: campaign.active,
        }}
      />
    </div>
  );
}
