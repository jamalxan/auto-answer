import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { csvPreviewSchema } from "@/lib/content/csv-schema";
import { previewCsvImport } from "@/lib/content/csv-import";
import { run } from "@/lib/content/service";
import { parseBody, readJson, requireContent, respond } from "@/lib/content/guard";

export const dynamic = "force-dynamic";

/** FR-I2 preview: every row normalized with its errors; nothing is written. Body: { csv }. */
export async function POST(request: NextRequest) {
  const auth = await requireContent("schedule");
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(csvPreviewSchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(await run(() => previewCsvImport(auth.ctx.workspaceId, parsed.data.csv)));
}
