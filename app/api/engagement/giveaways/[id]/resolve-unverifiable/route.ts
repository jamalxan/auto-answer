import { NextRequest } from "next/server";
import { requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { resolveUnverifiable, run } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Tekshirib bo'lmaydiganlarni qabul qilish (PENDING_CHECK -> ELIGIBLE). */
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireEngagement("winners");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await run(() => resolveUnverifiable(auth.ctx.workspaceId, id, "ELIGIBLE", auth.ctx.userId)));
}
