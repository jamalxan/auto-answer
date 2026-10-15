import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import { recheckConnection } from "@/lib/foundation/connections";

export const dynamic = "force-dynamic";

type Props = { params: Promise<{ id: string }> };

// Manual "Qayta tekshirish": one real Graph call with the stored token. It
// writes the result (tokenStatus etc.), so it needs owner/admin.
export async function POST(_request: NextRequest, { params }: Props) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const { id } = await params;

  const checked = await recheckConnection(auth.ctx.workspaceId, id);
  if (!checked) return jsonError("Akkaunt topilmadi", 404);
  return jsonOk(checked);
}
