import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { readJson, requireCrm, respond } from "@/lib/developer/crm-guard";
import { createSegment, describeSegments, listSegments, run } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireCrm("view_contacts");
  if (!auth.ok) return auth.response;
  const segments = await listSegments(auth.ctx.workspaceId);
  const descriptions = await describeSegments(auth.ctx.workspaceId, segments);
  return jsonOk({ segments: segments.map((s) => ({ ...s, sentence: descriptions[s.id] ?? "" })) });
}

export async function POST(request: NextRequest) {
  const auth = await requireCrm("manage_campaigns", { write: true });
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  return respond(await run(() => createSegment(auth.ctx.workspaceId, body, auth.ctx.userId)), 201);
}
