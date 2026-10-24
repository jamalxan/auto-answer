/**
 * ETAP 4.4 — AiBudget against the in-memory db: validation, statuses,
 * the pre-call gate, and the 50 / 80 / 100 % alerts (once per Tashkent
 * month, reset on the next one).
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({ alertWorkspace: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/telegram/notify", () => ({ alertWorkspace: mocks.alertWorkspace }));

import {
  BUDGET_HARD_EXCEEDED_REASON,
  BudgetValidationError,
  budgetAlertText,
  budgetStatusFor,
  checkBudget,
  deleteBudget,
  enforceBudgetBeforeCall,
  getBudget,
  runBudgetAlerts,
  saveBudget,
  validateBudgetInput,
} from "@/lib/javobai/budget";

const WS = "ws_1";
const OCT = new Date("2026-10-16T10:00:00Z");
const OCT_START = "2026-09-30T19:00:00.000Z";

function spend(costUsd: number, over: Record<string, unknown> = {}) {
  return db.seed("llmUsage", {
    workspaceId: WS, conversationId: null, kind: "javobai_reply", model: "m",
    inputTokens: 10, outputTokens: 5, costUsd, latencyMs: 10, ok: true, ...over,
  });
}

beforeEach(() => {
  // Pin the clock to the fixtures' date: code under test also reads `new Date()`.
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(OCT);
  resetDb();
  mocks.alertWorkspace.mockReset().mockResolvedValue(undefined);
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
});

describe("saveBudget / getBudget", () => {
  it("returns null without a budget and creates one anchored to the Tashkent month", async () => {
    expect(await getBudget(WS)).toBeNull();
    const budget = await saveBudget(WS, { monthlyUsdSoft: 20, monthlyUsdHard: 30 }, OCT);
    expect(budget).toMatchObject({ workspaceId: WS, monthlyUsdSoft: 20, monthlyUsdHard: 30, alerted50At: null });
    expect(budget.periodStart.toISOString()).toBe(OCT_START);
    expect(await getBudget(WS)).toMatchObject({ monthlyUsdSoft: 20, monthlyUsdHard: 30 });
  });

  it("updates in place, keeping stamps and accepting form strings", async () => {
    await saveBudget(WS, { monthlyUsdSoft: 20, monthlyUsdHard: 30 }, OCT);
    db.rows("aiBudget")[0].alerted50At = OCT;
    const updated = await saveBudget(WS, { monthlyUsdSoft: "25.456", monthlyUsdHard: "" }, OCT);
    expect(updated).toMatchObject({ monthlyUsdSoft: 25.46, monthlyUsdHard: null, alerted50At: OCT });
    expect(db.rows("aiBudget")).toHaveLength(1);
  });

  it("validates: soft > 0, hard ≥ soft or empty", () => {
    expect(() => validateBudgetInput({ monthlyUsdSoft: 0 })).toThrow(BudgetValidationError);
    expect(() => validateBudgetInput({ monthlyUsdSoft: -5 })).toThrow(BudgetValidationError);
    expect(() => validateBudgetInput({ monthlyUsdSoft: "abc" })).toThrow(BudgetValidationError);
    expect(() => validateBudgetInput({ monthlyUsdSoft: 10, monthlyUsdHard: 9.99 })).toThrow(/soft/);
    expect(() => validateBudgetInput({ monthlyUsdSoft: 10, monthlyUsdHard: 0 })).toThrow(BudgetValidationError);
    expect(validateBudgetInput({ monthlyUsdSoft: 10, monthlyUsdHard: 10 })).toEqual({ monthlyUsdSoft: 10, monthlyUsdHard: 10 });
    expect(validateBudgetInput({ monthlyUsdSoft: 10, monthlyUsdHard: null })).toEqual({ monthlyUsdSoft: 10, monthlyUsdHard: null });
    expect(validateBudgetInput({ monthlyUsdSoft: "7.5" })).toEqual({ monthlyUsdSoft: 7.5, monthlyUsdHard: null });
  });

  it("deletes", async () => {
    await saveBudget(WS, { monthlyUsdSoft: 20 }, OCT);
    expect(await deleteBudget(WS)).toBe(true);
    expect(await deleteBudget(WS)).toBe(false);
    expect(await getBudget(WS)).toBeNull();
  });
});

describe("checkBudget", () => {
  it("is ok without a budget", async () => {
    spend(100);
    const check = await checkBudget(WS, OCT);
    expect(check).toMatchObject({ status: "ok", usedUsd: 100, softUsd: null, hardUsd: null, pct: 0 });
  });

  it("counts the whole workspace spend of the Tashkent month against the soft limit", async () => {
    await saveBudget(WS, { monthlyUsdSoft: 10, monthlyUsdHard: 15 }, OCT);
    spend(3);
    spend(1.5, { kind: "reply" }); // production assistant counts too
    spend(50, { createdAt: new Date("2026-09-30T18:00:00Z") }); // last month
    const check = await checkBudget(WS, OCT);
    expect(check).toMatchObject({ status: "ok", usedUsd: 4.5, javobAiUsd: 3, productionUsd: 1.5, softUsd: 10, hardUsd: 15, pct: 45 });
    expect(check.periodStart.toISOString()).toBe(OCT_START);
  });

  it("soft_exceeded at the soft limit, hard_exceeded at the hard limit", async () => {
    await saveBudget(WS, { monthlyUsdSoft: 10, monthlyUsdHard: 15 }, OCT);
    spend(10);
    expect((await checkBudget(WS, OCT)).status).toBe("soft_exceeded");
    spend(4.99);
    expect((await checkBudget(WS, OCT)).status).toBe("soft_exceeded");
    spend(0.01);
    const check = await checkBudget(WS, OCT);
    expect(check.status).toBe("hard_exceeded");
    expect(check.pct).toBe(150);
  });

  it("without a hard limit it never goes past soft_exceeded", async () => {
    await saveBudget(WS, { monthlyUsdSoft: 10 }, OCT);
    spend(1000);
    expect((await checkBudget(WS, OCT)).status).toBe("soft_exceeded");
    expect(budgetStatusFor(1000, 10, null)).toBe("soft_exceeded");
    expect(budgetStatusFor(1000, null, null)).toBe("ok");
  });
});

describe("enforceBudgetBeforeCall", () => {
  it("allows under budget, flags over soft, blocks over hard with the Uzbek reason", async () => {
    await saveBudget(WS, { monthlyUsdSoft: 10, monthlyUsdHard: 12 }, OCT);
    spend(5);
    expect(await enforceBudgetBeforeCall(WS, OCT)).toMatchObject({ allowed: true, status: "ok", flagged: false });

    spend(5);
    expect(await enforceBudgetBeforeCall(WS, OCT)).toMatchObject({ allowed: true, status: "soft_exceeded", flagged: true });

    spend(2);
    const gate = await enforceBudgetBeforeCall(WS, OCT);
    expect(gate).toMatchObject({ allowed: false, status: "hard_exceeded", flagged: true, reason: BUDGET_HARD_EXCEEDED_REASON });
    expect(gate.reason).toBe("AI oylik byudjeti tugadi");
    expect(gate.check?.usedUsd).toBe(12);
  });

  it("allows the call and logs when the lookup fails", async () => {
    vi.spyOn(db, "model").mockImplementationOnce(() => ({ findUnique: async () => { throw new Error("db down"); } }) as never);
    const gate = await enforceBudgetBeforeCall(WS, OCT);
    expect(gate).toEqual({ allowed: true, status: "ok", flagged: false, check: null });
    expect(console.error).toHaveBeenCalled();
  });
});

describe("runBudgetAlerts", () => {
  it("fires each threshold once per period, highest crossed wins, and stamps the lower ones", async () => {
    await saveBudget(WS, { monthlyUsdSoft: 10, monthlyUsdHard: 20 }, OCT);
    await saveBudget("ws_quiet", { monthlyUsdSoft: 100 }, OCT);

    // 49 % — nothing.
    spend(4.9);
    expect(await runBudgetAlerts(OCT)).toEqual({ checked: 2, alerted: 0, reset: 0, failed: 0 });
    expect(mocks.alertWorkspace).not.toHaveBeenCalled();

    // 50 % — the 50 % alert, once.
    spend(0.1);
    expect(await runBudgetAlerts(OCT)).toMatchObject({ alerted: 1 });
    expect(await runBudgetAlerts(OCT)).toMatchObject({ alerted: 0 });
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(1);
    const [wsId, subject, html, plain] = mocks.alertWorkspace.mock.calls[0];
    expect(wsId).toBe(WS);
    expect(subject).toContain("50%");
    expect(html).toContain("<b>");
    expect(plain).toContain("$5.00 / $10.00 (50%)");
    expect(plain).toContain("$20.00");
    expect(db.rows("aiBudget").find((b) => b.workspaceId === WS)).toMatchObject({ alerted50At: OCT, alerted80At: null, alerted100At: null });

    // Jump straight to 100 %: one message (100 %), 80 % stamped silently.
    spend(5);
    expect(await runBudgetAlerts(OCT)).toMatchObject({ alerted: 1 });
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(2);
    expect(mocks.alertWorkspace.mock.calls[1][1]).toContain("tugadi (100%)");
    expect(db.rows("aiBudget").find((b) => b.workspaceId === WS)).toMatchObject({ alerted50At: OCT, alerted80At: OCT, alerted100At: OCT });

    // More spend, still the same month — silent.
    spend(100);
    expect(await runBudgetAlerts(OCT)).toMatchObject({ alerted: 0 });
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(2);
  });

  it("resets the stamps when the Tashkent month rolls over", async () => {
    await saveBudget(WS, { monthlyUsdSoft: 10 }, OCT);
    spend(10, { createdAt: OCT });
    await runBudgetAlerts(OCT);
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(1);

    // Still October in Tashkent (31 Oct 23:30 local) — no reset, no second alert.
    const lateOct = new Date("2026-10-31T18:30:00Z");
    expect(await runBudgetAlerts(lateOct)).toMatchObject({ alerted: 0, reset: 0 });

    // November in Tashkent: period moves, stamps clear, spend is 0 again.
    const nov = new Date("2026-10-31T19:30:00Z");
    expect(await runBudgetAlerts(nov)).toMatchObject({ alerted: 0, reset: 1 });
    const row = db.rows("aiBudget")[0];
    expect((row.periodStart as Date).toISOString()).toBe("2026-10-31T19:00:00.000Z");
    expect(row).toMatchObject({ alerted50At: null, alerted80At: null, alerted100At: null });

    // The same thresholds fire again for November spend.
    spend(5, { createdAt: nov });
    expect(await runBudgetAlerts(new Date("2026-11-02T10:00:00Z"))).toMatchObject({ alerted: 1, reset: 0 });
    expect(mocks.alertWorkspace).toHaveBeenCalledTimes(2);
  });

  it("treats a stamp from an older period as unsent (migration safety)", async () => {
    await saveBudget(WS, { monthlyUsdSoft: 10 }, OCT);
    const row = db.rows("aiBudget")[0];
    row.alerted50At = new Date("2026-09-10T10:00:00Z"); // September stamp, periodStart already October
    spend(5);
    expect(await runBudgetAlerts(OCT)).toMatchObject({ alerted: 1 });
  });

  it("keeps going when one workspace fails", async () => {
    await saveBudget("ws_bad", { monthlyUsdSoft: 10 }, OCT);
    await saveBudget(WS, { monthlyUsdSoft: 10 }, OCT);
    spend(10);
    db.seed("llmUsage", { workspaceId: "ws_bad", kind: "javobai_reply", model: "m", inputTokens: 1, outputTokens: 1, costUsd: 10, latencyMs: 1, ok: true });
    mocks.alertWorkspace.mockImplementation(async (wsId: string) => {
      if (wsId === "ws_bad") throw new Error("telegram down");
    });
    const run = await runBudgetAlerts(OCT);
    expect(run).toEqual({ checked: 2, alerted: 1, reset: 0, failed: 1 });
    // The failed one is not stamped, so it retries next loop.
    expect(db.rows("aiBudget").find((b) => b.workspaceId === "ws_bad")?.alerted100At).toBeNull();
    expect(db.rows("aiBudget").find((b) => b.workspaceId === WS)?.alerted100At).toEqual(OCT);
  });
});

describe("budgetAlertText", () => {
  const base = { usedUsd: 8, softUsd: 10, hardUsd: null, pct: 80, javobAiUsd: 6, productionUsd: 2 };

  it("explains the cheap mode when there is no hard limit", () => {
    const text = budgetAlertText(80, base);
    expect(text.subject).toBe("SocialAuto: AI oylik byudjetining 80% ishlatildi");
    expect(text.plain).toContain("Sarflandi: $8.00 / $10.00 (80%)");
    expect(text.plain).toContain("JavobAI: $6.00, asosiy assistent: $2.00");
    expect(text.plain).toContain("tejamkor rejimga");
    expect(text.plain).toContain("AI to'xtamaydi");
  });

  it("explains the stop when the hard limit is reached", () => {
    const text = budgetAlertText(100, { ...base, usedUsd: 20, hardUsd: 20, pct: 200 });
    expect(text.plain).toContain("Qattiq limit $20.00 ga yetildi");
    expect(text.plain).toContain("menejer javob beradi");
    expect(text.html).not.toContain("<script");
  });

  it("formats the Telegram HTML variant and points to the settings", () => {
    const text = budgetAlertText(50, base);
    expect(text.html.startsWith("<b>AI oylik byudjetining 50% ishlatildi</b>")).toBe(true);
    expect(text.html).toContain("Sozlamalar → JavobAI → Xarajat");
    expect(text.plain).not.toContain("<b>");
  });
});
