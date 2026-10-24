import { NextRequest } from "next/server";
import { accountFeed } from "@/lib/content/insights";
import { run } from "@/lib/content/service";
import { requireContent, respond } from "@/lib/developer/content-guard";

export const dynamic = "force-dynamic";

/** FR-V3: planned feed posts on top of the last 12 published (Meta, cached 10 min). */
export async function GET(_request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const auth = await requireContent("view");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await run(() => accountFeed(auth.ctx.workspaceId, id)));
}
