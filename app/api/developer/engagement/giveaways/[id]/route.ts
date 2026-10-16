import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { parseBody, readJson, requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { deleteGiveaway, getGiveawayDetail, giveawayPatchSchema, run, updateGiveaway } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function GET(_request: NextRequest, { params }: Props) {
  const auth = await requireEngagement("read");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await run(() => getGiveawayDetail(auth.ctx.workspaceId, id)));
}

/** DRAFT only: after activation the rules are what people entered under. */
export async function PATCH(request: NextRequest, { params }: Props) {
  const auth = await requireEngagement("config");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(giveawayPatchSchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(await run(async () => ({ giveaway: await updateGiveaway(auth.ctx.workspaceId, id, parsed.data) })));
}

export async function DELETE(_request: NextRequest, { params }: Props) {
  const auth = await requireEngagement("config");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await run(() => deleteGiveaway(auth.ctx.workspaceId, id)));
}
