import { NextRequest } from "next/server";
import { requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { drawGiveaway, run } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Qur'a: seed ochiladi, g'oliblar tanlanadi. */
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireEngagement("winners");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await run(() => drawGiveaway(auth.ctx.workspaceId, id)));
}
