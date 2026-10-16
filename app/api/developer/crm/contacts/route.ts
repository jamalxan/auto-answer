import { NextRequest } from "next/server";
import { jsonOk } from "@/lib/api-auth";
import { parseBody, requireCrm, respond } from "@/lib/developer/crm-guard";
import { contactsQuerySchema, listContacts, resolveListWhere } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

/** ?q= &segmentId= | &filter=<DSL JSON> &cursor= &limit= &orderBy= */
export async function GET(request: NextRequest) {
  const auth = await requireCrm("view_contacts");
  if (!auth.ok) return auth.response;
  const query = parseBody(contactsQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
  if (!query.ok) return respond(query);
  const where = await resolveListWhere(auth.ctx.workspaceId, query.data);
  if (!where.ok) return respond(where);
  const page = await listContacts(auth.ctx.workspaceId, {
    where: where.data,
    q: query.data.q ?? null,
    cursor: query.data.cursor ?? null,
    limit: query.data.limit,
    orderBy: query.data.orderBy,
  });
  return jsonOk(page);
}
