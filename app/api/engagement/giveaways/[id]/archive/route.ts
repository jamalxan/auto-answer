import { NextRequest } from "next/server";
import { requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { archiveGiveaway, run } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Arxivlash. */
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireEngagement("config");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await run(() => archiveGiveaway(auth.ctx.workspaceId, id)));
}
