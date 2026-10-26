import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { aiCaptionInputSchema, generateCaptions } from "@/lib/content/ai-caption";
import { run } from "@/lib/content/service";
import { parseBody, readJson, requireContent, respond } from "@/lib/content/guard";

export const dynamic = "force-dynamic";

/** FR-AI1: { topic, tone, language, postType?, existingCaption? } → 3 caption variants + ≤ 15 hashtags. Nothing is saved. */
export async function POST(request: NextRequest) {
  const auth = await requireContent("create");
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(aiCaptionInputSchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(await run(() => generateCaptions(auth.ctx.workspaceId, parsed.data)));
}
