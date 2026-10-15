import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import { setDmVariantApproved } from "@/lib/triggers/dm-trigger-service";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

const schema = z.object({ approved: z.boolean().default(true) });

/** Approve (or withdraw approval of) one variant of a Direct / Story Mention campaign. */
export async function POST(request: NextRequest, { params }: Props) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  // An empty body means "approve".
  const text = await request.text().catch(() => "");
  let body: unknown = {};
  if (text.trim()) {
    try {
      body = JSON.parse(text);
    } catch {
      return jsonError("So'rov JSON emas", 400);
    }
  }
  const parsed = schema.safeParse(body);
  if (!parsed.success) return jsonError("approved: true yoki false bo'lishi kerak", 400);

  const result = await setDmVariantApproved(auth.ctx.workspaceId, id, parsed.data.approved);
  if (!result.ok) return jsonError(result.error, result.status);
  return jsonOk({ variant: result.data });
}
