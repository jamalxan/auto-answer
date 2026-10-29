import { NextRequest } from "next/server";
import { requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { startBackfill, run } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Eski kommentlarni qayta skanerlash. */
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireEngagement("config");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await run(() => startBackfill(auth.ctx.workspaceId, id)));
}
