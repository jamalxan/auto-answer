import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { parseBody, readJson, requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { reviewBodySchema, reviewReferralEvent, run } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** The owner's decision on a flagged event: { decision: "APPROVE" | "REJECT", reason? } */
export async function PATCH(request: NextRequest, { params }: Props) {
  const auth = await requireEngagement("winners");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(reviewBodySchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(
    await run(async () => ({
      event: await reviewReferralEvent(auth.ctx.workspaceId, id, parsed.data.decision, auth.ctx.userId, parsed.data.reason),
    }))
  );
}
