/**
 * Audit phase 8 — tariffs: plan limits (reported vs enforced), checkout,
 * the Payme Merchant JSON-RPC flow and the Click Shop API, against the
 * in-memory database. No live keys.
 */

import { createHash } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const notify = vi.hoisted(() => vi.fn(async () => 1));

vi.mock("../lib/db/client", async () => {
  const { db } = await import("./helpers/db-instance");
  return { prisma: db.client() };
});
vi.mock("../lib/telegram/notify", () => ({ notifyWorkspaceChats: notify }));

import { aiConversationLimit } from "../lib/assistant/profile";
import { PlanLimitError, assertAiAuto, assertCanSchedule, assertChannelSlots, videoAnalysisCap, workspaceUsage } from "../lib/billing/limits";
import { CLICK_ERRORS, clickSign, handleClick } from "../lib/billing/click";
import { PAYME_ERRORS, PAYME_TIMEOUT_MS, handlePayme, paymeAuthorized } from "../lib/billing/payme";
import { BillingError, PLAN_MONTH_MS, createCheckout, enabledProviders } from "../lib/billing/payments";
import { allPlans, effectivePlan, getPlan, priceUzs } from "../lib/billing/plans";
import { db, resetDb } from "./helpers/db-instance";

const NOW = new Date("2026-10-27T12:00:00Z");
const KEY = "payme-secret";
const AUTH = `Basic ${Buffer.from(`Paycom:${KEY}`).toString("base64")}`;

const rpc = (method: string, params: Record<string, unknown>, now = NOW, auth: string | null = AUTH) =>
  handlePayme(JSON.stringify({ id: 1, method, params }), auth, now) as Promise<{ result?: Record<string, unknown>; error?: { code: number } }>;

const workspace = () => db.rows("workspace").find((w) => w.id === "w1")!;

function seedPayment(over: Record<string, unknown> = {}) {
  return db.seed("payment", { id: "pay1", workspaceId: "w1", plan: "biznes", months: 1, amountTiyin: 36_800_000, provider: "PAYME", createdAt: NOW, updatedAt: NOW, ...over });
}

beforeEach(() => {
  resetDb();
  vi.clearAllMocks();
  vi.stubEnv("PAYME_KEY", KEY);
  vi.stubEnv("PAYME_MERCHANT_ID", "m1");
  vi.stubEnv("PAYME_ENABLED", "1");
  vi.stubEnv("CLICK_ENABLED", "");
  vi.stubEnv("BILLING_ENFORCED", "");
  vi.stubEnv("PLAN_LIMITS_JSON", "");
  vi.stubEnv("PLAN_PRICES_UZS_JSON", "");
  vi.stubEnv("USD_UZS_RATE", "");
  db.seed("workspace", { id: "w1", ownerId: "owner" });
});

afterEach(() => vi.unstubAllEnvs());

describe("plans", () => {
  it("has four tariffs, Start free, prices in so'm rounded to 1000", () => {
    expect(allPlans().map((p) => p.slug)).toEqual(["start", "biznes", "pro", "agentlik"]);
    expect(priceUzs("start")).toBe(0);
    expect(priceUzs("biznes")).toBe(368_000); // 29 × 12 700
    vi.stubEnv("PLAN_PRICES_UZS_JSON", '{"biznes":390000}');
    expect(priceUzs("biznes")).toBe(390_000);
  });

  it("an expired paid plan falls back to Start; unknown slugs are Start", () => {
    expect(effectivePlan({ planSlug: "pro", planExpiresAt: new Date(NOW.getTime() + 1000) }, NOW).slug).toBe("pro");
    expect(effectivePlan({ planSlug: "pro", planExpiresAt: new Date(NOW.getTime() - 1000) }, NOW).slug).toBe("start");
    expect(getPlan("nope").slug).toBe("start");
  });

  it("PLAN_LIMITS_JSON overrides a limit", () => {
    vi.stubEnv("PLAN_LIMITS_JSON", '{"biznes":{"aiReplies":1500}}');
    expect(getPlan("biznes").limits.aiReplies).toBe(1500);
    expect(getPlan("biznes").limits.channels).toBe(3);
  });
});

