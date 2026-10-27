/**
 * Tariff payments (audit phase 8): a checkout creates a Payment and the
 * provider's payment page URL; the provider's server callback (Payme
 * JSON-RPC, Click Shop API) moves it to PAID, and only then the plan is
 * extended. Both providers sit behind flags and stay off until their keys
 * exist (phase 9).
 *
 *   PAYME_ENABLED=1 PAYME_MERCHANT_ID PAYME_KEY [PAYME_TEST=1]
 *   CLICK_ENABLED=1 CLICK_SERVICE_ID CLICK_MERCHANT_ID CLICK_SECRET_KEY
 */

import { prisma } from "@/lib/db/client";
import { getBaseUrl } from "@/lib/env";
import { esc } from "@/lib/telegram/api";
import { notifyWorkspaceChats } from "@/lib/telegram/notify";
import { getPlan, isPlanSlug, priceUzs, type PlanSlug } from "./plans";

export const PLAN_MONTH_MS = 30 * 86_400_000;
export const ALLOWED_MONTHS = [1, 3, 6, 12] as const;
export type Provider = "PAYME" | "CLICK";

export class BillingError extends Error {
  constructor(
    readonly status: number,
    message: string
  ) {
    super(message);
  }
}

export function paymeEnabled(): boolean {
  return process.env.PAYME_ENABLED === "1" && Boolean(process.env.PAYME_MERCHANT_ID?.trim() && process.env.PAYME_KEY?.trim());
}

export function clickEnabled(): boolean {
  return process.env.CLICK_ENABLED === "1" && Boolean(process.env.CLICK_SERVICE_ID?.trim() && process.env.CLICK_MERCHANT_ID?.trim() && process.env.CLICK_SECRET_KEY?.trim());
}

export function enabledProviders(): Provider[] {
  return [...(paymeEnabled() ? (["PAYME"] as const) : []), ...(clickEnabled() ? (["CLICK"] as const) : [])];
}

export interface CheckoutInput {
  workspaceId: string;
  userId: string;
  role: string;
  plan: string;
  months: number;
  provider: string;
}

/** Owner / admin only (canManageBilling). Returns the provider page to send the browser to. */
export async function createCheckout(input: CheckoutInput): Promise<{ paymentId: string; url: string; amountUzs: number }> {
  if (input.role !== "OWNER" && input.role !== "ADMIN") throw new BillingError(403, "To'lovni faqat egasi yoki admin qiladi");
  if (!isPlanSlug(input.plan) || input.plan === "start") throw new BillingError(400, "Tarif noto'g'ri");
  if (!(ALLOWED_MONTHS as readonly number[]).includes(input.months)) throw new BillingError(400, "Muddat: 1, 3, 6 yoki 12 oy");
  const provider = input.provider === "PAYME" || input.provider === "CLICK" ? input.provider : null;
  if (!provider || !enabledProviders().includes(provider)) throw new BillingError(409, "Bu to'lov usuli hozircha yoqilmagan");
  const amountUzs = priceUzs(input.plan) * input.months;
  if (amountUzs <= 0) throw new BillingError(400, "Narx belgilanmagan");

  const payment = await prisma.payment.create({
    data: { workspaceId: input.workspaceId, plan: input.plan, months: input.months, amountTiyin: amountUzs * 100, provider, createdById: input.userId },
  });
  const back = `${getBaseUrl()}/developer/billing?payment=${payment.id}`;
  return { paymentId: payment.id, amountUzs, url: provider === "PAYME" ? paymeCheckoutUrl(payment.id, payment.amountTiyin, back) : clickCheckoutUrl(payment.id, amountUzs, back) };
}

export function paymeCheckoutUrl(paymentId: string, amountTiyin: number, returnUrl: string): string {
  const params = `m=${process.env.PAYME_MERCHANT_ID?.trim()};ac.payment_id=${paymentId};a=${amountTiyin};c=${returnUrl}`;
  const host = process.env.PAYME_TEST === "1" ? "https://checkout.test.paycom.uz" : "https://checkout.paycom.uz";
  return `${host}/${Buffer.from(params).toString("base64")}`;
}

export function clickCheckoutUrl(paymentId: string, amountUzs: number, returnUrl: string): string {
  const url = new URL("https://my.click.uz/services/pay");
  url.searchParams.set("service_id", process.env.CLICK_SERVICE_ID?.trim() ?? "");
  url.searchParams.set("merchant_id", process.env.CLICK_MERCHANT_ID?.trim() ?? "");
  url.searchParams.set("amount", String(amountUzs));
  url.searchParams.set("transaction_param", paymentId);
  url.searchParams.set("return_url", returnUrl);
  return url.toString();
}

/**
 * A payment became PAID: extend the plan. The same plan continues from its
 * current end; a different plan starts now (no proration in v1).
 */
export async function applyPaidPlan(paymentId: string, now = new Date()): Promise<void> {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment || !isPlanSlug(payment.plan)) return;
  const workspace = await prisma.workspace.findUnique({ where: { id: payment.workspaceId }, select: { planSlug: true, planExpiresAt: true } });
  if (!workspace) return;
  const continuing = workspace.planSlug === payment.plan && workspace.planExpiresAt && workspace.planExpiresAt > now;
  const from = continuing ? workspace.planExpiresAt!.getTime() : now.getTime();
  const until = new Date(from + payment.months * PLAN_MONTH_MS);
  await prisma.workspace.update({ where: { id: payment.workspaceId }, data: { planSlug: payment.plan, planExpiresAt: until } });
  const plan = getPlan(payment.plan as PlanSlug);
  await notifyWorkspaceChats(payment.workspaceId, `✅ <b>To'lov qabul qilindi</b>\n${esc(plan.name)} tarifi ${until.toISOString().slice(0, 10)} gacha faol.`).catch(() => 0);
}

/** A paid payment was refunded: take its months back (never below now → Start). */
export async function revokePaidPlan(paymentId: string, now = new Date()): Promise<void> {
  const payment = await prisma.payment.findUnique({ where: { id: paymentId } });
  if (!payment) return;
  const workspace = await prisma.workspace.findUnique({ where: { id: payment.workspaceId }, select: { planSlug: true, planExpiresAt: true } });
  if (!workspace || workspace.planSlug !== payment.plan || !workspace.planExpiresAt) return;
  const until = new Date(workspace.planExpiresAt.getTime() - payment.months * PLAN_MONTH_MS);
  await prisma.workspace.update({ where: { id: payment.workspaceId }, data: until > now ? { planExpiresAt: until } : { planSlug: "start", planExpiresAt: null } });
}

export async function listPayments(workspaceId: string) {
  return prisma.payment.findMany({ where: { workspaceId }, orderBy: { createdAt: "desc" }, take: 50, select: { id: true, plan: true, months: true, amountTiyin: true, provider: true, status: true, performedAt: true, canceledAt: true, createdAt: true } });
}
