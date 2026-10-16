/**
 * ETAP 10 - the read side: ranges, zero-filled series, comparison, derived
 * rates, breakdown labels, partial flag, funnels. Rollups are seeded directly.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));

import { buildCohortStages } from "@/lib/analytics/funnel-cohort";
import { parseReadQuery, readAnalytics, type ReadParams } from "@/lib/analytics/read";
import { addDays, previousRange, resolveRange } from "@/lib/analytics/time";

const WS = "ws_1";
// 15:00 on Oct 15 in Tashkent
const NOW = new Date("2026-10-15T10:00:00Z");

function roll(day: string, metric: string, value: number, extra: { account?: string; dim?: [string, string]; workspaceId?: string } = {}) {
  db.seed("analyticsDaily", {
    workspaceId: extra.workspaceId ?? WS,
    instagramAccountId: extra.account ?? "",
    day: new Date(`${day}T00:00:00Z`),
    metric,
    dimKind: extra.dim?.[0] ?? "",
    dimId: extra.dim?.[1] ?? "",
    value,
  });
}

function params(over: Partial<ReadParams> = {}): ReadParams {
  return { tab: "campaign", preset: "7d", compare: "previous", mode: "period", ...over };
}

beforeEach(() => {
  resetDb();
  db.seed("instagramAccount", { id: "ig_1", workspaceId: WS, username: "acme" });
  db.seed("instagramAccount", { id: "ig_2", workspaceId: WS, username: "second" });
});

describe("ranges", () => {
  it("resolves presets in Tashkent days and flags partial", () => {
    const r = resolveRange({ preset: "7d" }, NOW);
    expect(r.ok && r.range).toMatchObject({ from: "2026-10-09", to: "2026-10-15", days: 7, partial: true });
    const today = resolveRange({ preset: "today" }, NOW);
    expect(today.ok && today.range).toMatchObject({ from: "2026-10-15", to: "2026-10-15", days: 1 });
    // 20:00Z on the 15th is already the 16th in Tashkent
    const late = resolveRange({ preset: "today" }, new Date("2026-10-15T20:00:00Z"));
    expect(late.ok && late.range.from).toBe("2026-10-16");
  });

  it("custom: validates, clamps to today, never longer than a year, not partial for the past", () => {
    expect(resolveRange({ preset: "custom", from: "2026-10-01", to: "2026-10-03" }, NOW)).toMatchObject({ ok: true, range: { days: 3, partial: false } });
    expect(resolveRange({ preset: "custom", from: "2026-10-01", to: "2026-12-31" }, NOW)).toMatchObject({ ok: true, range: { to: "2026-10-15", partial: true } });
    expect(resolveRange({ preset: "custom", from: "2026-10-05", to: "2026-10-01" }, NOW).ok).toBe(false);
    expect(resolveRange({ preset: "custom", from: "2025-01-01", to: "2026-10-15" }, NOW).ok).toBe(false);
    expect(resolveRange({ preset: "custom", from: "garbage", to: "2026-10-15" }, NOW).ok).toBe(false);
    expect(resolveRange({ preset: "custom", from: "2027-01-01", to: "2027-01-02" }, NOW).ok).toBe(false);
  });

  it("previous period has the same length and ends the day before", () => {
    expect(previousRange({ from: "2026-10-09", days: 7 })).toEqual({ from: "2026-10-02", to: "2026-10-08", days: 7 });
    expect(addDays("2026-03-01", -1)).toBe("2026-02-28");
  });

  it("parses the query and rejects unknown values", () => {
    expect(parseReadQuery(new URLSearchParams("tab=bogus")).ok).toBe(false);
    expect(parseReadQuery(new URLSearchParams("compare=weird")).ok).toBe(false);
    expect(parseReadQuery(new URLSearchParams("dim=nope")).ok).toBe(false);
    const ok = parseReadQuery(new URLSearchParams("tab=ai&preset=30d&accountId=ig_1"));
    expect(ok.ok && ok.params).toMatchObject({ tab: "ai", preset: "30d", accountId: "ig_1", compare: "previous" });
  });
});

describe("readAnalytics", () => {
  function seedCampaign() {
    roll("2026-10-15", "campaign.sent", 10);
    roll("2026-10-14", "campaign.sent", 5);
    roll("2026-10-15", "campaign.clicks", 2);
    roll("2026-10-08", "campaign.sent", 4); // previous period
    roll("2026-10-08", "campaign.clicks", 1);
    roll("2026-10-15", "campaign.sent", 6, { dim: ["automation", "a1"] });
    roll("2026-10-15", "campaign.clicks", 3, { dim: ["automation", "a1"] });
    roll("2026-10-15", "campaign.sent", 99, { workspaceId: "ws_other" });
    roll("2026-10-15", "campaign.sent", 7, { account: "ig_1" });
    db.seed("automation", { id: "a1", workspaceId: WS, instagramAccountId: "ig_1", name: "Promo" });
  }

  it("sums the range, zero-fills the series and compares with the previous period", async () => {
    seedCampaign();
    const res = await readAnalytics(WS, params(), NOW);
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    const { data } = res;
    expect(data.range).toMatchObject({ from: "2026-10-09", to: "2026-10-15", partial: true });
    expect(data.metrics["campaign.sent"]).toMatchObject({ value: 15, compare: 4, deltaPct: 275 });
    expect(data.metrics["campaign.clicks"]).toMatchObject({ value: 2, compare: 1, deltaPct: 100 });
    expect(data.series).toHaveLength(7);
    expect(data.series.map((p) => p.day)[0]).toBe("2026-10-09");
    expect(data.series[0]["campaign.sent"]).toBe(0);
    expect(data.series[5]["campaign.sent"]).toBe(5);
    expect(data.series[6]["campaign.sent"]).toBe(10);
    expect(data.compareSeries).toHaveLength(7);
    expect(data.notes.join(" ")).toContain("Bugungi kun");
  });

  it("derives rates from the summed parts, not from daily rates", async () => {
    seedCampaign();
    const res = await readAnalytics(WS, params(), NOW);
    if (!res.ok) throw new Error("read failed");
    const ctr = res.data.metrics["campaign.ctr"];
    expect(ctr.derived).toBe(true);
    expect(ctr.value).toBeCloseTo(2 / 15, 3);
    expect(ctr.compare).toBeCloseTo(1 / 4, 3);
    // a day without sends has no rate (not 0%)
    expect(res.data.series[0]["campaign.ctr"]).toBeNull();
  });

  it("breaks down by campaign with the label resolved at read time", async () => {
    seedCampaign();
    const res = await readAnalytics(WS, params({ compare: "none" }), NOW);
    if (!res.ok) throw new Error("read failed");
    expect(res.data.compare).toBeNull();
    expect(res.data.metrics["campaign.sent"].compare).toBeNull();
    const row = res.data.breakdown.find((b) => b.dimId === "a1");
    expect(row).toMatchObject({ dimKind: "automation", label: "Promo" });
    expect(row?.metrics["campaign.sent"]).toBe(6);
    expect(row?.metrics["campaign.ctr"]).toBeCloseTo(0.5, 3);
  });

  it("filters by account and by workspace", async () => {
    seedCampaign();
    const acct = await readAnalytics(WS, params({ accountId: "ig_1", compare: "none" }), NOW);
    if (!acct.ok) throw new Error("read failed");
    expect(acct.data.metrics["campaign.sent"].value).toBe(7);
    const other = await readAnalytics("ws_other", params({ compare: "none" }), NOW);
    if (!other.ok) throw new Error("read failed");
    expect(other.data.metrics["campaign.sent"].value).toBe(99);
    const unknown = await readAnalytics(WS, params({ accountId: "ig_nope" }), NOW);
    expect(unknown).toMatchObject({ ok: false, status: 404 });
  });

  it("supports a custom comparison period and dim vs dim", async () => {
    seedCampaign();
    roll("2026-10-15", "campaign.sent", 2, { dim: ["automation", "a2"] });
    db.seed("automation", { id: "a2", workspaceId: WS, instagramAccountId: "ig_1", name: "Boshqa" });
    const custom = await readAnalytics(WS, params({ compare: "custom", compareFrom: "2026-10-08", compareTo: "2026-10-08" }), NOW);
    if (!custom.ok) throw new Error("read failed");
    expect(custom.data.metrics["campaign.sent"].compare).toBe(4);
    expect(custom.data.compare).toMatchObject({ kind: "custom", from: "2026-10-08", to: "2026-10-08" });

    const dimVsDim = await readAnalytics(WS, params({ compare: "dim", dim: "automation", dimA: "a1", dimB: "a2" }), NOW);
    if (!dimVsDim.ok) throw new Error("read failed");
    expect(dimVsDim.data.metrics["campaign.sent"]).toMatchObject({ value: 6, compare: 2, deltaPct: 200 });

    expect(await readAnalytics(WS, params({ compare: "custom" }), NOW)).toMatchObject({ ok: false, status: 400 });
    expect(await readAnalytics(WS, params({ preset: "custom", from: "2026-10-09", to: "bad" }), NOW)).toMatchObject({ ok: false, status: 400 });
  });

  it("is not partial for a finished custom range", async () => {
    const res = await readAnalytics(WS, params({ preset: "custom", from: "2026-10-01", to: "2026-10-03", compare: "none" }), NOW);
    if (!res.ok) throw new Error("read failed");
    expect(res.data.range.partial).toBe(false);
    expect(res.data.series).toHaveLength(3);
    expect(res.data.notes).toEqual([]);
  });

  it("AI tab: derived success / handoff rates and AI vs human cohorts", async () => {
    roll("2026-10-14", "ai.conversations", 10);
    roll("2026-10-14", "ai.resolved", 6);
    roll("2026-10-14", "ai.handoff", 3);
    roll("2026-10-14", "ai.calls", 4);
    roll("2026-10-14", "ai.latency_ms_sum", 2000);
    roll("2026-10-14", "ai.handoff", 2, { dim: ["reason", "price"] });
    roll("2026-10-14", "cohort.ai_only.leads", 4);
    roll("2026-10-14", "cohort.ai_only.won", 2);
    roll("2026-10-14", "cohort.handed_off.leads", 5);
    roll("2026-10-14", "cohort.handed_off.won", 1);
    const res = await readAnalytics(WS, params({ tab: "ai", compare: "ai_human" }), NOW);
    if (!res.ok) throw new Error("read failed");
    expect(res.data.metrics["ai.success_rate"].value).toBeCloseTo(0.6, 3);
    expect(res.data.metrics["ai.handoff_rate"].value).toBeCloseTo(0.3, 3);
    expect(res.data.metrics["ai.avg_latency_ms"].value).toBe(500);
    expect(res.data.aiVsHuman?.aiOnly).toMatchObject({ leads: 4, won: 2, conversionRate: 0.5 });
    expect(res.data.aiVsHuman?.handedOff.conversionRate).toBeCloseTo(0.2, 3);
    expect(res.data.breakdown.find((b) => b.dimKind === "reason")).toMatchObject({ dimId: "price", label: "price" });
  });

  it("sales tab: conversion rate and the pipeline label", async () => {
    roll("2026-10-14", "sales.leads", 20);
    roll("2026-10-14", "sales.won", 5);
    roll("2026-10-14", "sales.won", 5, { dim: ["pipeline", "p1"] });
    roll("2026-10-14", "sales.score_sum", 300);
    roll("2026-10-14", "sales.score_count", 6);
    db.seed("crmPipeline", { id: "p1", workspaceId: WS, name: "Asosiy pipeline" });
    const res = await readAnalytics(WS, params({ tab: "sales" }), NOW);
    if (!res.ok) throw new Error("read failed");
    expect(res.data.metrics["sales.conversion_rate"].value).toBeCloseTo(0.25, 3);
    expect(res.data.metrics["sales.avg_score"].value).toBe(50);
    expect(res.data.breakdown[0]).toMatchObject({ dimKind: "pipeline", label: "Asosiy pipeline" });
  });
});

describe("funnels", () => {
  it("period funnel: drop-offs between stages and share of the first", async () => {
    const day = "2026-10-14";
    roll(day, "funnel.comments", 100);
    roll(day, "funnel.dms", 50);
    roll(day, "campaign.replies", 25);
    roll(day, "sales.leads", 10);
    roll(day, "ai.hot", 5);
    roll(day, "sales.won", 1);
    roll(day, "sales.customer_marked", 3);
    roll("2026-10-08", "funnel.comments", 40);
    const res = await readAnalytics(WS, params({ tab: "funnel" }), NOW);
    if (!res.ok) throw new Error("read failed");
    const stages = res.data.funnel!.stages;
    expect(stages.map((s) => s.value)).toEqual([100, 50, 25, 10, 5, 1]);
    expect(stages[0].dropOffPct).toBeNull();
    expect(stages.map((s) => s.dropOffPct)).toEqual([null, 50, 50, 60, 50, 80]);
    expect(stages[3].pctOfFirst).toBe(10);
    expect(stages[0]).toMatchObject({ compare: 40, deltaPct: 150 });
    expect(res.data.funnel!.customerMarked).toBe(3);
    expect(res.data.funnel!.note).toContain("SocialAuto ko'rgan");
  });

  it("period funnel: a stage larger than the previous one has no drop-off", async () => {
    roll("2026-10-14", "funnel.comments", 10);
    roll("2026-10-14", "funnel.dms", 12);
    const res = await readAnalytics(WS, params({ tab: "funnel", compare: "none" }), NOW);
    if (!res.ok) throw new Error("read failed");
    expect(res.data.funnel!.stages[1].dropOffPct).toBeNull();
  });

  it("cohort funnel: each stage is a subset of the previous one", async () => {
    const base = { workspaceId: WS, instagramAccountId: "ig_1", firstInteractionAt: new Date("2026-10-14T08:00:00Z") };
    // 4 comment contacts: all got a DM, 3 replied, 2 have a deal, 1 is hot, 1 won
    db.seed("crmContact", { ...base, id: "c1", igUserId: "1", source: "COMMENT", lastOutboundAt: new Date(), lastInboundAt: new Date(), temperature: "CUSTOMER", status: "CUSTOMER" });
    db.seed("crmContact", { ...base, id: "c2", igUserId: "2", source: "COMMENT", lastOutboundAt: new Date(), lastInboundAt: new Date(), temperature: "HOT" });
    db.seed("crmContact", { ...base, id: "c3", igUserId: "3", source: "COMMENT", lastOutboundAt: new Date(), lastInboundAt: new Date() });
    db.seed("crmContact", { ...base, id: "c4", igUserId: "4", source: "COMMENT", lastOutboundAt: new Date() });
    db.seed("crmContact", { ...base, id: "c5", igUserId: "5", source: "DM" }); // not from a comment
    db.seed("crmContact", { ...base, id: "c6", igUserId: "6", source: "COMMENT", firstInteractionAt: new Date("2026-09-01T00:00:00Z") }); // outside the range
    db.seed("crmContact", { ...base, id: "c7", workspaceId: "ws_other", igUserId: "7", source: "COMMENT", lastOutboundAt: new Date() });
    db.seed("crmDeal", { workspaceId: WS, contactId: "c1", pipelineId: "p", stageId: "s", wonAt: new Date() });
    db.seed("crmDeal", { workspaceId: WS, contactId: "c2", pipelineId: "p", stageId: "s" });

    const res = await readAnalytics(WS, params({ tab: "funnel", mode: "cohort", compare: "none" }), NOW);
    if (!res.ok) throw new Error("read failed");
    expect(res.data.funnel!.mode).toBe("cohort");
    expect(res.data.funnel!.stages.map((s) => [s.key, s.value])).toEqual([
      ["comments", 4], ["dms", 4], ["replies", 3], ["leads", 2], ["hot", 2], ["sales", 1],
    ]);
    expect(res.data.funnel!.stages[2].dropOffPct).toBe(25);
  });

  it("buildCohortStages handles an empty cohort", () => {
    const stages = buildCohortStages([], new Map());
    expect(stages.every((s) => s.value === 0 && s.pctOfFirst === null)).toBe(true);
  });
});
