import { notFound } from "next/navigation";
import DmCampaignDetail from "@/components/developer/dm-triggers/dm-campaign-detail";
import { requireDeveloperPage } from "@/lib/developer/access";
import { listWorkspaceAccounts } from "@/lib/triggers/comment-service";
import { getDmCampaign } from "@/lib/triggers/dm-trigger-service";
import { BUILT_IN_INTENTS } from "@/lib/triggers/keywords";

export const dynamic = "force-dynamic";

export const metadata = { title: "DM trigger (dev)", robots: { index: false } };

type Props = {
  params: Promise<{ id: string }>;
  searchParams: Promise<{ tab?: string | string[] }>;
};

export default async function DmTriggerCampaignPage({ params, searchParams }: Props) {
  const ctx = await requireDeveloperPage();
  const [{ id }, { tab }] = await Promise.all([params, searchParams]);

  const [campaign, accounts] = await Promise.all([
    getDmCampaign(ctx.workspaceId, id),
    listWorkspaceAccounts(ctx.workspaceId),
  ]);
  if (!campaign) notFound();

  return (
    <DmCampaignDetail
      key={campaign.id}
      accounts={accounts}
      intents={BUILT_IN_INTENTS.map(({ key, label, examples }) => ({ key, label, examples }))}
      initialTab={tab === "logs" ? "logs" : "settings"}
      campaign={{
        id: campaign.id,
        name: campaign.name,
        instagramAccountId: campaign.instagramAccountId,
        triggerType: campaign.triggerType === "STORY_MENTION" ? "STORY_MENTION" : "DIRECT_MESSAGE",
        matchingMode: campaign.matchingMode,
        keywords: campaign.keywords,
        intents: campaign.intents,
        audience: campaign.audience,
        reopenAfterHours: campaign.reopenAfterHours,
        cooldownHours: campaign.cooldownHours,
        sourceFilter: campaign.sourceFilter,
        adIds: campaign.adIds,
        refs: campaign.refs,
        priority: campaign.priority,
        replyMode: campaign.replyMode,
        stopOnReply: campaign.stopOnReply,
        stopOnLead: campaign.stopOnLead,
        stopOnHandoff: campaign.stopOnHandoff,
        responseMessage: campaign.responseMessage,
        active: campaign.active,
        variants: campaign.replyVariants.map((v) => ({
          id: v.id,
          kind: v.kind,
          text: v.text,
          weight: v.weight,
          source: v.source,
          approvedAt: v.approvedAt?.toISOString() ?? null,
        })),
        quickReplies: campaign.quickReplies.map((r) => ({
          id: r.id,
          label: r.label,
          action: r.action,
          responseText: r.responseText,
        })),
        followUpSteps: campaign.followUpSteps.map((s) => ({
          id: s.id,
          delayMinutes: s.delayMinutes,
          condition: s.condition,
          message: s.message,
        })),
      }}
    />
  );
}
