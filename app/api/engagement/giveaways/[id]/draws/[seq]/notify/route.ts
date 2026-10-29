import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { parseSequence, requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { notifyWinners, run } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string; seq: string }> };

/** DM inside the 24h window, else one public reply; the owner always gets Telegram. */
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireEngagement("winners");
  if (!auth.ok) return auth.response;
  const { id, seq: rawSeq } = await params;
  const seq = parseSequence(rawSeq);
  if (seq === null) return jsonError("Qur'a raqami noto'g'ri", 400);
  return respond(await run(() => notifyWinners(auth.ctx.workspaceId, id, seq)));
}
