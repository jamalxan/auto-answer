import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { run } from "@/lib/content/service";
import { listSlots, replaceSlots, slotsInputSchema } from "@/lib/content/slots";
import { parseBody, readJson, requireContent, respond } from "@/lib/developer/content-guard";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** FR-S9: the account's weekly posting slots (weekday 0 = Monday, minuteOfDay in the workspace zone). */
export async function GET(_request: NextRequest, { params }: Ctx) {
  const auth = await requireContent("view");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await run(() => listSlots(auth.ctx.workspaceId, id)));
}

/** Replaces the whole weekly set. */
export async function PUT(request: NextRequest, { params }: Ctx) {
  const auth = await requireContent("schedule");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(slotsInputSchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(await run(() => replaceSlots(auth.ctx.workspaceId, id, parsed.data.slots)));
}
