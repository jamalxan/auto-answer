import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { scheduleImportedPosts } from "@/lib/content/csv-import";
import { csvScheduleSchema } from "@/lib/content/csv-schema";
import { run } from "@/lib/content/service";
import { parseBody, readJson, requireContent, respond } from "@/lib/content/guard";

export const dynamic = "force-dynamic";

/** After a commit: schedule the imported drafts whose media finished processing. Body: { postIds }. */
export async function POST(request: NextRequest) {
  const auth = await requireContent("schedule");
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(csvScheduleSchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(await run(() => scheduleImportedPosts(auth.ctx.workspaceId, parsed.data.postIds)));
}
