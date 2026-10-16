import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { parseBody, readJson, requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { createGiveaway, giveawayInputSchema, giveawaysQuerySchema, listGiveaways, run } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireEngagement("read");
  if (!auth.ok) return auth.response;
  const query = parseBody(giveawaysQuerySchema, Object.fromEntries(request.nextUrl.searchParams));
  if (!query.ok) return respond(query);
  return respond(await run(async () => ({ giveaways: await listGiveaways(auth.ctx.workspaceId, query.data) })));
}

export async function POST(request: NextRequest) {
  const auth = await requireEngagement("config");
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(giveawayInputSchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(await run(async () => ({ giveaway: await createGiveaway(auth.ctx.workspaceId, parsed.data, auth.ctx.userId) })), 201);
}
