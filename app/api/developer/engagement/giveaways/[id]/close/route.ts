import { NextRequest } from "next/server";
import { requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { closeAndCommit, run } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Yopish va commit: ACTIVE -> CLOSED, seed hash e'lon qilinadi. */
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireEngagement("winners");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await run(() => closeAndCommit(auth.ctx.workspaceId, id)));
}
