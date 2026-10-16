import { NextRequest } from "next/server";
import { requireMcp, respondMcp } from "@/lib/developer/mcp-guard";
import { listActions } from "@/lib/mcp/confirm";

export const dynamic = "force-dynamic";

/** The audit log of proposed / confirmed writes, newest first. ?status=&tool=&limit= */
export async function GET(request: NextRequest) {
  const auth = await requireMcp("read");
  if (!auth.ok) return auth.response;
  const q = request.nextUrl.searchParams;
  const limit = Number(q.get("limit") ?? "50");
  return respondMcp(() =>
    listActions(auth.ctx.workspaceId, { status: q.get("status") ?? undefined, tool: q.get("tool") ?? undefined, limit: Number.isFinite(limit) ? limit : 50 })
  );
}
