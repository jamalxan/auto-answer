import { NextRequest } from "next/server";
import { requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { activateGiveaway, run } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Faollashtirish: DRAFT -> ACTIVE (yig'ish boshlanadi). */
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireEngagement("config");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await run(() => activateGiveaway(auth.ctx.workspaceId, id)));
}
