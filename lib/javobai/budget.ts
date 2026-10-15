/**
 * Per-workspace AI budget (ETAP 4.4, TZ §66 "usage alerts").
 *
 * `AiBudget` holds a soft monthly USD limit (alerts at 50 / 80 / 100 %) and an
 * optional hard limit (JavobAI stops calling models until the next month).
 * "Month" is the Tashkent calendar month, see lib/javobai/usage.ts. The spend
 * counted against the budget is the workspace's WHOLE AI spend for the month
 * (JavobAI + production assistant) — it is one AI bill for the customer; only
 * JavobAI enforces it (production keeps its own conversation caps).
 *
 * Alert stamps (`alerted50At` …) belong to the period in `periodStart`; when
 * the Tashkent month rolls over, `runBudgetAlerts` moves `periodStart` forward
 * and clears the stamps, so each threshold fires once per month.
 */

import { prisma } from "@/lib/db/client";
import { alertWorkspace } from "@/lib/telegram/notify";
import { monthlyUsage, roundUsd, tashkentMonthStart, toUsd } from "./usage";

export const BUDGET_THRESHOLDS = [50, 80, 100] as const;
export type BudgetThreshold = (typeof BUDGET_THRESHOLDS)[number];

export type BudgetStatus = "ok" | "soft_exceeded" | "hard_exceeded";

/** Uzbek reason JavobAI shows internally (handoff reason / event payload) when the hard limit is hit. */
export const BUDGET_HARD_EXCEEDED_REASON = "AI oylik byudjeti tugadi";

export interface Budget {
  workspaceId: string;
  monthlyUsdSoft: number;
  monthlyUsdHard: number | null;
  alerted50At: Date | null;
  alerted80At: Date | null;
  alerted100At: Date | null;
  periodStart: Date;
  updatedAt: Date;
}

export interface BudgetInput {
  /** Numbers, or the raw strings of a form; "" counts as "not set" for the hard limit. */
  monthlyUsdSoft: number | string;
  monthlyUsdHard?: number | string | null;
}

export interface BudgetCheck {
  status: BudgetStatus;
  /** Whole-workspace AI spend this Tashkent month. */
  usedUsd: number;
  javobAiUsd: number;
  productionUsd: number;
  /** null when the workspace has no budget. */
  softUsd: number | null;
  hardUsd: number | null;
  /** usedUsd / softUsd in percent, 0 without a budget. */
  pct: number;
  periodStart: Date;
}

export interface BudgetGate {
  allowed: boolean;
  status: BudgetStatus;
  /** True when the soft limit is exceeded: the call may go ahead on the cheap path (lib/javobai/routing.ts). */
  flagged: boolean;
  reason?: string;
  check: BudgetCheck | null;
}

type BudgetRow = {
  workspaceId: string;
  monthlyUsdSoft: unknown;
  monthlyUsdHard: unknown;
  alerted50At: Date | null;
  alerted80At: Date | null;
  alerted100At: Date | null;
  periodStart: Date;
  updatedAt: Date;
};

function toBudget(row: BudgetRow): Budget {
  return {
    workspaceId: row.workspaceId,
    monthlyUsdSoft: toUsd(row.monthlyUsdSoft),
    monthlyUsdHard: row.monthlyUsdHard === null || row.monthlyUsdHard === undefined ? null : toUsd(row.monthlyUsdHard),
    alerted50At: row.alerted50At ?? null,
    alerted80At: row.alerted80At ?? null,
    alerted100At: row.alerted100At ?? null,
    periodStart: row.periodStart,
    updatedAt: row.updatedAt,
  };
}

// ─── CRUD ─────────────────────────────────────────────────────────────────────

export async function getBudget(workspaceId: string): Promise<Budget | null> {
  const row = await prisma.aiBudget.findUnique({ where: { workspaceId } });
  return row ? toBudget(row as unknown as BudgetRow) : null;
}

export class BudgetValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BudgetValidationError";
  }
}

/** soft > 0; hard is null (no hard stop) or ≥ soft. Two decimals, like the column. */
export function validateBudgetInput(input: BudgetInput): { monthlyUsdSoft: number; monthlyUsdHard: number | null } {
  const soft = Number(input.monthlyUsdSoft);
  if (!Number.isFinite(soft) || soft <= 0) {
    throw new BudgetValidationError("Oylik byudjet (soft) 0 dan katta bo'lishi kerak");
  }
  if (soft > 1_000_000) throw new BudgetValidationError("Oylik byudjet juda katta");
  const rawHard = input.monthlyUsdHard;
  let hard: number | null = null;
  if (rawHard !== null && rawHard !== undefined && !(typeof rawHard === "string" && rawHard.trim() === "")) {
    hard = Number(rawHard);
    if (!Number.isFinite(hard) || hard <= 0) {
      throw new BudgetValidationError("Qattiq limit (hard) 0 dan katta bo'lishi yoki bo'sh bo'lishi kerak");
    }
    if (hard > 1_000_000) throw new BudgetValidationError("Qattiq limit juda katta");
  }
  const softRounded = Math.round(soft * 100) / 100;
  const hardRounded = hard === null ? null : Math.round(hard * 100) / 100;
  if (hardRounded !== null && hardRounded < softRounded) {
    throw new BudgetValidationError("Qattiq limit (hard) soft byudjetdan kichik bo'lmasligi kerak");
  }
  return { monthlyUsdSoft: softRounded, monthlyUsdHard: hardRounded };
}

