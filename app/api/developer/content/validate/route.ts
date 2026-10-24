import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { postInputSchema } from "@/lib/content/schema";
import { draftWarnings, run, validateDraft } from "@/lib/content/service";
import { countCaption } from "@/lib/content/text";
import { parseBody, readJson, requireContent, respond } from "@/lib/developer/content-guard";

export const dynamic = "force-dynamic";

/** The composer's live check: issues without saving anything. */
export async function POST(request: NextRequest) {
  const auth = await requireContent("create");
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(postInputSchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(
    await run(async () => ({
      issues: await validateDraft(auth.ctx.workspaceId, parsed.data),
      warnings: await draftWarnings(auth.ctx.workspaceId, parsed.data),
      caption: countCaption(parsed.data.caption ?? ""),
      firstComment: countCaption(parsed.data.firstComment ?? ""),
    }))
  );
}
