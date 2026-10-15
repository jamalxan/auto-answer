/**
 * JavobAI dev service: validation rules with Uzbek messages (LIVE needs a
 * live profile, scoring thresholds order, handoff rule values per kind,
 * knowledge limits) and workspace scoping (another workspace's ids read as
 * "not found", never as a write).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  prisma: {
    instagramAccount: { findFirst: vi.fn(), findMany: vi.fn() },
    javobAiAccount: { upsert: vi.fn() },
    assistantProfile: { findMany: vi.fn() },
    aiKnowledgeEntry: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    aiScoringConfig: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    aiHandoffRule: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    conversation: { findFirst: vi.fn() },
    aiConversationState: { findMany: vi.fn(), findUnique: vi.fn(), update: vi.fn() },
    aiShadowTurn: { findMany: vi.fn(), aggregate: vi.fn(), count: vi.fn() },
    lead: { findMany: vi.fn() },
    llmUsage: { groupBy: vi.fn() },
    aiBudget: { findUnique: vi.fn(), upsert: vi.fn() },
  },
  findProfile: vi.fn(),
  forgetJavobAiGate: vi.fn(),
  acceptHandoff: vi.fn(),
  closeHandoff: vi.fn(),
  reopenAi: vi.fn(),
  previewKnowledge: vi.fn(),
  runJavobAiSandbox: vi.fn(),
  monthlyUsage: vi.fn(),
  getBudget: vi.fn(),
  saveBudget: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: mocks.prisma }));
vi.mock("@/lib/assistant/profile", () => ({
  findProfile: mocks.findProfile,
  isProfileLive: (p: { enabled: boolean; approvedAt: Date | null }) => p.enabled && p.approvedAt !== null,
}));
vi.mock("@/lib/javobai/gate", () => ({ forgetJavobAiGate: mocks.forgetJavobAiGate }));
vi.mock("@/lib/javobai/handoff", () => ({
  acceptHandoff: mocks.acceptHandoff,
  closeHandoff: mocks.closeHandoff,
  reopenAi: mocks.reopenAi,
}));
vi.mock("@/lib/javobai/knowledge", () => ({ previewKnowledge: mocks.previewKnowledge }));
vi.mock("@/lib/javobai/sandbox", () => ({ runJavobAiSandbox: mocks.runJavobAiSandbox }));
vi.mock("@/lib/javobai/usage", () => ({
  isJavobAiKind: (kind: string) => kind.startsWith("javobai_"),
  monthlyUsage: mocks.monthlyUsage,
}));
vi.mock("@/lib/javobai/budget", () => ({
  BudgetValidationError: class extends Error {},
  getBudget: mocks.getBudget,
  saveBudget: mocks.saveBudget,
  budgetStatusFor: () => "ok",
  budgetPct: () => 0,
}));

import {
  budgetSchema,
  createKnowledgeEntry,
  deleteHandoffRule,
  firstIssue,
  handoffRuleSchema,
  getUsage,
  isJavobAiKind,
  knowledgeEntrySchema,
  LIVE_NEEDS_PROFILE,
  NO_PROFILE,
  runHandoffAction,
  saveJavobAiConfig,
  sandboxInputSchema,
  scoringConfigSchema,
  setConversationTemperature,
  setJavobAiMode,
  setKnowledgeVerified,
  temperatureForScore,
  updateKnowledgeEntry,
} from "@/lib/javobai/service";
import { DEFAULT_JAVOBAI_CONFIG, DEFAULT_SCORING } from "@/lib/javobai/config";

const issue = (schema: { safeParse: (v: unknown) => { success: boolean; error?: unknown } }, value: unknown) => {
  const parsed = schema.safeParse(value);
  return parsed.success ? null : firstIssue(parsed.error as never);
};

const liveProfile = { id: "p1", enabled: true, approvedAt: new Date(), instagramAccountId: "acc1", products: [], faqs: [] };

beforeEach(() => {
  vi.clearAllMocks();
  mocks.prisma.instagramAccount.findFirst.mockResolvedValue({ id: "acc1", username: "shop", tokenStatus: "ACTIVE" });
});

describe("mode switch", () => {
  it("LIVE needs an enabled + approved profile (422 with the Uzbek fix)", async () => {
    mocks.findProfile.mockResolvedValue({ ...liveProfile, approvedAt: null });
    const result = await setJavobAiMode("ws1", "acc1", "LIVE", "u1");
    expect(result).toEqual({ ok: false, status: 422, error: LIVE_NEEDS_PROFILE });
    expect(mocks.prisma.javobAiAccount.upsert).not.toHaveBeenCalled();
    expect(mocks.forgetJavobAiGate).not.toHaveBeenCalled();
  });

  it("LIVE without any profile is refused too", async () => {
    mocks.findProfile.mockResolvedValue(null);
    const result = await setJavobAiMode("ws1", "acc1", "LIVE", "u1");
    expect(result.ok).toBe(false);
  });

  it("LIVE with a live profile upserts the row and forgets the gate cache", async () => {
    mocks.findProfile.mockResolvedValue(liveProfile);
    mocks.prisma.javobAiAccount.upsert.mockResolvedValue({});
    const result = await setJavobAiMode("ws1", "acc1", "LIVE", "u1");
    expect(result).toEqual({ ok: true, data: { id: "acc1", mode: "LIVE" } });
    expect(mocks.prisma.javobAiAccount.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { instagramAccountId: "acc1" }, update: { mode: "LIVE", enabledBy: "u1" } })
    );
    expect(mocks.forgetJavobAiGate).toHaveBeenCalledWith("acc1");
  });

  it("SHADOW does not need a profile", async () => {
    mocks.findProfile.mockResolvedValue(null);
    mocks.prisma.javobAiAccount.upsert.mockResolvedValue({});
    const result = await setJavobAiMode("ws1", "acc1", "SHADOW", "u1");
    expect(result.ok).toBe(true);
    expect(mocks.findProfile).not.toHaveBeenCalled();
  });

  it("an account of another workspace is 404 — scoped lookup, no write", async () => {
    mocks.prisma.instagramAccount.findFirst.mockResolvedValue(null);
    const result = await setJavobAiMode("ws1", "acc-other", "OFF", "u1");
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mocks.prisma.instagramAccount.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "acc-other", workspaceId: "ws1" } })
    );
    expect(mocks.prisma.javobAiAccount.upsert).not.toHaveBeenCalled();
  });

  it("saving the config keeps the mode (OFF on create) and forgets the gate", async () => {
    mocks.prisma.javobAiAccount.upsert.mockResolvedValue({});
    const result = await saveJavobAiConfig("ws1", "acc1", { ...DEFAULT_JAVOBAI_CONFIG, maxTurns: 8 });
    expect(result.ok).toBe(true);
    const call = mocks.prisma.javobAiAccount.upsert.mock.calls[0]![0];
    expect(call.create.mode).toBe("OFF");
    expect(call.update).toEqual({ config: expect.objectContaining({ maxTurns: 8 }) });
    expect(mocks.forgetJavobAiGate).toHaveBeenCalledWith("acc1");
  });
});

describe("knowledge entries", () => {
  it("title ≤ 120 and body ≤ 2000, both required", () => {
    expect(issue(knowledgeEntrySchema, { kind: "DISCOUNT", title: "", body: "x" })).toMatch(/Sarlavha/);
    expect(issue(knowledgeEntrySchema, { kind: "DISCOUNT", title: "a".repeat(121), body: "x" })).toMatch(/120/);
    expect(issue(knowledgeEntrySchema, { kind: "DISCOUNT", title: "ok", body: "   " })).toMatch(/Matn/);
    expect(issue(knowledgeEntrySchema, { kind: "DISCOUNT", title: "ok", body: "b".repeat(2001) })).toMatch(/2000/);
    expect(issue(knowledgeEntrySchema, { kind: "SECRET", title: "ok", body: "x" })).toBeTruthy();
    const parsed = knowledgeEntrySchema.safeParse({ kind: "CONTACT", title: " Tel ", body: " +998 " });
    expect(parsed.success && parsed.data).toEqual({ kind: "CONTACT", title: "Tel", body: "+998", active: true, sort: 0 });
  });

  it("creating an entry needs a profile for the account (422)", async () => {
    mocks.findProfile.mockResolvedValue(null);
    const result = await createKnowledgeEntry("ws1", "acc1", { kind: "DISCOUNT", title: "x", body: "y", active: true, sort: 0 });
    expect(result).toEqual({ ok: false, status: 422, error: NO_PROFILE });
    expect(mocks.prisma.aiKnowledgeEntry.create).not.toHaveBeenCalled();
  });

  it("new entries start unverified (never shown to the AI)", async () => {
    mocks.findProfile.mockResolvedValue(liveProfile);
    mocks.prisma.aiKnowledgeEntry.create.mockImplementation(async ({ data }: { data: unknown }) => data);
    const result = await createKnowledgeEntry("ws1", "acc1", { kind: "DISCOUNT", title: "x", body: "y", active: true, sort: 0 });
    expect(result.ok).toBe(true);
    const data = mocks.prisma.aiKnowledgeEntry.create.mock.calls[0]![0].data;
    expect(data.profileId).toBe("p1");
    expect(data.verifiedAt).toBeUndefined();
  });

  it("an entry is found only through the workspace's profiles", async () => {
    mocks.prisma.assistantProfile.findMany.mockResolvedValue([{ id: "p1" }, { id: "p2" }]);
    mocks.prisma.aiKnowledgeEntry.findFirst.mockResolvedValue(null);
    const result = await setKnowledgeVerified("ws1", "e-other", true);
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mocks.prisma.aiKnowledgeEntry.findFirst).toHaveBeenCalledWith({
      where: { id: "e-other", profileId: { in: ["p1", "p2"] } },
    });
    expect(mocks.prisma.aiKnowledgeEntry.update).not.toHaveBeenCalled();
  });

  it("a workspace without profiles cannot touch any entry", async () => {
    mocks.prisma.assistantProfile.findMany.mockResolvedValue([]);
    const result = await setKnowledgeVerified("ws1", "e1", true);
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mocks.prisma.aiKnowledgeEntry.findFirst).not.toHaveBeenCalled();
  });

  it("editing the text drops the verification; toggling active keeps it", async () => {
    mocks.prisma.assistantProfile.findMany.mockResolvedValue([{ id: "p1" }]);
    mocks.prisma.aiKnowledgeEntry.findFirst.mockResolvedValue({ id: "e1", title: "t", body: "old", verifiedAt: new Date() });
    mocks.prisma.aiKnowledgeEntry.update.mockResolvedValue({});

    await updateKnowledgeEntry("ws1", "e1", { body: "new" });
    expect(mocks.prisma.aiKnowledgeEntry.update).toHaveBeenLastCalledWith({
      where: { id: "e1" },
      data: { body: "new", verifiedAt: null },
    });

    await updateKnowledgeEntry("ws1", "e1", { active: false });
    expect(mocks.prisma.aiKnowledgeEntry.update).toHaveBeenLastCalledWith({ where: { id: "e1" }, data: { active: false } });
  });
});

describe("scoring config", () => {
  const good = {
    rules: DEFAULT_SCORING.rules,
    thresholds: { warm: 30, hot: 60, veryHot: 80 },
    handoffAtScore: null,
    lostAfterDays: 14,
  };

  it("accepts the defaults", () => {
    expect(scoringConfigSchema.safeParse(good).success).toBe(true);
  });

  it("thresholds must grow: warm < hot < veryHot", () => {
    expect(issue(scoringConfigSchema, { ...good, thresholds: { warm: 60, hot: 30, veryHot: 80 } })).toMatch(/Warm < Hot/);
    expect(issue(scoringConfigSchema, { ...good, thresholds: { warm: 30, hot: 80, veryHot: 80 } })).toMatch(/Warm < Hot/);
    expect(issue(scoringConfigSchema, { ...good, thresholds: { warm: 0, hot: 60, veryHot: 80 } })).toBeTruthy();
  });

  it("rules: known signals only, points −100…100, no duplicates", () => {
    expect(issue(scoringConfigSchema, { ...good, rules: [{ signal: "made_up", points: 5 }] })).toMatch(/signal/i);
    expect(issue(scoringConfigSchema, { ...good, rules: [{ signal: "price_asked", points: 101 }] })).toMatch(/100/);
    expect(issue(scoringConfigSchema, { ...good, rules: [{ signal: "price_asked", points: 1.5 }] })).toMatch(/butun/);
    expect(
      issue(scoringConfigSchema, {
        ...good,
        rules: [
          { signal: "price_asked", points: 10 },
          { signal: "price_asked", points: 20 },
        ],
      })
    ).toMatch(/ikki marta/);
  });

  it("handoffAtScore 1…100 and lostAfterDays 1…365 are optional", () => {
    expect(issue(scoringConfigSchema, { ...good, handoffAtScore: 0 })).toMatch(/1…100/);
    expect(issue(scoringConfigSchema, { ...good, lostAfterDays: 366 })).toMatch(/1…365/);
    expect(scoringConfigSchema.safeParse({ ...good, handoffAtScore: undefined, lostAfterDays: undefined }).success).toBe(true);
  });

  it("temperatureForScore follows the bands", () => {
    const t = good.thresholds;
    expect(temperatureForScore(0, t)).toBe("COLD");
    expect(temperatureForScore(29, t)).toBe("COLD");
    expect(temperatureForScore(30, t)).toBe("WARM");
    expect(temperatureForScore(60, t)).toBe("HOT");
    expect(temperatureForScore(95, t)).toBe("HOT");
  });
});

describe("handoff rules", () => {
  it("KEYWORD: 1…20 non-empty keywords", () => {
    expect(issue(handoffRuleSchema, { kind: "KEYWORD", value: { keywords: [] } })).toMatch(/Kamida bitta/);
    expect(issue(handoffRuleSchema, { kind: "KEYWORD", value: { keywords: ["  "] } })).toMatch(/Bo'sh/);
    expect(issue(handoffRuleSchema, { kind: "KEYWORD", value: { keywords: Array(21).fill("x") } })).toMatch(/20/);
    const parsed = handoffRuleSchema.safeParse({ kind: "KEYWORD", value: { keywords: [" menejer "] } });
    expect(parsed.success && parsed.data).toEqual({ kind: "KEYWORD", value: { keywords: ["menejer"] }, active: true });
  });

  it("INTENT: only known intents", () => {
    expect(issue(handoffRuleSchema, { kind: "INTENT", value: { intents: ["wants_cake"] } })).toMatch(/intent/i);
    expect(issue(handoffRuleSchema, { kind: "INTENT", value: { intents: [] } })).toMatch(/Kamida/);
    expect(handoffRuleSchema.safeParse({ kind: "INTENT", value: { intents: ["wants_human", "complaint"] } }).success).toBe(true);
  });

  it("SCORE 1…100, UNKNOWN_COUNT 1…5, OFF_HOURS HH:MM", () => {
    expect(issue(handoffRuleSchema, { kind: "SCORE", value: { min: 0 } })).toMatch(/1…100/);
    expect(handoffRuleSchema.safeParse({ kind: "SCORE", value: { min: 80 } }).success).toBe(true);
    expect(issue(handoffRuleSchema, { kind: "UNKNOWN_COUNT", value: { count: 6 } })).toMatch(/1…5/);
    expect(issue(handoffRuleSchema, { kind: "OFF_HOURS", value: { from: "18:00", to: "9am" } })).toMatch(/HH:MM/);
    expect(issue(handoffRuleSchema, { kind: "OFF_HOURS", value: { from: "25:00", to: "09:00" } })).toMatch(/HH:MM/);
    expect(handoffRuleSchema.safeParse({ kind: "OFF_HOURS", value: { from: "18:00", to: "09:00" }, active: false }).success).toBe(true);
  });

  it("a value of the wrong kind is rejected", () => {
    expect(handoffRuleSchema.safeParse({ kind: "SCORE", value: { keywords: ["x"] } }).success).toBe(false);
    expect(handoffRuleSchema.safeParse({ kind: "FLOW", value: {} }).success).toBe(false);
  });

  it("deleting another workspace's rule is 404", async () => {
    mocks.prisma.aiHandoffRule.findFirst.mockResolvedValue(null);
    const result = await deleteHandoffRule("ws1", "r-other");
    expect(result).toMatchObject({ ok: false, status: 404 });
    expect(mocks.prisma.aiHandoffRule.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: "r-other", workspaceId: "ws1" } })
    );
    expect(mocks.prisma.aiHandoffRule.delete).not.toHaveBeenCalled();
  });
});

describe("conversation actions", () => {
  it("handoff actions are scoped and need a JavobAI state", async () => {
    mocks.prisma.conversation.findFirst.mockResolvedValue(null);
    expect(await runHandoffAction("ws1", "c-other", { action: "accept" }, "u1")).toMatchObject({ ok: false, status: 404 });

    mocks.prisma.conversation.findFirst.mockResolvedValue({ id: "c1", aiState: null });
    expect(await runHandoffAction("ws1", "c1", { action: "accept" }, "u1")).toMatchObject({ ok: false, status: 422 });
    expect(mocks.acceptHandoff).not.toHaveBeenCalled();
  });

  it("accept / close / reopen call the engine", async () => {
    mocks.prisma.conversation.findFirst.mockResolvedValue({ id: "c1", aiState: { id: "s1" } });
    mocks.prisma.aiConversationState.findUnique.mockResolvedValue({ handoffState: "OPERATOR_ACTIVE" });

    const accepted = await runHandoffAction("ws1", "c1", { action: "accept" }, "u1");
    expect(mocks.acceptHandoff).toHaveBeenCalledWith("c1", "u1");
    expect(accepted).toEqual({ ok: true, data: { id: "c1", handoffState: "OPERATOR_ACTIVE" } });

    await runHandoffAction("ws1", "c1", { action: "close" }, "u1");
    expect(mocks.closeHandoff).toHaveBeenCalledWith("c1", "u1", true);

    await runHandoffAction("ws1", "c1", { action: "close", resumeAi: false }, "u1");
    expect(mocks.closeHandoff).toHaveBeenLastCalledWith("c1", "u1", false);

    await runHandoffAction("ws1", "c1", { action: "reopen" }, "u1");
    expect(mocks.reopenAi).toHaveBeenCalledWith("c1");
  });

  it("temperature can only be set to CUSTOMER / LOST by an operator", async () => {
    mocks.prisma.conversation.findFirst.mockResolvedValue({ id: "c1", aiState: { id: "s1" } });
    mocks.prisma.aiConversationState.update.mockResolvedValue({ temperature: "CUSTOMER" });
    const result = await setConversationTemperature("ws1", "c1", "CUSTOMER");
    expect(result).toEqual({ ok: true, data: { id: "c1", temperature: "CUSTOMER" } });
    expect(mocks.prisma.aiConversationState.update).toHaveBeenCalledWith({
      where: { conversationId: "c1" },
      data: { temperature: "CUSTOMER" },
    });
  });
});

describe("budget, usage and sandbox input", () => {
  it("budget: soft > 0, hard ≥ soft or empty", () => {
    expect(issue(budgetSchema, { monthlyUsdSoft: 0 })).toMatch(/Yumshoq/);
    expect(issue(budgetSchema, { monthlyUsdSoft: 10, monthlyUsdHard: 5 })).toMatch(/kichik bo'lmasin/);
    expect(budgetSchema.safeParse({ monthlyUsdSoft: 10, monthlyUsdHard: null }).success).toBe(true);
    expect(budgetSchema.safeParse({ monthlyUsdSoft: 10, monthlyUsdHard: 20 }).success).toBe(true);
  });

  it("usage: javobai kinds are flagged and a workspace without a budget reads null", async () => {
    expect(isJavobAiKind("javobai_reply")).toBe(true);
    expect(isJavobAiKind("reply")).toBe(false);
    mocks.monthlyUsage.mockResolvedValue({
      periodStart: new Date("2026-10-01T00:00:00Z"),
      periodEnd: new Date("2026-11-01T00:00:00Z"),
      byKind: [
        { kind: "javobai_shadow", javobAi: true, label: "Shadow", calls: 3, failedCalls: 0, inputTokens: 10, outputTokens: 5, costUsd: 0.01 },
      ],
      totalUsd: 0.01,
      javobAiUsd: 0.01,
      productionUsd: 0,
      calls: 3,
    });
    mocks.getBudget.mockResolvedValue(null);
    const usage = await getUsage("ws1");
    expect(usage.budget).toBeNull();
    expect(usage.kinds[0]).toMatchObject({ kind: "javobai_shadow", javobai: true, calls: 3 });
    expect(mocks.monthlyUsage).toHaveBeenCalledWith("ws1");
  });

  it("sandbox input: 1…40 non-empty messages with a role", () => {
    expect(issue(sandboxInputSchema, { instagramAccountId: "acc1", messages: [] })).toMatch(/Kamida/);
    expect(issue(sandboxInputSchema, { instagramAccountId: "acc1", messages: [{ role: "customer", text: "  " }] })).toMatch(/Bo'sh/);
    expect(issue(sandboxInputSchema, { instagramAccountId: "acc1", messages: [{ role: "bot", text: "x" }] })).toBeTruthy();
    expect(issue(sandboxInputSchema, { instagramAccountId: "", messages: [{ role: "customer", text: "x" }] })).toMatch(/akkaunt/i);
  });
});
