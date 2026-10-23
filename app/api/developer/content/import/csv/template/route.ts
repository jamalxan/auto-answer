import { csvTemplate } from "@/lib/content/csv";
import { prisma } from "@/lib/db/client";
import { requireContent } from "@/lib/developer/content-guard";

export const dynamic = "force-dynamic";

/** The CSV template (UTF-8 with BOM so Excel opens it right), prefilled with the first account. */
export async function GET() {
  const auth = await requireContent("view");
  if (!auth.ok) return auth.response;
  const account = await prisma.instagramAccount.findFirst({ where: { workspaceId: auth.ctx.workspaceId }, orderBy: { connectedAt: "desc" }, select: { username: true } });
  return new Response(csvTemplate(account?.username || undefined), {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": 'attachment; filename="socialauto-kontent-shablon.csv"',
      "Cache-Control": "no-store",
    },
  });
}
