import { NextRequest } from "next/server";
import { listReviews, reviewsQuerySchema } from "@/lib/content/review";
import { run } from "@/lib/content/service";
import { parseBody, requireContent, respond } from "@/lib/developer/content-guard";

export const dynamic = "force-dynamic";

/** "Tasdiqlar": ?tab=mine (mendan kutilmoqda) | sent (yuborganlarim) | rejected (rad etilganlar). */
export async function GET(request: NextRequest) {
  const auth = await requireContent("view");
  if (!auth.ok) return auth.response;
  const query = parseBody(reviewsQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
  if (!query.ok) return respond(query);
  return respond(await run(() => listReviews(auth.ctx.workspaceId, auth.ctx.userId, query.data.tab)));
}
