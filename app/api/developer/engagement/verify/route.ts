import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { parseBody, readJson, requireEngagement, respond } from "@/lib/developer/engagement-guard";
import { run, verifyBodySchema, verifyDraw } from "@/lib/engagement/service";

export const dynamic = "force-dynamic";

/**
 * Pure check anyone can repeat: { seedHex, commitment?, entrants: igUserId[], winners: igUserId[], backups? }.
 * Touches no data of the workspace; the developer login is still required.
 */
export async function POST(request: NextRequest) {
  const auth = await requireEngagement("read");
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = parseBody(verifyBodySchema, body);
  if (!parsed.ok) return respond(parsed);
  const input = parsed.data;
  return respond(
    await run(async () => {
      const result = verifyDraw({
        seedHex: input.seedHex,
        commitment: input.commitment,
        entrants: input.entrants.map((igUserId) => ({ id: igUserId, igUserId })),
        winners: input.winnersCount ?? input.winners.length,
        backups: input.backupCount ?? input.backups?.length ?? 0,
        winnerIds: input.winners,
        ...(input.backups ? { backupIds: input.backups } : {}),
      });
      return { ok: result.ok, winners: result.winnerIds, backups: result.backupIds, problems: result.problems };
    })
  );
}
