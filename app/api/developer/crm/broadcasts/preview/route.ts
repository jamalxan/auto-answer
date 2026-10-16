import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { parseBody, readJson, requireCrm, respond } from "@/lib/developer/crm-guard";
import { previewAudience, previewInputSchema } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

/** Audience of an unsaved builder state: { instagramAccountId, segmentId? | audienceFilter?, frequencyCapHours? }. */
export async function POST(request: NextRequest) {
  const auth = await requireCrm("view_contacts");
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(previewInputSchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(await previewAudience(auth.ctx.workspaceId, parsed.data));
}
