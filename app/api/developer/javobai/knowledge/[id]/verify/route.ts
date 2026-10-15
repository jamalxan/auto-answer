import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import { firstIssue, setKnowledgeVerified, verifyInputSchema } from "@/lib/javobai/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** `{ verified: true | false }` — only verified entries are ever shown to the AI. */
export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = verifyInputSchema.safeParse(body);
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  const result = await setKnowledgeVerified(auth.ctx.workspaceId, id, parsed.data.verified);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk({ entry: result.data });
}
