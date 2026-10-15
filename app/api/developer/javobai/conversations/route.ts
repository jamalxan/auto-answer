import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import { conversationsQuerySchema, firstIssue, listConversations } from "@/lib/javobai/service";

export const dynamic = "force-dynamic";

/** ?instagramAccountId=&handoffState=&temperature=&limit= */
export async function GET(request: NextRequest) {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;

  const params = Object.fromEntries(
    [...request.nextUrl.searchParams.entries()].filter(([, value]) => value !== "")
  );
  const parsed = conversationsQuerySchema.safeParse(params);
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  return jsonOk({ conversations: await listConversations(auth.ctx.workspaceId, parsed.data) });
}