/** Create or update the workspace budget. Throws BudgetValidationError on bad input. */
export async function saveBudget(workspaceId: string, input: BudgetInput, now: Date = new Date()): Promise<Budget> {
  const data = validateBudgetInput(input);
  const row = await prisma.aiBudget.upsert({
    where: { workspaceId },
    create: {
      workspaceId,
      ...data,
      periodStart: tashkentMonthStart(now),
      alerted50At: null,
      alerted80At: null,
      alerted100At: null,
    },
    update: data,
  });
  return toBudget(row as unknown as BudgetRow);
}

export async function deleteBudget(workspaceId: string): Promise<boolean> {
  const { count } = await prisma.aiBudget.deleteMany({ where: { workspaceId } });
  return count > 0;
}

// ─── Status ───────────────────────────────────────────────────────────────────

export function budgetStatusFor(usedUsd: number, softUsd: number | null, hardUsd: number | null): BudgetStatus {
  if (softUsd === null || softUsd <= 0) return "ok";
  if (hardUsd !== null && hardUsd > 0 && usedUsd >= hardUsd) return "hard_exceeded";
  if (usedUsd >= softUsd) return "soft_exceeded";
  return "ok";
}

export function budgetPct(usedUsd: number, softUsd: number | null): number {
  if (softUsd === null || softUsd <= 0) return 0;
  return Math.round((usedUsd / softUsd) * 1000) / 10;
}

/** Month-to-date spend against the workspace budget (budget-less workspaces are always "ok"). */
export async function checkBudget(workspaceId: string, now: Date = new Date()): Promise<BudgetCheck> {
  const [budget, usage] = await Promise.all([getBudget(workspaceId), monthlyUsage(workspaceId, now)]);
  const softUsd = budget?.monthlyUsdSoft ?? null;
  const hardUsd = budget?.monthlyUsdHard ?? null;
  const usedUsd = usage.totalUsd;
  return {
    status: budgetStatusFor(usedUsd, softUsd, hardUsd),
    usedUsd,
    javobAiUsd: usage.javobAiUsd,
    productionUsd: usage.productionUsd,
    softUsd,
    hardUsd,
    pct: budgetPct(usedUsd, softUsd),
    periodStart: usage.periodStart,
  };
}

/**
 * Call before EVERY JavobAI model call (reply, summary, STT, vision, sandbox).
 * Hard limit reached → `allowed: false` (do not call; LIVE sends the budget
 * template once and hands off with reason "budget"). Soft limit reached →
 * allowed but `flagged`, so routing picks the default model and smaller caps.
 * A failed lookup allows the call (an outage must not silence the AI) and logs.
 */
export async function enforceBudgetBeforeCall(workspaceId: string, now: Date = new Date()): Promise<BudgetGate> {
  let check: BudgetCheck;
  try {
    check = await checkBudget(workspaceId, now);
  } catch (error) {
    console.error("[JavobAI] budget check failed:", error instanceof Error ? error.message : error);
    return { allowed: true, status: "ok", flagged: false, check: null };
  }
  if (check.status === "hard_exceeded") {
    return { allowed: false, status: check.status, flagged: true, reason: BUDGET_HARD_EXCEEDED_REASON, check };
  }
  return { allowed: true, status: check.status, flagged: check.status === "soft_exceeded", check };
}

// ─── Alerts ───────────────────────────────────────────────────────────────────

const STAMP_FIELD: Record<BudgetThreshold, "alerted50At" | "alerted80At" | "alerted100At"> = {
  50: "alerted50At",
  80: "alerted80At",
  100: "alerted100At",
};

