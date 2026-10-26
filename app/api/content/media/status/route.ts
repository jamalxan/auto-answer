import { NextRequest } from "next/server";
import { mediaStatuses } from "@/lib/content/media";
import { run } from "@/lib/content/service";
import { requireContent, respond } from "@/lib/content/guard";

export const dynamic = "force-dynamic";

/** The upload queue's poll: ?ids=a,b,c (up to 50) → their processing state. */
export async function GET(request: NextRequest) {
  const auth = await requireContent("view");
  if (!auth.ok) return auth.response;
  const ids = (request.nextUrl.searchParams.get("ids") ?? "").split(",").map((id) => id.trim());
  return respond(await run(async () => ({ items: await mediaStatuses(auth.ctx.workspaceId, ids) })));
}
