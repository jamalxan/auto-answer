import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { parseSequence, requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { run, verifyStoredDraw } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string; seq: string }> };

/** Recomputes a stored draw from its revealed seed (read-only, nothing is changed). */
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireEngagement("read");
  if (!auth.ok) return auth.response;
  const { id, seq: rawSeq } = await params;
  const seq = parseSequence(rawSeq);
  if (seq === null) return jsonError("Qur'a raqami noto'g'ri", 400);
  return respond(await run(() => verifyStoredDraw(auth.ctx.workspaceId, id, seq)));
}
