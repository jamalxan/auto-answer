import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { requireDeveloper } from "@/lib/developer/access";
import { deleteTestData, findTestData } from "@/lib/ops/test-data";

export const dynamic = "force-dynamic";

/** Test objects of the workspace (TEST… campaigns / draft flows, test leads). */
export async function GET() {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;
  return jsonOk({ items: await findTestData(auth.ctx.workspaceId) });
}

/** { items: [{ kind, id }] } — deletes only those that still match the test rules. */
export async function DELETE(request: NextRequest) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as { items?: unknown } | null;
  const items = Array.isArray(body?.items)
    ? body.items.filter((i): i is { kind: string; id: string } => typeof i === "object" && i !== null && typeof (i as { id?: unknown }).id === "string" && typeof (i as { kind?: unknown }).kind === "string")
    : [];
  if (items.length === 0) return jsonError("O'chiriladigan narsa tanlanmagan", 400);
  return jsonOk(await deleteTestData(auth.ctx.workspaceId, items));
}
