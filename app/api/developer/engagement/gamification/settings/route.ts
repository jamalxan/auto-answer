import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { readJson, requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { getSettings, run, saveSettings } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireEngagement("read");
  if (!auth.ok) return auth.response;
  return respond(await run(() => getSettings(auth.ctx.workspaceId)));
}

/** { pointsRules: { reason: { points, enabled } }, badgeRules: [{ key, name, threshold }] } — the engine validates (422). */
export async function PUT(request: NextRequest) {
  const auth = await requireEngagement("config");
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  return respond(await run(() => saveSettings(auth.ctx.workspaceId, body)));
}
