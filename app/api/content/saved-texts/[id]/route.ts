import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { deleteSavedText, savedTextInputSchema, updateSavedText } from "@/lib/content/saved-texts";
import { run } from "@/lib/content/service";
import { parseBody, readJson, requireContent, respond } from "@/lib/content/guard";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Ctx) {
  const auth = await requireContent("create");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(savedTextInputSchema.partial(), body);
  if (!parsed.ok) return respond(parsed);
  return respond(await run(() => updateSavedText(auth.ctx.workspaceId, id, parsed.data)));
}

export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const auth = await requireContent("create");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await run(async () => ({ deleted: await deleteSavedText(auth.ctx.workspaceId, id).then(() => true) })));
}
