/**
 * Payme Merchant API (JSON-RPC 2.0), called by Payme's servers:
 * CheckPerformTransaction, CreateTransaction, PerformTransaction,
 * CancelTransaction, CheckTransaction, GetStatement.
 *
 * Auth: `Authorization: Basic base64("Paycom:" + PAYME_KEY)`. Account field
 * `payment_id` = our Payment.id; amounts in tiyin. A created transaction
 * expires after 12 h (reason 4). One Payment holds one Payme transaction.
 */

import { timingSafeEqual } from "node:crypto";
import { prisma } from "@/lib/db/client";
import { applyPaidPlan, revokePaidPlan } from "./payments";

export const PAYME_TIMEOUT_MS = 12 * 3600_000;

const msg = (uz: string, ru: string, en: string) => ({ uz, ru, en });

export const PAYME_ERRORS = {
  auth: { code: -32504, message: msg("Ruxsat yo'q", "Недостаточно привилегий", "Insufficient privileges") },
  method: { code: -32601, message: msg("Metod topilmadi", "Метод не найден", "Method not found") },
  parse: { code: -32700, message: msg("JSON xato", "Ошибка разбора JSON", "Parse error") },
  amount: { code: -31001, message: msg("Summa noto'g'ri", "Неверная сумма", "Incorrect amount") },
  notFound: { code: -31003, message: msg("Tranzaksiya topilmadi", "Транзакция не найдена", "Transaction not found") },
  cannotCancel: { code: -31007, message: msg("Bekor qilib bo'lmaydi", "Невозможно отменить", "Cannot cancel") },
  cannotPerform: { code: -31008, message: msg("Bajarib bo'lmaydi", "Невозможно выполнить операцию", "Cannot perform") },
  account: { code: -31050, message: msg("To'lov topilmadi", "Заказ не найден", "Order not found") },
  busy: { code: -31051, message: msg("To'lov boshqa tranzaksiyada", "Заказ ожидает оплаты другой транзакцией", "Order is pending another transaction") },
} as const;

type PaymeError = (typeof PAYME_ERRORS)[keyof typeof PAYME_ERRORS];

class RpcError extends Error {
  constructor(
    readonly error: PaymeError,
    readonly data?: string
  ) {
    super(error.message.en);
  }
}

