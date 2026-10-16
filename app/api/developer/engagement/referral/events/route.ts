import { NextRequest } from "next/server";
import { listReferralEvents, referralEventsQuerySchema, run } from "@/lib/engagement/service";
import { parseBody, requireEngagement, respond } from "@/lib/developer/engagement-guard";

export const dynamic = "force-dynamic";

/** Referral events: ?programId= &status= &flagged=true|false &cursor= &limit= */
export async function GET(request: NextRequest) {
  const auth = await requireEngagement("read");
  if (!auth.ok) return auth.response;
  const query = parseBody(referralEventsQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
  if (!query.ok) return respond(query);
  return respond(await run(() => listReferralEvents(auth.ctx.workspaceId, query.data)));
}