describe("limits", () => {
  it("only report while BILLING_ENFORCED is off", async () => {
    db.seed("instagramAccount", { id: "ig1", workspaceId: "w1", instagramId: "1", username: "a", accessToken: "x" });
    await expect(assertChannelSlots("w1", 1)).resolves.toBeUndefined();
    await expect(assertAiAuto("w1")).resolves.toBeUndefined();
    expect(await videoAnalysisCap("w1")).toBeNull();
    const usage = await workspaceUsage("w1", NOW);
    expect(usage).toMatchObject({ enforced: false, channels: 1, plan: { slug: "start" } });
  });

  it("block over-limit actions when enforced, and a paid plan lifts them", async () => {
    vi.stubEnv("BILLING_ENFORCED", "1");
    db.seed("instagramAccount", { id: "ig1", workspaceId: "w1", instagramId: "1", username: "a", accessToken: "x" });
    await expect(assertChannelSlots("w1", 1)).rejects.toBeInstanceOf(PlanLimitError);
    await expect(assertChannelSlots("w1", 0)).resolves.toBeUndefined(); // reconnect
    await expect(assertAiAuto("w1")).rejects.toMatchObject({ status: 402, limit: "aiAuto" });
    expect(await videoAnalysisCap("w1")).toBe(0);

    Object.assign(workspace(), { planSlug: "biznes", planExpiresAt: new Date(Date.now() + 86_400_000) });
    await expect(assertChannelSlots("w1", 2)).resolves.toBeUndefined();
    await expect(assertChannelSlots("w1", 3)).rejects.toBeInstanceOf(PlanLimitError);
    await expect(assertAiAuto("w1")).resolves.toBeUndefined();
  });

  it("counts scheduled posts this month; rescheduling is free", async () => {
    vi.stubEnv("BILLING_ENFORCED", "1");
    for (let i = 0; i < 10; i++) db.seed("scheduledPost", { id: `p${i}`, workspaceId: "w1", status: "SCHEDULED", scheduledAt: NOW, deletedAt: null });
    db.seed("scheduledPost", { id: "draft", workspaceId: "w1", status: "DRAFT", scheduledAt: NOW, deletedAt: null });
    await expect(assertCanSchedule("w1", false, NOW)).rejects.toMatchObject({ limit: "scheduledPostsPerMonth" });
    await expect(assertCanSchedule("w1", true, NOW)).resolves.toBeUndefined();
  });

  it("aiConversationLimit: override, then plan when enforced, else env default", () => {
    vi.stubEnv("AI_CONVERSATIONS_LIMIT", "");
    expect(aiConversationLimit({ aiConversationsLimit: 7, planSlug: "pro" })).toBe(7);
    const fallback = aiConversationLimit({ aiConversationsLimit: null, planSlug: "pro" });
    vi.stubEnv("BILLING_ENFORCED", "1");
    expect(aiConversationLimit({ aiConversationsLimit: null, planSlug: "pro", planExpiresAt: null })).toBe(5000);
    expect(aiConversationLimit({ aiConversationsLimit: null })).toBe(fallback);
  });
});

describe("checkout", () => {
  const base = { workspaceId: "w1", userId: "u1", role: "OWNER", plan: "biznes", months: 3, provider: "PAYME" };

  it("creates a Payme payment for owner / admin and returns the checkout URL", async () => {
    expect(enabledProviders()).toEqual(["PAYME"]);
    const out = await createCheckout(base);
    expect(out.amountUzs).toBe(368_000 * 3);
    const decoded = Buffer.from(out.url.split("/").pop()!, "base64").toString();
    expect(decoded).toContain(`ac.payment_id=${out.paymentId}`);
    expect(decoded).toContain(`a=${368_000 * 3 * 100}`);
    expect(db.rows("payment")[0]).toMatchObject({ provider: "PAYME", status: "CREATED", months: 3 });
  });

  it("refuses members, Start, odd months and disabled providers", async () => {
    await expect(createCheckout({ ...base, role: "MEMBER" })).rejects.toMatchObject({ status: 403 });
    await expect(createCheckout({ ...base, plan: "start" })).rejects.toMatchObject({ status: 400 });
    await expect(createCheckout({ ...base, months: 2 })).rejects.toMatchObject({ status: 400 });
    await expect(createCheckout({ ...base, provider: "CLICK" })).rejects.toBeInstanceOf(BillingError);
    expect(db.rows("payment")).toHaveLength(0);
  });
});

