import { NextRequest } from "next/server";
import { jsonOk } from "@/lib/api-auth";
import { parseBody, requireCrm, respond } from "@/lib/developer/crm-guard";
import { loadTimeline, timelineQuerySchema } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Older timeline items: ?before=<ISO> &limit= */
export async function GET(request: NextRequest, { params }: Props) {
  const auth = await requireCrm("view_contacts");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const query = parseBody(timelineQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
  if (!query.ok) return respond(query);
  const page = await loadTimeline(auth.ctx.workspaceId, id, {
    before: query.data.before ? new Date(query.data.before) : null,
    limit: query.data.limit,
  });
  return jsonOk(page);
}
