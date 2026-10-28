import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireWorkspace } from "@/lib/channels/guard";
import { firstIssue, setConversationTemperature, temperatureInputSchema } from "@/lib/javobai/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** `{ temperature: "CUSTOMER" | "LOST" }` — an operator decision, never the score's. */
export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireWorkspace(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const body = await request.json().catch(() => null);
  if (!body) return jsonError("So'rov JSON emas", 400);
  const parsed = temperatureInputSchema.safeParse(body);
  if (!parsed.success) return jsonError(firstIssue(parsed.error), 400);

  const result = await setConversationTemperature(auth.ctx.workspaceId, id, parsed.data.temperature);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk(result.data);
}
