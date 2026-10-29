import { NextRequest } from "next/server";
import { parseBody, readJson, requireCrm, respond } from "@/lib/developer/crm-guard";
import { scheduleBroadcast, scheduleInputSchema } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** DRAFT → SCHEDULED ({ scheduledAt? } ISO; now when omitted). */
export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireCrm("manage_campaigns", { write: true });
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = (await readJson(request)) ?? {};
  const parsed = parseBody(scheduleInputSchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(await scheduleBroadcast(auth.ctx.workspaceId, id, parsed.data));
}
