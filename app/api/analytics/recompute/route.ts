import { jsonError, jsonOk } from "@/lib/api-auth";
import { rollupRange } from "@/lib/analytics/rollup";
import { isAnalyticsEnabled } from "@/lib/analytics/queue";
import { dayCount, isDayKey, todayKey } from "@/lib/analytics/time";
import { requireAnalytics } from "@/lib/developer/analytics-guard";

export const dynamic = "force-dynamic";

// A short range is recomputed inside the request; longer ones belong to /backfill.
const MAX_INLINE_DAYS = 7;

/** POST ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: today). Replaces those days' rollups right away. */
export async function POST(request: Request) {
  const auth = await requireAnalytics({ manage: true });
  if (!auth.ok) return auth.response;
  if (!isAnalyticsEnabled()) return jsonError("Analitika o'chirilgan (ANALYTICS_DISABLED)", 409);

  const search = new URL(request.url).searchParams;
  const today = todayKey();
  const from = search.get("from") ?? search.get("to") ?? today;
  const to = search.get("to") ?? from;
  if (!isDayKey(from) || !isDayKey(to) || from > to || to > today) return jsonError("Sana noto'g'ri (YYYY-MM-DD, kelajak emas)", 400);
  if (dayCount(from, to) > MAX_INLINE_DAYS) return jsonError(`Bir so'rovda ${MAX_INLINE_DAYS} kundan ko'p emas; uzoq davr uchun /backfill`, 400);

  const results = await rollupRange(auth.ctx.workspaceId, from, to);
  return jsonOk({ days: results.length, rows: results.reduce((sum, r) => sum + r.rows, 0) });
}
