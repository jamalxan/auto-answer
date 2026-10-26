import { NextRequest } from "next/server";
import { listMedia, mediaQuerySchema } from "@/lib/content/media";
import { run } from "@/lib/content/service";
import { parseBody, requireContent, respond } from "@/lib/content/guard";

export const dynamic = "force-dynamic";

/** The library: ?kind&tag&status&page&pageSize */
export async function GET(request: NextRequest) {
  const auth = await requireContent("view");
  if (!auth.ok) return auth.response;
  const query = parseBody(mediaQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
  if (!query.ok) return respond(query);
  return respond(await run(() => listMedia(auth.ctx.workspaceId, query.data)));
}
