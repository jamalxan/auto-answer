import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { postInputSchema, postsQuerySchema } from "@/lib/content/schema";
import { createPost, listPosts, run } from "@/lib/content/service";
import { parseBody, readJson, requireContent, respond } from "@/lib/developer/content-guard";

export const dynamic = "force-dynamic";

/** Calendar / list: ?from&to&account&status&type&q&linked&page&pageSize */
export async function GET(request: NextRequest) {
  const auth = await requireContent("view");
  if (!auth.ok) return auth.response;
  const query = parseBody(postsQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
  if (!query.ok) return respond(query);
  return respond(await run(() => listPosts(auth.ctx.workspaceId, query.data)));
}

/** A new draft. */
export async function POST(request: NextRequest) {
  const auth = await requireContent("create");
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(postInputSchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(await run(() => createPost(auth.ctx.workspaceId, auth.ctx.userId, parsed.data)), 201);
}
