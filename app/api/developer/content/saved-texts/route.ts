import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { createSavedText, listSavedTexts, savedTextInputSchema } from "@/lib/content/saved-texts";
import { run } from "@/lib/content/service";
import { parseBody, readJson, requireContent, respond } from "@/lib/developer/content-guard";

export const dynamic = "force-dynamic";

/** Hashtag groups, signatures, caption templates. */
export async function GET() {
  const auth = await requireContent("view");
  if (!auth.ok) return auth.response;
  return respond(await run(async () => ({ items: await listSavedTexts(auth.ctx.workspaceId) })));
}

export async function POST(request: NextRequest) {
  const auth = await requireContent("create");
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(savedTextInputSchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(await run(() => createSavedText(auth.ctx.workspaceId, parsed.data)), 201);
}
