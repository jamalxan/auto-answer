import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import { firstIssue, modeInputSchema, setJavobAiMode } from "@/lib/javobai/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

export async function PATCH(request: NextRequest, { params }: Props) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = modeInputSchema.safeParse(body);
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  const result = await setJavobAiMode(auth.ctx.workspaceId, id, parsed.data.mode, auth.ctx.userId);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk(result.data);
}
