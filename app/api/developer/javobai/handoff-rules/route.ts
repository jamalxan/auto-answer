import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import { createHandoffRule, firstIssue, handoffRuleSchema, listHandoffRules } from "@/lib/javobai/service";

export const dynamic = "force-dynamic";

export async function GET() {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;
  return jsonOk(await listHandoffRules(auth.ctx.workspaceId));
}

export async function POST(request: NextRequest) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;

  const body = await request.json().catch(() => null);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = handoffRuleSchema.safeParse(body);
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  const result = await createHandoffRule(auth.ctx.workspaceId, parsed.data);
  return jsonOk({ rule: result.data }, 201);
}
