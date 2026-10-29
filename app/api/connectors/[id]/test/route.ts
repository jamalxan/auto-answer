import { NextRequest } from "next/server";
import { jsonError } from "@/lib/api-auth";
import { requireIntegrations, respond } from "@/lib/developer/integrations-guard";
import { testIntegration } from "@/lib/integrations2/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

/** Sends a synthetic is_test event to this integration through the real pipeline and returns the delivery. */
export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireIntegrations("write");
  if (!auth.ok) return auth.response;
  const { id } = await params;
  const text = await request.text();
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return jsonError("So'rov JSON emas", 400);
    }
  }
  return respond(await testIntegration(auth.ctx.workspaceId, id, body));
}
