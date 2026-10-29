import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { exportEntriesCsv, getGiveaway, run } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** CSV of every participant with its checks and verdict. Permission: export_data. */
export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireEngagement("export");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const result = await run(async () => {
    await getGiveaway(auth.ctx.workspaceId, id);
    return exportEntriesCsv(auth.ctx.workspaceId, id);
  });
  if (!result.ok) return respond(result);
  const csv = typeof result.data === "string" ? result.data : "";
  if (!csv) return jsonError("Eksport bo'sh", 404);
  const stamp = new Date().toISOString().slice(0, 10);
  return new NextResponse(csv.startsWith("﻿") ? csv : `﻿${csv}`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="giveaway-ishtirokchilar-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
