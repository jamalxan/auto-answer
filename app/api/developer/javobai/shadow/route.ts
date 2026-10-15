import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import { firstIssue, listShadowTurns, shadowQuerySchema } from "@/lib/javobai/service";

export const dynamic = "force-dynamic";

/** ?cursor=&limit= */
export async function GET(request: NextRequest) {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;

  const params = Object.fromEntries(
    [...request.nextUrl.searchParams.entries()].filter(([, value]) => value !== "")
  );
  const parsed = shadowQuerySchema.safeParse(params);
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  return jsonOk(await listShadowTurns(auth.ctx.workspaceId, parsed.data));
}
