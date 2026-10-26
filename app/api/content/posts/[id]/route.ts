import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { postUpdateSchema } from "@/lib/content/schema";
import { deletePost, getPost, run, updatePost } from "@/lib/content/service";
import { parseBody, readJson, requireContent, respond } from "@/lib/content/guard";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ id: string }> };

/** One post with media, attempts and the linked campaign. */
export async function GET(_request: NextRequest, { params }: Ctx) {
  const auth = await requireContent("view");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await run(() => getPost(auth.ctx.workspaceId, id)));
}

/** Edit (optimistic lock by `version`; 409 when stale). */
export async function PATCH(request: NextRequest, { params }: Ctx) {
  const auth = await requireContent("create");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(postUpdateSchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(await run(() => updatePost(auth.ctx.workspaceId, id, parsed.data)));
}

/** Soft delete; the Instagram post, if any, stays. */
export async function DELETE(_request: NextRequest, { params }: Ctx) {
  const auth = await requireContent("schedule");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  return respond(await run(async () => ({ deleted: await deletePost(auth.ctx.workspaceId, id).then(() => true) })));
}
