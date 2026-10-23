import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { Wordmark } from "@/components/logo-mark";
import { isContentSchedulerEnabled } from "@/lib/content/config";
import { ContentError } from "@/lib/content/errors";
import { getReviewByToken, type ExternalReviewView } from "@/lib/content/review";
import { formatZoned } from "@/lib/content/time";
import DecisionForm from "./decision-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = {
  title: "Postni tasdiqlash — SocialAuto",
  robots: { index: false, follow: false },
  referrer: "no-referrer",
};

type Props = { params: Promise<{ token: string }> };

const TYPE_LABEL: Record<string, string> = { FEED_IMAGE: "Post", FEED_VIDEO: "Video", CAROUSEL: "Karusel", REEL: "Reels", TRIAL_REEL: "Trial Reels", STORY: "Story" };

async function load(token: string): Promise<ExternalReviewView> {
  if (!isContentSchedulerEnabled()) notFound();
  try {
    return await getReviewByToken(token);
  } catch (error) {
    if (error instanceof ContentError && error.status === 404) notFound();
    throw error;
  }
}

/**
 * The external reviewer's page (spec §10.5, FR-A2): no session, the link
 * token is the key. A preview of the post, then Approve / Reject with a
 * comment (required to reject). Unknown, expired or voided links are 404.
 */
export default async function ReviewPage({ params }: Props) {
  const { token } = await params;
  const view = await load(token);
  const { post } = view;

  return (
    <main className="min-h-screen bg-background text-foreground">
      <div className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-6">
        <div className="mb-8">
          <Wordmark />
        </div>
        <section className="panel space-y-5 rounded-3xl p-5 sm:p-6">
          <div>
            <h1 className="display text-2xl sm:text-3xl">Postni tasdiqlang</h1>
            <p className="mt-2 text-sm text-muted">
              {TYPE_LABEL[post.type] ?? post.type} · @{post.accountUsername ?? "—"}
              {post.scheduledAt ? ` · ${formatZoned(post.scheduledAt, post.timezone)} (${post.timezone})` : ""}
            </p>
          </div>

          {post.media.length > 0 && (
            <div className="flex gap-2 overflow-x-auto pb-1">
              {post.media.map((m, i) =>
                m.thumbUrl || m.previewUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element -- signed, short-lived URL
                  <img key={i} src={(m.kind === "IMAGE" ? m.previewUrl : null) ?? m.thumbUrl ?? ""} alt={`Media ${i + 1}`} className="h-48 w-auto shrink-0 rounded-2xl object-cover sm:h-64" />
                ) : (
                  <div key={i} className="inset grid h-48 w-36 shrink-0 place-items-center text-xs text-muted">
                    {m.kind}
                  </div>
                )
              )}
            </div>
          )}

          {post.caption && (
            <div className="inset p-4">
              <p className="mb-1 text-xs font-semibold text-muted">Caption</p>
              <p className="whitespace-pre-wrap break-words text-sm">{post.caption}</p>
            </div>
          )}
          {post.firstComment && (
            <div className="inset p-4">
              <p className="mb-1 text-xs font-semibold text-muted">Birinchi komment</p>
              <p className="whitespace-pre-wrap break-words text-sm">{post.firstComment}</p>
            </div>
          )}

          <DecisionForm token={token} initial={{ state: view.state, decision: view.decision, comment: view.comment }} />

          <p className="text-xs text-muted">
            Havola {formatZoned(view.expiresAt, post.timezone)} gacha amal qiladi. Uni boshqalarga yubormang.
          </p>
        </section>
      </div>
    </main>
  );
}
