import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { isContentSchedulerEnabled } from "@/lib/content/config";
import { decideByToken, getReviewByToken, reviewDecisionSchema } from "@/lib/content/review";
import { run } from "@/lib/content/service";
import { parseBody, readJson, respond } from "@/lib/developer/content-guard";

export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ token: string }> };

/**
 * The external reviewer (spec §5.7 FR-A2, §12): no session — the 32-byte
 * link token is the credential. Unknown, expired or voided (the post was
 * edited) tokens answer 404, exactly like a missing route.
 */
export async function GET(_request: NextRequest, { params }: Ctx) {
  if (!isContentSchedulerEnabled()) return jsonError("Not found", 404);
  const { token } = await params;
  return privateResponse(respond(await run(() => getReviewByToken(token))));
}

export async function POST(request: NextRequest, { params }: Ctx) {
  if (!isContentSchedulerEnabled()) return jsonError("Not found", 404);
  const { token } = await params;
  const parsed = parseBody(reviewDecisionSchema, await readJson(request));
  if (!parsed.ok) return respond(parsed);
  return privateResponse(respond(await run(() => decideByToken(token, parsed.data))));
}

function privateResponse<T extends Response>(res: T): T {
  res.headers.set("Cache-Control", "no-store");
  res.headers.set("X-Robots-Tag", "noindex, nofollow");
  return res;
}
