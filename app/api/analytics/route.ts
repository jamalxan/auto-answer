import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireAnalytics } from "@/lib/developer/analytics-guard";
import { parseReadQuery, readAnalytics } from "@/lib/analytics/read";

export const dynamic = "force-dynamic";

/**
 * Analytics from the daily rollups: ?tab=campaign|ai|sales|funnel &from &to
 * &preset=today|7d|30d|custom &accountId &dim &compare=none|previous|custom|dim|ai_human
 * &compareFrom &compareTo &dimA &dimB &mode=period|cohort. Days are Asia/Tashkent.
 */
export async function GET(request: Request) {
  const auth = await requireAnalytics();
  if (!auth.ok) return auth.response;
  const parsed = parseReadQuery(new URL(request.url).searchParams);
  if (!parsed.ok) return jsonError(parsed.error, 400);
  const result = await readAnalytics(auth.ctx.workspaceId, parsed.params);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk(result.data);
}
