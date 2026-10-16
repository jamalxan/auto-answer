import { NextRequest, NextResponse } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { parseSequence, requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { exportDrawRecord, run } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string; seq: string }> };

/** The draw record (commitment, revealed seed, entrants hash, winners, verification line). Permission: export_data. */
export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireEngagement("export");
  if (!auth.ok) return auth.response;
  const { id, seq: rawSeq } = await params;
  const seq = parseSequence(rawSeq);
  if (seq === null) return jsonError("Qur'a raqami noto'g'ri", 400);
  const result = await run(() => exportDrawRecord(auth.ctx.workspaceId, id, seq));
  if (!result.ok) return respond(result);
  const csv = typeof result.data === "string" ? result.data : "";
  return new NextResponse(csv.startsWith("﻿") ? csv : `﻿${csv}`, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="qura-dalolatnomasi-${seq}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
