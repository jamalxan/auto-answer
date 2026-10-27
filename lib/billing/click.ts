/**
 * Click Shop API (Prepare action=0, Complete action=1), called by Click's
 * servers with a form body. Every request is signed:
 *
 *   prepare   md5(click_trans_id + service_id + SECRET + merchant_trans_id + amount + action + sign_time)
 *   complete  md5(click_trans_id + service_id + SECRET + merchant_trans_id + merchant_prepare_id + amount + action + sign_time)
 *
 * merchant_trans_id = our Payment.id; amount in so'm. Complete with Click's
 * own error < 0 means the customer's payment failed: the order is cancelled.
 */

import { createHash, timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { applyPaidPlan } from "./payments";

export const CLICK_ERRORS = {
  ok: { error: 0, error_note: "Success" },
  sign: { error: -1, error_note: "SIGN CHECK FAILED!" },
  amount: { error: -2, error_note: "Incorrect parameter amount" },
  action: { error: -3, error_note: "Action not found" },
  paid: { error: -4, error_note: "Already paid" },
  order: { error: -5, error_note: "Order does not exist" },
  transaction: { error: -6, error_note: "Transaction does not exist" },
  request: { error: -8, error_note: "Error in request from click" },
  cancelled: { error: -9, error_note: "Transaction cancelled" },
} as const;

const md5 = (s: string) => createHash("md5").update(s).digest("hex");

export function clickSign(p: Record<string, string>, secret: string): string {
  const prepareId = p.action === "1" ? (p.merchant_prepare_id ?? "") : "";
  return md5(`${p.click_trans_id}${p.service_id}${secret}${p.merchant_trans_id}${prepareId}${p.amount}${p.action}${p.sign_time}`);
}

function signOk(p: Record<string, string>): boolean {
  const secret = process.env.CLICK_SECRET_KEY?.trim() ?? "";
  if (!secret || !p.sign_string) return false;
  const given = Buffer.from(p.sign_string.toLowerCase());
  const expected = Buffer.from(clickSign(p, secret));
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Prepare / Complete → the JSON Click expects back. */
export async function handleClick(p: Record<string, string>, now = new Date()): Promise<Record<string, unknown>> {
  const echo = { click_trans_id: p.click_trans_id, merchant_trans_id: p.merchant_trans_id };
  const required = ["click_trans_id", "service_id", "merchant_trans_id", "amount", "action", "sign_time", "sign_string"];
  if (required.some((k) => !p[k])) return { ...echo, ...CLICK_ERRORS.request };
  if (!signOk(p)) return { ...echo, ...CLICK_ERRORS.sign };
  if (p.service_id !== process.env.CLICK_SERVICE_ID?.trim()) return { ...echo, ...CLICK_ERRORS.request };
  if (p.action !== "0" && p.action !== "1") return { ...echo, ...CLICK_ERRORS.action };

  const payment = await prisma.payment.findUnique({ where: { id: p.merchant_trans_id } });
  if (!payment || payment.provider !== "CLICK") return { ...echo, ...CLICK_ERRORS.order };
  if (Math.round(Number(p.amount) * 100) !== payment.amountTiyin) return { ...echo, ...CLICK_ERRORS.amount };
  if (payment.status === "PAID") return { ...echo, ...CLICK_ERRORS.paid };
  if (payment.status === "CANCELED") return { ...echo, ...CLICK_ERRORS.cancelled };

  if (p.action === "0") {
    if (payment.providerTransId && payment.providerTransId !== p.click_trans_id) return { ...echo, ...CLICK_ERRORS.cancelled };
    await prisma.payment.update({ where: { id: payment.id }, data: { providerTransId: p.click_trans_id, providerTime: now, status: "PENDING", state: 1 } });
    return { ...echo, merchant_prepare_id: payment.id, ...CLICK_ERRORS.ok };
  }

  // Complete.
  if (payment.providerTransId !== p.click_trans_id || p.merchant_prepare_id !== payment.id) return { ...echo, ...CLICK_ERRORS.transaction };
  if (Number(p.error ?? 0) < 0) {
    await prisma.payment.update({ where: { id: payment.id }, data: { status: "CANCELED", state: -1, canceledAt: now } });
    return { ...echo, merchant_confirm_id: payment.id, ...CLICK_ERRORS.cancelled };
  }
  const done = await prisma.payment.updateMany({ where: { id: payment.id, status: "PENDING" }, data: { status: "PAID", state: 2, performedAt: now } });
  if (done.count === 1) await applyPaidPlan(payment.id, now);
  return { ...echo, merchant_confirm_id: payment.id, ...CLICK_ERRORS.ok };
}
