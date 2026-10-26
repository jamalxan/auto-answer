import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { BULK_ACCESS, bulkInputSchema, runBulk } from "@/lib/content/bulk";
import { run } from "@/lib/content/service";
import { parseBody, readJson, requireContent, respond } from "@/lib/content/guard";

export const dynamic = "force-dynamic";

/**
 * FR-V4 bulk actions: { ids[] (≤ 100), action: shift | pause | delete | review, … }.
 * Answers 200 with one result per id — partial failures are listed, never dropped.
 */
export async function POST(request: NextRequest) {
  // Session / kill switch first, so an anonymous caller sees 404 like any other content route.
  const gate = await requireContent("view");
  if (!gate.ok) return gate.response;
  const body = await readJson(request);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const action = (body as { action?: unknown }).action;
  const access = typeof action === "string" && action in BULK_ACCESS ? BULK_ACCESS[action as keyof typeof BULK_ACCESS] : null;
  if (!access) return jsonError("Noma'lum amal", 400);
  const auth = await requireContent(access);
  if (!auth.ok) return auth.response;
  const parsed = parseBody(bulkInputSchema, body);
  if (!parsed.ok) return respond(parsed);
  return respond(await run(() => runBulk(auth.ctx.workspaceId, auth.ctx.userId, auth.ctx.role, parsed.data)));
}
