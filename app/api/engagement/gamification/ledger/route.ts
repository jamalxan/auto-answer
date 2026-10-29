import { NextRequest } from "next/server";
import { gamificationLedgerQuerySchema, ledger, run } from "@/lib/engagement/service";
import { parseBody, requireEngagement, respond } from "@/lib/developer/engagement-guard";

export const dynamic = "force-dynamic";

/** Points ledger, newest first: ?contactId= &cursor= &limit= */
export async function GET(request: NextRequest) {
  const auth = await requireEngagement("read");
  if (!auth.ok) return auth.response;
  const query = parseBody(gamificationLedgerQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
  if (!query.ok) return respond(query);
  return respond(await run(() => ledger(auth.ctx.workspaceId, query.data)));
}
