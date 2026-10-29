import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { parseBody, readJson, requireCrm, respond } from "@/lib/developer/crm-guard";
import { describeFilter, loadDescribeNames, previewSegment, run, segmentPreviewSchema } from "@/lib/crm/service";

export const dynamic = "force-dynamic";

/** { filter, limit? } → count + first rows + the Uzbek sentence, without saving. */
export async function POST(request: NextRequest) {
  const auth = await requireCrm("view_contacts");
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(segmentPreviewSchema, body);
  if (!parsed.ok) return respond(parsed);
  const result = await run(() => previewSegment(auth.ctx.workspaceId, parsed.data.filter, { limit: parsed.data.limit }));
  if (!result.ok) return respond(result);
  const names = await loadDescribeNames(auth.ctx.workspaceId);
  return jsonOk({ ...result.data, sentence: describeFilter(parsed.data.filter, names) });
}
