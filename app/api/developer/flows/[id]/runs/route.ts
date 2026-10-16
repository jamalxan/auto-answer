import { NextRequest } from "next/server";
import { jsonOk } from "@/lib/api-auth";
import { requireFlows, respond } from "@/lib/developer/flows-guard";
import { run } from "@/lib/flows/service";
import { listRuns } from "@/lib/flows/runs";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function GET(request: NextRequest, { params }: Props) {
  const auth = await requireFlows("read");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const q = request.nextUrl.searchParams;
  const limit = Number(q.get("limit"));
  return respond(
    await run(() =>
      listRuns(auth.ctx.workspaceId, {
        flowId: id,
        status: (q.get("status") ?? undefined) as never,
        cursor: q.get("cursor") ?? undefined,
        limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 25,
      })
    )
  );
}