describe("Payme", () => {
  it("rejects a wrong key", async () => {
    expect(paymeAuthorized(`Basic ${Buffer.from("Paycom:wrong").toString("base64")}`)).toBe(false);
    expect((await rpc("CheckPerformTransaction", {}, NOW, null)).error?.code).toBe(PAYME_ERRORS.auth.code);
    expect((await handlePayme("{oops", AUTH)).error).toEqual(PAYME_ERRORS.parse);
  });

  it("checks amount and order", async () => {
    seedPayment();
    expect((await rpc("CheckPerformTransaction", { amount: 1, account: { payment_id: "pay1" } })).error?.code).toBe(PAYME_ERRORS.amount.code);
    expect((await rpc("CheckPerformTransaction", { amount: 36_800_000, account: { payment_id: "nope" } })).error?.code).toBe(PAYME_ERRORS.account.code);
    expect((await rpc("CheckPerformTransaction", { amount: 36_800_000, account: { payment_id: "pay1" } })).result).toEqual({ allow: true });
  });

  it("create → perform extends the plan once; repeated calls are idempotent", async () => {
    seedPayment();
    const params = { id: "t1", time: NOW.getTime(), amount: 36_800_000, account: { payment_id: "pay1" } };
    expect((await rpc("CreateTransaction", params)).result).toMatchObject({ transaction: "pay1", state: 1 });
    expect((await rpc("CreateTransaction", params)).result).toMatchObject({ state: 1 });
    expect((await rpc("CreateTransaction", { ...params, id: "t2" })).error?.code).toBe(PAYME_ERRORS.busy.code);

    expect((await rpc("PerformTransaction", { id: "t1" })).result).toMatchObject({ state: 2, perform_time: NOW.getTime() });
    expect((await rpc("PerformTransaction", { id: "t1" })).result).toMatchObject({ state: 2 });
    expect(workspace()).toMatchObject({ planSlug: "biznes", planExpiresAt: new Date(NOW.getTime() + PLAN_MONTH_MS) });
    expect(notify).toHaveBeenCalledTimes(1);
    expect((await rpc("CheckTransaction", { id: "t1" })).result).toMatchObject({ state: 2, transaction: "pay1" });

    const statement = await rpc("GetStatement", { from: NOW.getTime() - 1000, to: NOW.getTime() + 1000 });
    expect(statement.result?.transactions).toHaveLength(1);
  });

  it("cancel after perform takes the months back", async () => {
    seedPayment();
    await rpc("CreateTransaction", { id: "t1", time: NOW.getTime(), amount: 36_800_000, account: { payment_id: "pay1" } });
    await rpc("PerformTransaction", { id: "t1" });
    expect((await rpc("CancelTransaction", { id: "t1", reason: 5 })).result).toMatchObject({ state: -2 });
    expect(workspace()).toMatchObject({ planSlug: "start", planExpiresAt: null });
    expect((await rpc("CancelTransaction", { id: "t1", reason: 5 })).result).toMatchObject({ state: -2 });
  });

  it("a transaction older than 12 h is cancelled with reason 4 and never performed", async () => {
    seedPayment();
    await rpc("CreateTransaction", { id: "t1", time: NOW.getTime(), amount: 36_800_000, account: { payment_id: "pay1" } });
    const late = new Date(NOW.getTime() + PAYME_TIMEOUT_MS + 1);
    expect((await rpc("PerformTransaction", { id: "t1" }, late)).error?.code).toBe(PAYME_ERRORS.cannotPerform.code);
    expect((await rpc("CheckTransaction", { id: "t1" }, late)).result).toMatchObject({ state: -1, reason: 4 });
    expect(workspace().planSlug).toBe("start");
  });

  it("unknown method and unknown transaction", async () => {
    expect((await rpc("Nope", {})).error?.code).toBe(PAYME_ERRORS.method.code);
    expect((await rpc("CheckTransaction", { id: "missing" })).error?.code).toBe(PAYME_ERRORS.notFound.code);
  });
});

describe("Click", () => {
  const SECRET = "click-secret";
  const md5 = (s: string) => createHash("md5").update(s).digest("hex");
  const signed = (p: Record<string, string>) => ({ ...p, sign_string: clickSign(p, SECRET) });
  const prepare = signed({ click_trans_id: "c1", service_id: "s1", merchant_trans_id: "pay1", amount: "368000", action: "0", sign_time: "2026-10-27 17:00:00" });
  const complete = signed({ click_trans_id: "c1", service_id: "s1", merchant_trans_id: "pay1", merchant_prepare_id: "pay1", amount: "368000", action: "1", sign_time: "2026-10-27 17:00:05", error: "0" });

  beforeEach(() => {
    vi.stubEnv("CLICK_SECRET_KEY", SECRET);
    vi.stubEnv("CLICK_SERVICE_ID", "s1");
    seedPayment({ provider: "CLICK" });
  });

  it("signs prepare and complete as documented", () => {
    expect(prepare.sign_string).toBe(md5(`c1s1${SECRET}pay1368000${"0"}2026-10-27 17:00:00`));
    expect(complete.sign_string).toBe(md5(`c1s1${SECRET}pay1pay1368000${"1"}2026-10-27 17:00:05`));
  });

  it("prepare → complete pays once", async () => {
    expect(await handleClick(prepare, NOW)).toMatchObject({ merchant_prepare_id: "pay1", error: 0 });
    expect(await handleClick(complete, NOW)).toMatchObject({ merchant_confirm_id: "pay1", error: 0 });
    expect(workspace().planSlug).toBe("biznes");
    expect(await handleClick(complete, NOW)).toMatchObject({ error: CLICK_ERRORS.paid.error });
    expect(notify).toHaveBeenCalledTimes(1);
  });

  it("rejects a bad sign, a wrong amount and a missing order", async () => {
    expect(await handleClick({ ...prepare, sign_string: "0".repeat(32) }, NOW)).toMatchObject({ error: CLICK_ERRORS.sign.error });
    expect(await handleClick(signed({ ...prepare, amount: "1" }), NOW)).toMatchObject({ error: CLICK_ERRORS.amount.error });
    expect(await handleClick(signed({ ...prepare, merchant_trans_id: "nope" }), NOW)).toMatchObject({ error: CLICK_ERRORS.order.error });
  });

  it("a failed customer payment cancels the order", async () => {
    await handleClick(prepare, NOW);
    expect(await handleClick(signed({ ...complete, error: "-5017" }), NOW)).toMatchObject({ error: CLICK_ERRORS.cancelled.error });
    expect(db.rows("payment")[0]).toMatchObject({ status: "CANCELED" });
    expect(workspace().planSlug).toBe("start");
  });
});
