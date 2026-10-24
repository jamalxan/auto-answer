import { NextRequest } from "next/server";
import { bestTimes } from "@/lib/content/insights";
import { run } from "@/lib/content/service";
import { requireContent, respond } from "@/lib/developer/content-guard";

export const dynamic = "force-dynamic";

/** FR-S7: 7×24 scores (weekday 0 = Monday, hours in the workspace zone); cached 6 h, `?fresh=1` recomputes. */
export async function GET(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireContent("view");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const fresh = request.nextUrl.searchParams.get("fresh") === "1";
  return respond(await run(() => bestTimes(auth.ctx.workspaceId, id, { fresh })));
}