export function paymeAuthorized(header: string | null, key = process.env.PAYME_KEY?.trim() ?? ""): boolean {
  if (!header?.startsWith("Basic ") || !key) return false;
  const given = Buffer.from(Buffer.from(header.slice(6), "base64").toString("utf8"));
  const expected = Buffer.from(`Paycom:${key}`);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

type Params = { id?: string; time?: number; amount?: number; account?: { payment_id?: string }; reason?: number; from?: number; to?: number };
type PaymentRow = NonNullable<Awaited<ReturnType<typeof prisma.payment.findUnique>>>;

const ms = (d: Date | null | undefined) => (d ? d.getTime() : 0);

async function orderFor(params: Params): Promise<PaymentRow> {
  const id = params.account?.payment_id;
  const payment = id ? await prisma.payment.findUnique({ where: { id } }) : null;
  if (!payment || payment.provider !== "PAYME") throw new RpcError(PAYME_ERRORS.account, "payment_id");
  if (payment.status === "PAID" || payment.status === "CANCELED") throw new RpcError(PAYME_ERRORS.account, "payment_id");
  if (params.amount !== payment.amountTiyin) throw new RpcError(PAYME_ERRORS.amount);
  return payment;
}

async function byTransaction(id: string | undefined): Promise<PaymentRow> {
  const payment = id ? await prisma.payment.findUnique({ where: { provider_providerTransId: { provider: "PAYME", providerTransId: id } } }) : null;
  if (!payment) throw new RpcError(PAYME_ERRORS.notFound);
  return payment;
}

const view = (p: PaymentRow) => ({
  create_time: ms(p.providerTime),
  perform_time: ms(p.performedAt),
  cancel_time: ms(p.canceledAt),
  transaction: p.id,
  state: p.state,
  reason: p.cancelReason ?? null,
});

async function cancel(p: PaymentRow, reason: number, now: Date) {
  const state = p.state === 2 ? -2 : -1;
  const updated = await prisma.payment.update({ where: { id: p.id }, data: { state, status: "CANCELED", canceledAt: now, cancelReason: reason } });
  if (state === -2) await revokePaidPlan(p.id, now);
  return updated;
}

async function dispatch(method: string, params: Params, now: Date): Promise<unknown> {
  switch (method) {
    case "CheckPerformTransaction": {
      const payment = await orderFor(params);
      if (payment.state === 1) throw new RpcError(PAYME_ERRORS.busy);
      return { allow: true };
    }
    case "CreateTransaction": {
      const existing = params.id ? await prisma.payment.findUnique({ where: { provider_providerTransId: { provider: "PAYME", providerTransId: params.id } } }) : null;
      if (existing) {
        if (existing.state !== 1) throw new RpcError(PAYME_ERRORS.cannotPerform);
        if (now.getTime() - ms(existing.providerTime) > PAYME_TIMEOUT_MS) {
          await cancel(existing, 4, now);
          throw new RpcError(PAYME_ERRORS.cannotPerform);
        }
        return { create_time: ms(existing.providerTime), transaction: existing.id, state: 1 };
      }
      const payment = await orderFor(params);
      if (payment.state === 1 && payment.providerTransId !== params.id) throw new RpcError(PAYME_ERRORS.busy);
      const claimed = await prisma.payment.updateMany({
        where: { id: payment.id, state: 0, status: "CREATED" },
        data: { providerTransId: params.id, providerTime: new Date(params.time ?? now.getTime()), state: 1, status: "PENDING" },
      });
      if (claimed.count === 0) throw new RpcError(PAYME_ERRORS.busy);
      return { create_time: params.time ?? now.getTime(), transaction: payment.id, state: 1 };
    }
    case "PerformTransaction": {
      const payment = await byTransaction(params.id);
      if (payment.state === 2) return { transaction: payment.id, perform_time: ms(payment.performedAt), state: 2 };
      if (payment.state !== 1) throw new RpcError(PAYME_ERRORS.cannotPerform);
      if (now.getTime() - ms(payment.providerTime) > PAYME_TIMEOUT_MS) {
        await cancel(payment, 4, now);
        throw new RpcError(PAYME_ERRORS.cannotPerform);
      }
      const done = await prisma.payment.updateMany({ where: { id: payment.id, state: 1 }, data: { state: 2, status: "PAID", performedAt: now } });
      if (done.count === 1) await applyPaidPlan(payment.id, now);
      const fresh = await prisma.payment.findUniqueOrThrow({ where: { id: payment.id } });
      return { transaction: fresh.id, perform_time: ms(fresh.performedAt), state: fresh.state };
    }
    case "CancelTransaction": {
      const payment = await byTransaction(params.id);
      if (payment.state < 0) return { transaction: payment.id, cancel_time: ms(payment.canceledAt), state: payment.state };
      const cancelled = await cancel(payment, params.reason ?? 0, now);
      return { transaction: cancelled.id, cancel_time: ms(cancelled.canceledAt), state: cancelled.state };
    }
    case "CheckTransaction":
      return view(await byTransaction(params.id));
    case "GetStatement": {
      const rows = await prisma.payment.findMany({
        where: { provider: "PAYME", providerTransId: { not: null }, providerTime: { gte: new Date(params.from ?? 0), lte: new Date(params.to ?? now.getTime()) } },
        orderBy: { providerTime: "asc" },
      });
      return { transactions: rows.map((p) => ({ id: p.providerTransId, time: ms(p.providerTime), amount: p.amountTiyin, account: { payment_id: p.id }, ...view(p) })) };
    }
    default:
      throw new RpcError(PAYME_ERRORS.method);
  }
}

/** One JSON-RPC request body → response body (always HTTP 200, errors inside, as Payme expects). */
export async function handlePayme(body: string, authorization: string | null, now = new Date()): Promise<Record<string, unknown>> {
  let request: { id?: unknown; method?: string; params?: Params };
  try {
    request = JSON.parse(body);
  } catch {
    return { id: null, error: PAYME_ERRORS.parse };
  }
  if (!paymeAuthorized(authorization)) return { id: request.id ?? null, error: PAYME_ERRORS.auth };
  try {
    return { id: request.id ?? null, result: await dispatch(request.method ?? "", request.params ?? {}, now) };
  } catch (error) {
    if (error instanceof RpcError) return { id: request.id ?? null, error: { ...error.error, ...(error.data ? { data: error.data } : {}) } };
    throw error;
  }
}