function fmtUsd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Uzbek alert for one threshold: used / budget / what happens at 100 %. */
export function budgetAlertText(
  threshold: BudgetThreshold,
  check: Pick<BudgetCheck, "usedUsd" | "softUsd" | "hardUsd" | "pct" | "javobAiUsd" | "productionUsd">
): { subject: string; html: string; plain: string } {
  const soft = check.softUsd ?? 0;
  const hard = check.hardUsd;
  const title =
    threshold >= 100
      ? "AI oylik byudjeti tugadi (100%)"
      : `AI oylik byudjetining ${threshold}% ishlatildi`;
  const lines = [
    `Sarflandi: ${fmtUsd(check.usedUsd)} / ${fmtUsd(soft)} (${check.pct.toFixed(0)}%)`,
    `  JavobAI: ${fmtUsd(check.javobAiUsd)}, asosiy assistent: ${fmtUsd(check.productionUsd)}`,
  ];
  if (hard !== null) {
    lines.push(
      hard <= check.usedUsd
        ? `Qattiq limit ${fmtUsd(hard)} ga yetildi: JavobAI keyingi oygacha javob bermaydi, mijozlarga menejer javob beradi.`
        : `Qattiq limit: ${fmtUsd(hard)}. Unga yetganda JavobAI keyingi oygacha to'xtaydi va mijozlarga menejer javob beradi.`
    );
  } else if (threshold >= 100) {
    lines.push("Qattiq limit o'rnatilmagan: JavobAI ishlashda davom etadi, lekin tejamkor rejimda (standart model, qisqaroq kontekst).");
  } else {
    lines.push("100% ga yetganda JavobAI tejamkor rejimga o'tadi (standart model, qisqaroq kontekst). Qattiq limit o'rnatilmagan, AI to'xtamaydi.");
  }
  lines.push("Byudjetni Sozlamalar → JavobAI → Xarajat bo'limida o'zgartirish mumkin.");
  const plain = `${title}\n\n${lines.join("\n")}`;
  const html = `<b>${escapeHtml(title)}</b>\n\n${lines.map(escapeHtml).join("\n")}`;
  return { subject: `SocialAuto: ${title}`, html, plain };
}

export interface BudgetAlertsRun {
  checked: number;
  alerted: number;
  reset: number;
  failed: number;
}

/**
 * Maintenance loop step (every 60 s from the JavobAI worker): for every
 * budget, roll the period over when the Tashkent month changed, then send the
 * highest newly-crossed threshold alert (50 / 80 / 100 %) once per period.
 * One message per workspace per run; lower thresholds crossed in the same jump
 * are stamped too, so nobody gets three alerts at once. Idempotent; one
 * workspace's failure is logged and does not stop the others.
 */
export async function runBudgetAlerts(now: Date = new Date()): Promise<BudgetAlertsRun> {
  const result: BudgetAlertsRun = { checked: 0, alerted: 0, reset: 0, failed: 0 };
  const periodStart = tashkentMonthStart(now);
  const rows = (await prisma.aiBudget.findMany()) as unknown as BudgetRow[];

  for (const row of rows) {
    result.checked += 1;
    try {
      let budget = toBudget(row);
      if (budget.periodStart.getTime() < periodStart.getTime()) {
        await prisma.aiBudget.update({
          where: { workspaceId: budget.workspaceId },
          data: { periodStart, alerted50At: null, alerted80At: null, alerted100At: null },
        });
        budget = { ...budget, periodStart, alerted50At: null, alerted80At: null, alerted100At: null };
        result.reset += 1;
      }

      const usage = await monthlyUsage(budget.workspaceId, now);
      const check: BudgetCheck = {
        status: budgetStatusFor(usage.totalUsd, budget.monthlyUsdSoft, budget.monthlyUsdHard),
        usedUsd: usage.totalUsd,
        javobAiUsd: usage.javobAiUsd,
        productionUsd: usage.productionUsd,
        softUsd: budget.monthlyUsdSoft,
        hardUsd: budget.monthlyUsdHard,
        pct: budgetPct(usage.totalUsd, budget.monthlyUsdSoft),
        periodStart,
      };

      const due = BUDGET_THRESHOLDS.filter((t) => {
        if (check.pct < t) return false;
        const stamp = budget[STAMP_FIELD[t]];
        return stamp === null || stamp.getTime() < periodStart.getTime();
      });
      if (due.length === 0) continue;

      const top = due[due.length - 1];
      const text = budgetAlertText(top, check);
      await alertWorkspace(budget.workspaceId, text.subject, text.html, text.plain);
      await prisma.aiBudget.update({
        where: { workspaceId: budget.workspaceId },
        data: Object.fromEntries(due.map((t) => [STAMP_FIELD[t], now])),
      });
      result.alerted += 1;
      console.log(
        `[JavobAI] budget alert ${top}% for workspace ${budget.workspaceId}: ${fmtUsd(roundUsd(check.usedUsd))} / ${fmtUsd(check.softUsd ?? 0)}`
      );
    } catch (error) {
      result.failed += 1;
      console.error(
        `[JavobAI] budget alert failed for workspace ${row.workspaceId}:`,
        error instanceof Error ? error.message : error
      );
    }
  }
  return result;
}
