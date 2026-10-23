import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError } from "@/lib/api-auth";
import { deleteMedia, setMediaTags } from "@/lib/content/media";
import { run } from "@/lib/content/service";
import { parseBody, readJson, requireContent, respond } from "@/lib/developer/content-guard";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

const tagsSchema = z.object({ tags: z.array(z.string().trim().min(1).max(32)).max(20) });

/** Tags are the library's only "folders". */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const auth = await requireContent("create");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(tagsSchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(await run(async () => ({ updated: await setMediaTags(auth.ctx.workspaceId, id, parsed.data.tags).then(() => true) })));
}

/** Refused (409) while a live post uses the asset. */
export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const auth = await requireContent("schedule");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await run(async () => ({ deleted: await deleteMedia(auth.ctx.workspaceId, id).then(() => true) })));
}
