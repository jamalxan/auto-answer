import { NextRequest } from "next/server";
import { leaderboard, leaderboardQuerySchema, run } from "@/lib/engagement/service";
import { parseBody, requireEngagement, respond } from "@/lib/developer/engagement-guard";

export const dynamic = "force-dynamic";

/** ?period=7d|30d|all &limit= */
export async function GET(request: NextRequest) {
  const auth = await requireEngagement("read");
  if (!auth.ok) return auth.response;
  const query = parseBody(leaderboardQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
  if (!query.ok) return respond(query);
  return respond(await run(async () => ({ period: query.data.period, rows: await leaderboard(auth.ctx.workspaceId, query.data) })));
}
