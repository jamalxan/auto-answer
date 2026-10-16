import { requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { overview, run } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

/** Giveaway counts by status, referral events waiting for review, top 5 of the leaderboard. */
export async function GET() {
  const auth = await requireEngagement("read");
  if (!auth.ok) return auth.response;
  return respond(await run(() => overview(auth.ctx.workspaceId)));
}
