import { NextRequest } from "next/server";
import { referralStats, referralStatsQuerySchema, run } from "@/lib/engagement/service";
import { parseBody, requireEngagement, respond } from "@/lib/developer/engagement-guard";

export const dynamic = "force-dynamic";

/** Totals and top referrers of one program: ?programId= */
export async function GET(request: NextRequest) {
  const auth = await requireEngagement("read");
  if (!auth.ok) return auth.response;
  const query = parseBody(referralStatsQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
  if (!query.ok) return respond(query);
  return respond(await run(() => referralStats(auth.ctx.workspaceId, query.data.programId)));
}
