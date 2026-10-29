import { NextRequest, NextResponse } from "next/server";
import { parseBody, requireCrm, respond } from "@/lib/developer/crm-guard";
import { buildContactWhere, contactsQuerySchema, exportContactsCsv, resolveListWhere } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

/** CSV of the current list (same ?q= &segmentId= | &filter= as /contacts). Permission: export_data. */
export async function GET(request: NextRequest) {
  const auth = await requireCrm("export_data");
  if (!auth.ok) return auth.response;
  const query = parseBody(contactsQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
  if (!query.ok) return respond(query);
  const where = await resolveListWhere(auth.ctx.workspaceId, query.data);
  if (!where.ok) return respond(where);
  const csv = await exportContactsCsv(
    auth.ctx.workspaceId,
    buildContactWhere(auth.ctx.workspaceId, { where: where.data, q: query.data.q ?? null })
  );
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(`\ufeff${csv}`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="crm-kontaktlar-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
