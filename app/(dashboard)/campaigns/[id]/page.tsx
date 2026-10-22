"use client";

/**
 * Campaign Detail
 *
 * Clicking a campaign opens this read-only view: a summary of the automation
 * on the left, and Insights / Preview tabs on the right. Edit and Stop/Resume
 * live in the page header next to the campaign name.
 */

import { useEffect, useState } from "react";
import { useParams, useRouter } from "next/navigation";
import Link from "next/link";
import CampaignPreview, { type PreviewTab } from "@/components/campaign-preview";
import { useLanguage } from "@/components/language-provider";
import { Card, EmptyState, PageHeader } from "@/components/ui/page";

interface Campaign {
  id: string;
  name: string;
  postId: string | null;
  postUrl: string | null;
  pendingNextReel: boolean;
  matchAnyPost: boolean;
  keywords: string[];
  matchAnyWord: boolean;
  dmTriggerEnabled: boolean;
  dmMessage: string;
  openingDmEnabled: boolean;
  openingDmMessage: string | null;
  openingDmButtonLabel: string | null;
  linkButtonLabel: string | null;
  requireFollow: boolean;
  followPromptMessage: string | null;
  followPromptButtonLabel: string | null;
  followUpEnabled: boolean;
  followUpMessage: string | null;
  followUpDelayMinutes: number | null;
  publicReplyEnabled: boolean;
  publicReplyMessage: string | null;
  publicReplyMessages: string[];
  isActive: boolean;
  instagramAccountId: string;
  instagramAccount: { username: string };
  trackedLinks?: {
    destinationUrl: string;
    label?: string | null;
    trackedUrl?: string;
  }[];
  analytics: {
    sent: number;
    skipped: number;
    failed: number;
    clicks: number;
    ctr: number;
  };
}

type Tab = "insights" | "preview";

