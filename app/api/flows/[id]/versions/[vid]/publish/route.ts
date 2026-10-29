import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireFlows, respond } from "@/lib/developer/flows-guard";
import { publishVersion, run } from "@/lib/flows/service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string; vid: string }> };

export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireFlows("write");
  if (!auth.ok) return auth.response;
  const { id, vid } = await params;
  // The body is optional (defaults apply); a malformed one is a 400.
  const text = await request.text();
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return jsonError("So'rov JSON emas", 400);
    }
  }
  return respond(await run(() => publishVersion(auth.ctx.workspaceId, id, vid, body, auth.ctx.userId)));
}
