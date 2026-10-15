import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import { firstIssue, getScoringConfig, saveScoringConfig, scoringConfigSchema } from "@/lib/javobai/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;
  return jsonOk(await getScoringConfig(auth.ctx.workspaceId));
}

export async function PUT(request: NextRequest) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = scoringConfigSchema.safeParse(body);
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  const result = await saveScoringConfig(auth.ctx.workspaceId, parsed.data);
  return jsonOk(result.data);
}
