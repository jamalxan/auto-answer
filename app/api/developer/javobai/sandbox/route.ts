import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import { firstIssue, runSandbox, sandboxInputSchema } from "@/lib/javobai/service";

export const dynamic = "force-dynamic";

/** One JavobAI turn against the account's real knowledge base. Sends and stores nothing. */
export async function POST(request: NextRequest) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = sandboxInputSchema.safeParse(body);
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  const result = await runSandbox(auth.ctx.workspaceId, parsed.data);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk(result.data);
}
