import { jsonError, jsonOk } from "@/lib/api-auth";
import { DEFAULT_BACKFILL_DAYS, MAX_BACKFILL_DAYS, enqueueAnalyticsBackfill, hasAnalyticsQueueBackend, isAnalyticsEnabled } from "@/lib/analytics/queue";
import { requireAnalytics } from "@/lib/developer/analytics-guard";

export const dynamic = "force-dynamic";

/**
 * Recompute the last N days (default 90, at most 366) of this workspace on the
 * "analytics" worker. 202 when queued; 409 while one is already queued.
 */
export async function POST(request: Request) {
  const auth = await requireAnalytics({ manage: true });
  if (!auth.ok) return auth.response;
  if (!isAnalyticsEnabled()) return jsonError("Analitika o'chirilgan (ANALYTICS_DISABLED)", 409);
  if (!hasAnalyticsQueueBackend()) return jsonError("Navbat (Redis) sozlanmagan", 503);

  const raw = new URL(request.url).searchParams.get("days");
  const days = raw === null ? DEFAULT_BACKFILL_DAYS : Number(raw);
  if (!Number.isInteger(days) || days < 1 || days > MAX_BACKFILL_DAYS) {
    return jsonError(`days 1 dan ${MAX_BACKFILL_DAYS} gacha butun son bo'lishi kerak`, 400);
  }
  const { queued } = await enqueueAnalyticsBackfill({ workspaceId: auth.ctx.workspaceId, days, requestedBy: auth.ctx.userId });
  if (!queued) return jsonError("Qayta hisoblash allaqachon navbatda", 409);
  return jsonOk({ queued: true, days }, 202);
}
