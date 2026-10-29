import { NextRequest } from "next/server";
import { parseBody, requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { entriesQuerySchema, entryStatusCounts, listEntries, run } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Participants: ?status= &q= &cursor= &limit=. Also returns the per-status counters. */
export async function GET(request: NextRequest, { params }: Props) {
  const auth = await requireEngagement("read");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const query = parseBody(entriesQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
  if (!query.ok) return respond(query);
  return respond(
    await run(async () => {
      const page = await listEntries(auth.ctx.workspaceId, id, query.data);
      return { ...page, counts: await entryStatusCounts(id) };
    })
  );
}
