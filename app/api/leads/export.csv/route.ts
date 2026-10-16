import { NextRequest, NextResponse } from "next/server";
import { jsonError, requireWorkspace } from "@/lib/api-auth";
import { prisma } from "@/lib/db/client";
import { buildLeadWhere, leadsToCsv } from "@/lib/leads/query";
import { canExportLeads } from "@/lib/workspace-permissions";

export const dynamic = "force-dynamic";

const EXPORT_LIMIT = 10_000;

export async function GET(request: NextRequest) {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  // TZ 53 export_data; legacy MEMBER keeps its pre-ETAP-5 export right (see canExportLeads).
  if (!canExportLeads(auth.ctx.role)) return jsonError("Ma'lumotlarni eksport qilishga ruxsatingiz yo'q", 403);
  const sp = request.nextUrl.searchParams;

  const leads = await prisma.lead.findMany({
    where: buildLeadWhere(auth.ctx.workspaceId, {
      status: sp.get("status"),
      source: sp.get("source"),
      account: sp.get("account"),
      from: sp.get("from"),
      to: sp.get("to"),
      q: sp.get("q"),
    }),
    orderBy: { createdAt: "desc" },
    take: EXPORT_LIMIT,
  });
  if (!leads) return jsonError("Failed", 500);

  return new NextResponse(`﻿${leadsToCsv(leads)}`, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="leads-${new Date().toISOString().slice(0, 10)}.csv"`,
    },
  });
}
