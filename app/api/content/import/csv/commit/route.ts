import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { commitCsvImport } from "@/lib/content/csv-import";
import { csvCommitSchema } from "@/lib/content/csv-schema";
import { run } from "@/lib/content/service";
import { parseBody, readJson, requireContent, respond } from "@/lib/content/guard";

export const dynamic = "force-dynamic";

/**
 * FR-I1 commit: the file again (the server re-validates, never trusts the
 * preview) plus the row numbers the user ticked. Any ticked row that still
 * has an error refuses the whole request.
 */
export async function POST(request: NextRequest) {
  const auth = await requireContent("schedule");
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(csvCommitSchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(await run(() => commitCsvImport(auth.ctx.workspaceId, auth.ctx.userId, parsed.data.csv, parsed.data.rows)), 201);
}
