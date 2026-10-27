import { NextRequest } from "next/server";
import { jsonError, jsonOk } from "@/lib/api-auth";
import { workspaceUsage } from "@/lib/billing/limits";
import { BillingError, createCheckout, enabledProviders, listPayments } from "@/lib/billing/payments";
import { allPlans, priceUzs } from "@/lib/billing/plans";
import { prisma } from "@/lib/db/client";
import { requireDeveloper } from "@/lib/developer/access";

export const dynamic = "force-dynamic";

/** The workspace's tariff, usage against its limits, the plans with so'm prices and the payment history. */
export async function GET() {
  const auth = await requireDeveloper();
  if (!auth.ok) return auth.response;
  const workspaceId = auth.ctx.workspaceId;
  const [usage, payments, workspace] = await Promise.all([
    workspaceUsage(workspaceId),
    listPayments(workspaceId),
    prisma.workspace.findUnique({ where: { id: workspaceId }, select: { planSlug: true, planExpiresAt: true } }),
  ]);
  return jsonOk({
    usage,
    planExpiresAt: workspace?.planExpiresAt ?? null,
    plans: allPlans().map((p) => ({ ...p, priceUzs: priceUzs(p.slug) })),
    providers: enabledProviders(),
    payments,
    role: auth.ctx.role,
  });
}

/** { plan, months, provider } → { url } of the provider's payment page. */
export async function POST(request: NextRequest) {
  const auth = await requireDeveloper(true);
  if (!auth.ok) return auth.response;
  const body = (await request.json().catch(() => null)) as { plan?: unknown; months?: unknown; provider?: unknown } | null;
  try {
    const checkout = await createCheckout({
      workspaceId: auth.ctx.workspaceId,
      userId: auth.ctx.userId,
      role: auth.ctx.role,
      plan: String(body?.plan ?? ""),
      months: Number(body?.months),
      provider: String(body?.provider ?? ""),
    });
    return jsonOk(checkout);
  } catch (error) {
    if (error instanceof BillingError) return jsonError(error.message, error.status);
    throw error;
  }
}
