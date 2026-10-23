import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { presignInputSchema, presignUpload } from "@/lib/content/media";
import { run } from "@/lib/content/service";
import { parseBody, readJson, requireContent, respond } from "@/lib/developer/content-guard";

export const dynamic = "force-dynamic";

/** Step 1 of an upload: the browser PUTs the file straight to the bucket. */
export async function POST(request: NextRequest) {
  const auth = await requireContent("create");
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(presignInputSchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(await run(() => presignUpload(auth.ctx.workspaceId, auth.ctx.userId, parsed.data)), 201);
}