export default function CampaignDetailPage() {
  const router = useRouter();
  const { id } = useParams<{ id: string }>();
  const { t } = useLanguage();

  const [campaign, setCampaign] = useState<Campaign | null>(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [avatarUrl, setAvatarUrl] = useState<string | null>(null);
  const [postThumb, setPostThumb] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("insights");
  const [previewTab, setPreviewTab] = useState<PreviewTab>("dm");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    fetch("/api/automations", { cache: "no-store" })
      .then((r) => r.json())
      .then((payload) => {
        if (!payload.success) return setNotFound(true);
        const found = (payload.data as Campaign[]).find((c) => c.id === id);
        if (!found) return setNotFound(true);
        setCampaign(found);
      })
      .catch(() => setNotFound(true))
      .finally(() => setLoading(false));
  }, [id]);

  // Keyed on the account / post only: toggling the campaign must not refetch.
  const acct = campaign?.instagramAccountId ?? null;
  const postId = campaign?.postId ?? null;
  useEffect(() => {
    if (!acct) return;
    let cancelled = false;
    fetch(`/api/instagram/profile?instagramAccountId=${acct}`)
      .then((r) => r.json())
      .then((d) => {
        if (!cancelled) setAvatarUrl(d.success ? d.data.profilePictureUrl ?? null : null);
      })
      .catch(() => {
        if (!cancelled) setAvatarUrl(null);
      });

    if (postId) {
      fetch(`/api/instagram/posts?instagramAccountId=${acct}&limit=50`)
        .then((r) => r.json())
        .then((payload) => {
          if (cancelled || !payload.success) return;
          const hit = (
            payload.data as {
              id: string;
              thumbnail_url?: string;
              media_url?: string;
            }[]
          ).find((p) => p.id === postId);
          setPostThumb(hit?.thumbnail_url ?? hit?.media_url ?? null);
        })
        .catch(() => {
          if (!cancelled) setPostThumb(null);
        });
    }
    return () => {
      cancelled = true;
    };
  }, [acct, postId]);

  async function toggleActive() {
    if (!campaign) return;
    setBusy(true);
    try {
      await fetch(`/api/automations?id=${campaign.id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ isActive: !campaign.isActive }),
      });
      setCampaign({ ...campaign, isActive: !campaign.isActive });
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return <div className="panel h-64 animate-pulse rounded-3xl" />;
  }
  if (notFound || !campaign) {
    return (
      <Card>
        <EmptyState
          title={t.campaignDetail.notFound}
          action={
            <button
              onClick={() => router.push("/campaigns")}
              className="btn btn-ghost"
            >
              {t.campaignDetail.backToCampaigns}
            </button>
          }
        />
      </Card>
    );
  }

  const publicReplies =
    campaign.publicReplyMessages && campaign.publicReplyMessages.length > 0
      ? campaign.publicReplyMessages
      : campaign.publicReplyMessage
        ? [campaign.publicReplyMessage]
        : [];
  const hasLink = Boolean(campaign.trackedLinks?.[0]?.destinationUrl);
  const hasSecondLink = Boolean(campaign.trackedLinks?.[1]?.destinationUrl);

  const trigger = campaign.matchAnyPost
    ? t.campaignDetail.triggerAnyPost
    : campaign.pendingNextReel
      ? t.campaignDetail.triggerNextReel
      : t.campaignDetail.triggerSpecificPost;
  const matchText = campaign.matchAnyWord
    ? t.campaignDetail.matchAnyComment
    : campaign.keywords.join(", ") || t.campaignDetail.noKeywords;

  const metrics = [
    { label: t.campaignDetail.metricSends, value: campaign.analytics.sent },
    { label: t.campaignDetail.metricClicks, value: campaign.analytics.clicks },
    { label: t.campaignDetail.metricCtr, value: `${campaign.analytics.ctr}%` },
    { label: t.campaignDetail.metricFailed, value: campaign.analytics.failed },
  ];

  return (
    <div className="space-y-6">
      {/* The campaign name is a real heading (the top bar only says
          "Campaigns"), so it is the page title here. */}
      <PageHeader
        title={campaign.name}
        description={
          <span
            className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-semibold ${
              campaign.isActive ? "bg-lime/15 text-lime" : "bg-white/10 text-muted"
            }`}
          >
            {campaign.isActive ? t.campaignDetail.live : t.campaignDetail.paused}
          </span>
        }
        actions={
          <>
            <Link href="/campaigns" className="btn btn-sm btn-ghost">
              {t.campaignDetail.backLink}
            </Link>
            <Link href={`/campaigns/${campaign.id}/edit`} className="btn btn-sm btn-ghost">
              {t.campaignDetail.edit}
            </Link>
            <button
              onClick={toggleActive}
              disabled={busy}
              className={`btn btn-sm ${campaign.isActive ? "btn-danger" : "btn-primary"}`}
            >
              {campaign.isActive ? t.campaignDetail.stop : t.campaignDetail.resume}
            </button>
          </>
        }
      />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,340px)_1fr]">
        {/* Left: config summary */}
        <Card className="space-y-5">
          <Summary title={t.campaignDetail.sectionTrigger}>
            <div className="flex items-center gap-3">
              {postThumb ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={postThumb}
                  alt="Post"
                  className="h-14 w-14 rounded-xl object-cover"
                />
              ) : (
                <div className="inset grid h-14 w-14 place-items-center text-center text-[10px] leading-tight text-muted">
                  {campaign.matchAnyPost || campaign.pendingNextReel
                    ? t.campaignDetail.postFallbackAny
                    : t.campaignDetail.postFallbackSpecific}
                </div>
              )}
              <span className="text-sm text-white">{trigger}</span>
            </div>
          </Summary>

          <Summary title={t.campaignDetail.sectionMatch}>
            <FieldBox>{matchText}</FieldBox>
            {campaign.dmTriggerEnabled && (
              <p className="text-xs text-muted">
                {t.campaignDetail.alsoRepliesDm(
                  campaign.matchAnyWord
                    ? t.campaignDetail.dmWordsAnything
                    : t.campaignDetail.dmWordsThese
                )}
              </p>
            )}
            {publicReplies.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs font-semibold text-muted">
                  {t.campaignDetail.publicReplyLabel}
                </p>
                {publicReplies.map((m, i) => (
                  <FieldBox key={i}>{m}</FieldBox>
                ))}
              </div>
            )}
          </Summary>

          {campaign.openingDmEnabled && (
            <Summary title={t.campaignDetail.sectionOpeningDm}>
              <FieldBox>
                {campaign.openingDmMessage || t.campaignDetail.openingMessageFallback}
              </FieldBox>
              <FieldBox>{campaign.openingDmButtonLabel || t.campaignDetail.buttonFallback}</FieldBox>
            </Summary>
          )}

          {campaign.requireFollow && (
            <Summary title={t.campaignDetail.sectionFollowFirst}>
              <FieldBox>
                {campaign.followPromptMessage || t.campaignDetail.followPromptFallback}
              </FieldBox>
              <FieldBox>
                {campaign.followPromptButtonLabel || t.campaignDetail.followButtonFallback}
              </FieldBox>
            </Summary>
          )}

          <Summary title={t.campaignDetail.sectionThenDm}>
            <FieldBox>{campaign.dmMessage}</FieldBox>
            {hasLink && (
              <FieldBox>{campaign.linkButtonLabel || "Open link"}</FieldBox>
            )}
            {hasSecondLink && (
              <FieldBox>
                {campaign.trackedLinks?.[1]?.label || "Open link"}
              </FieldBox>
            )}
          </Summary>

          {hasLink && (
            <Summary title={t.campaignDetail.sectionExactLink}>
              {campaign.trackedLinks
                ?.filter((link) => link.destinationUrl)
                .map((link, i) => (
                  <div key={i} className="space-y-1">
                    <div className="inset px-4 py-3">
                      <p className="select-all break-all text-xs text-white">
                        {link.trackedUrl ?? link.destinationUrl}
                      </p>
                    </div>
                    <p className="text-xs text-muted">
                      {link.label ? `${link.label} · ` : ""}
                      {t.campaignDetail.redirectsTo}{" "}
                      <span className="break-all">{link.destinationUrl}</span>
                    </p>
                  </div>
                ))}
            </Summary>
          )}

          {campaign.followUpEnabled && campaign.followUpMessage && (
            <Summary title={t.campaignDetail.sectionFollowUp}>
              <FieldBox>{campaign.followUpMessage}</FieldBox>
              <p className="text-xs text-muted">
                {campaign.followUpDelayMinutes && campaign.followUpDelayMinutes > 0
                  ? t.campaignDetail.followUpDelayed(campaign.followUpDelayMinutes)
                  : t.campaignDetail.followUpImmediate}
              </p>
            </Summary>
          )}
        </Card>

        {/* Right: tabs */}
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            <TabButton active={tab === "insights"} onClick={() => setTab("insights")}>
              {t.campaignDetail.tabInsights}
            </TabButton>
            <TabButton active={tab === "preview"} onClick={() => setTab("preview")}>
              {t.campaignDetail.tabPreview}
            </TabButton>
          </div>

          {tab === "insights" && (
            <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
              {metrics.map((m) => (
                <div key={m.label} className="panel rounded-2xl p-4 sm:p-5">
                  <p className="break-words text-xs font-semibold leading-snug text-muted">
                    {m.label}
                  </p>
                  <p className="display mt-3 text-2xl tabular-nums text-white sm:text-[1.75rem]">
                    {m.value}
                  </p>
                </div>
              ))}
            </div>
          )}

          {tab === "preview" && (
            <div className="flex justify-center sm:justify-start">
            <CampaignPreview
              tab={previewTab}
              onTabChange={setPreviewTab}
              username={campaign.instagramAccount.username}
              avatarUrl={avatarUrl}
              postThumb={postThumb}
              caption=""
              sampleComment={campaign.matchAnyWord ? "nice!" : campaign.keywords[0] ?? "LINK"}
              dmTriggerEnabled={campaign.dmTriggerEnabled}
              publicReplyEnabled={campaign.publicReplyEnabled}
              publicReplyMessage={publicReplies[0] ?? ""}
              openingDmEnabled={campaign.openingDmEnabled}
              openingDmMessage={campaign.openingDmMessage ?? ""}
              openingDmButtonLabel={campaign.openingDmButtonLabel ?? ""}
              revealMessage={campaign.dmMessage}
              hasLink={hasLink}
              linkButtonLabel={campaign.linkButtonLabel ?? "Open link"}
              linkUrl={
                campaign.trackedLinks?.[0]?.trackedUrl ??
                campaign.trackedLinks?.[0]?.destinationUrl
              }
              hasSecondLink={hasSecondLink}
              secondLinkButtonLabel={
                campaign.trackedLinks?.[1]?.label ?? "Open link"
              }
              requireFollow={campaign.requireFollow}
              followPromptMessage={campaign.followPromptMessage ?? ""}
              followPromptButtonLabel={
                campaign.followPromptButtonLabel ?? "i'm following"
              }
              followUpEnabled={campaign.followUpEnabled ?? false}
              followUpMessage={campaign.followUpMessage ?? ""}
              followUpDelayMinutes={campaign.followUpDelayMinutes ?? 0}
            />
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function Summary({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold text-white">{title}</h2>
      {children}
    </div>
  );
}

function FieldBox({ children }: { children: React.ReactNode }) {
  return (
    <div className="inset break-words px-4 py-3 text-sm text-white">
      {children}
    </div>
  );
}

function TabButton({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={`chip ${active ? "chip-active" : ""}`}
    >
      {children}
    </button>
  );
}
