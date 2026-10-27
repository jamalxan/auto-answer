/**
 * ETAP 10 - computeDayMetrics + rollup against the in-memory db.
 * The Tashkent day is 19:00Z (previous day) .. 19:00Z: a record at
 * 2026-10-14T19:30Z belongs to Oct 15 in Tashkent.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => {
  const client = db.client() as unknown as Record<string, unknown>;
  // The campaign report reads a few shapes the in-memory db does not model (nested selects, groupBy counts).
  return {
    prisma: new Proxy(client, {
      get(target, prop: string) {
        const value = target[prop] as Record<string, unknown>;
        if (prop === "automation") {
          return {
            ...value,
            findFirst: async () => ({
              id: "auto_1",
              workspaceId: "ws_1",
              name: "Promo",
              goal: null,
              postUrl: null,
              keywords: [],
              isActive: true,
              createdAt: new Date("2026-10-01T00:00:00Z"),
              updatedAt: new Date("2026-10-01T00:00:00Z"),
              reportShareSlug: "slug_1",
              workspace: { name: "Acme" },
              instagramAccount: { username: "acme" },
              trackedLinks: [],
            }),
          };
        }
        if (prop === "dmLog") {
          return {
            ...value,
            groupBy: async ({ by, where }: { by: string[]; where?: Record<string, unknown> }) => {
              const rows = (await db.model("dmLog").findMany({ where })) as Array<Record<string, unknown>>;
              const groups = new Map<string, number>();
              for (const row of rows) groups.set(String(row[by[0]] ?? ""), (groups.get(String(row[by[0]] ?? "")) ?? 0) + 1);
              return [...groups].map(([key, count]) => ({ [by[0]]: key === "" ? null : key, _count: { _all: count } }));
            },
          };
        }
        return value;
      },
    }),
  };
});

import { computeDayMetrics, type MetricRow } from "@/lib/analytics/compute";
import { readAnalytics } from "@/lib/analytics/read";
import { rollupDay, rollupRange } from "@/lib/analytics/rollup";
import { getCampaignReportBySlug } from "@/lib/reports/data";

const WS = "ws_1";
const OTHER = "ws_2";
const ACCT = "ig_1";

function at(iso: string) {
  return new Date(iso);
}

function value(rows: MetricRow[], metric: string, dim: [string, string] | null = null, account = ""): number {
  return rows.find((r) => r.metric === metric && r.instagramAccountId === account && r.dimKind === (dim?.[0] ?? "") && r.dimId === (dim?.[1] ?? ""))?.value ?? 0;
}

function seedWorld() {
  db.seed("instagramAccount", { id: ACCT, workspaceId: WS, username: "acme" });
  db.seed("automation", { id: "auto_1", workspaceId: WS, instagramAccountId: ACCT, name: "Promo" });
  db.seed("triggerCampaign", { id: "tc_1", workspaceId: WS, instagramAccountId: ACCT, name: "Story javob" });

  // Legacy DMs: 19:30Z on the 14th is Oct 15 in Tashkent; 18:30Z is still Oct 14.
  db.seed("dmLog", { workspaceId: WS, automationId: "auto_1", instagramAccountId: ACCT, status: "SENT", createdAt: at("2026-10-14T19:30:00Z"), dmSentAt: at("2026-10-14T19:30:00Z") });
  db.seed("dmLog", { workspaceId: WS, automationId: "auto_1", instagramAccountId: ACCT, status: "SENT", createdAt: at("2026-10-14T18:30:00Z"), dmSentAt: at("2026-10-14T18:30:00Z") });
  db.seed("dmLog", { workspaceId: WS, automationId: "auto_1", instagramAccountId: ACCT, status: "FAILED", createdAt: at("2026-10-15T10:00:00Z") });
  db.seed("dmLog", { workspaceId: WS, automationId: "auto_1", instagramAccountId: ACCT, status: "SKIPPED_DEDUP", createdAt: at("2026-10-15T11:00:00Z") });
  db.seed("dmLog", { workspaceId: OTHER, automationId: "auto_x", instagramAccountId: "ig_x", status: "SENT", createdAt: at("2026-10-15T11:00:00Z"), dmSentAt: at("2026-10-15T11:00:00Z") });
  db.seed("linkClick", { workspaceId: WS, automationId: "auto_1", instagramAccountId: ACCT, createdAt: at("2026-10-15T12:00:00Z") });

  // Trigger engine
  db.seed("triggerExecution", { workspaceId: WS, eventId: "e1", campaignId: "tc_1", status: "SENT", sentAt: at("2026-10-15T12:00:00Z"), createdAt: at("2026-10-15T12:00:00Z"), openedAt: at("2026-10-15T13:00:00Z") });
  db.seed("triggerExecution", {
    workspaceId: WS, eventId: "e2", campaignId: "tc_1", status: "SENT", sentAt: at("2026-10-14T10:00:00Z"), createdAt: at("2026-10-14T10:00:00Z"),
    openedAt: at("2026-10-14T10:05:00Z"), firstInboundAt: at("2026-10-15T14:00:00Z"),
  });

  // Broadcast
  db.seed("crmBroadcast", { id: "b1", workspaceId: WS, instagramAccountId: ACCT, name: "Aksiya" });
  db.seed("crmBroadcastRecipient", { broadcastId: "b1", contactId: "c9", eligible: true, status: "SENT", sentAt: at("2026-10-15T12:00:00Z"), repliedAt: at("2026-10-15T13:00:00Z"), convertedAt: at("2026-10-15T15:00:00Z"), createdAt: at("2026-10-15T11:00:00Z") });

  // Leads (a test lead and another workspace's lead never count)
  db.seed("lead", { id: "lead_1", workspaceId: WS, instagramAccountId: ACCT, igUserId: "u1", campaignId: "auto_1", conversationId: null, createdAt: at("2026-10-15T09:00:00Z"), idempotencyKey: "k1" });
  db.seed("lead", { id: "lead_2", workspaceId: WS, instagramAccountId: ACCT, igUserId: "u2", campaignId: null, conversationId: "conv_1", createdAt: at("2026-10-15T10:00:00Z"), idempotencyKey: "k2" });
  db.seed("lead", { id: "lead_t", workspaceId: WS, instagramAccountId: ACCT, igUserId: "u3", isTest: true, createdAt: at("2026-10-15T10:00:00Z"), idempotencyKey: "k3" });
  db.seed("lead", { id: "lead_o", workspaceId: OTHER, instagramAccountId: "ig_x", igUserId: "u4", createdAt: at("2026-10-15T10:00:00Z"), idempotencyKey: "k4" });
  db.seed("aiLeadInsight", { leadId: "lead_2", score: 80, temperature: "HOT", createdAt: at("2026-10-15T10:00:00Z") });
  db.seed("aiLeadInsight", { leadId: "lead_t", score: 99, temperature: "HOT", isTest: true, createdAt: at("2026-10-15T10:00:00Z") });

  // CRM: a deal won on the 15th, created two days earlier; it left the entry stage that day
  db.seed("crmContact", { id: "c1", workspaceId: WS, instagramAccountId: ACCT, igUserId: "u1" });
  db.seed("crmPipeline", { id: "p1", workspaceId: WS, name: "Sotuv" });
  db.seed("crmStage", { id: "s_entry", pipelineId: "p1", name: "Yangi", sort: 0, isEntry: true });
  db.seed("crmStage", { id: "s_won", pipelineId: "p1", name: "Sotildi", sort: 9, kind: "WON" });
  db.seed("crmDeal", { id: "d1", workspaceId: WS, contactId: "c1", pipelineId: "p1", stageId: "s_won", leadId: "lead_1", createdAt: at("2026-10-13T08:00:00Z"), wonAt: at("2026-10-15T08:00:00Z") });
  db.seed("crmActivity", { workspaceId: WS, contactId: "c1", dealId: "d1", type: "STAGE_CHANGED", occurredAt: at("2026-10-15T07:00:00Z"), actorKind: "USER", title: "x", payload: { fromStageId: "s_entry", toStageId: "s_won" } });

  // AI: conv_1 stays with the AI, conv_2 is handed to an operator
  db.seed("conversation", { id: "conv_1", workspaceId: WS, instagramAccountId: ACCT, igUserId: "u2" });
  db.seed("conversation", { id: "conv_2", workspaceId: WS, instagramAccountId: ACCT, igUserId: "u5" });
  db.seed("aiConversationState", { conversationId: "conv_1", createdAt: at("2026-10-15T09:00:00Z") });
  db.seed("aiConversationState", { conversationId: "conv_2", createdAt: at("2026-10-15T09:30:00Z") });
  db.seed("aiHandoff", { conversationId: "conv_2", reason: "price", openedAt: at("2026-10-15T11:00:00Z"), acceptedAt: at("2026-10-15T11:10:00Z"), status: "ACCEPTED" });
  db.seed("llmUsage", { workspaceId: WS, conversationId: "conv_1", kind: "javobai_reply", costUsd: 0.01, ok: true, latencyMs: 400, inputTokens: 100, outputTokens: 20, createdAt: at("2026-10-15T09:00:00Z") });
  db.seed("llmUsage", { workspaceId: WS, conversationId: "conv_1", kind: "javobai_reply", costUsd: 0.02, ok: false, errorKind: "timeout", latencyMs: 600, inputTokens: 50, outputTokens: 0, createdAt: at("2026-10-15T09:01:00Z") });
  db.seed("conversationMessage", { conversationId: "conv_1", author: "CUSTOMER", text: "salom", createdAt: at("2026-10-15T09:05:00Z") });
  db.seed("conversationMessage", { conversationId: "conv_1", author: "ASSISTANT", text: "salom!", createdAt: at("2026-10-15T09:06:00Z") });
  db.seed("assistantEvent", { workspaceId: WS, conversationId: "conv_1", type: "blocked_reply", createdAt: at("2026-10-15T09:07:00Z") });
  db.seed("instagramEvent", { workspaceId: WS, instagramAccountId: ACCT, eventType: "COMMENT", messageId: "m1", senderId: "s1", timestamp: at("2026-10-15T09:00:00Z"), rawPayload: {} });
}

beforeEach(() => {
  resetDb();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("computeDayMetrics", () => {
  it("assigns records to the Tashkent day and builds campaign metrics with dimensions", async () => {
    seedWorld();
    const rows = await computeDayMetrics(WS, "2026-10-15");

    // DmLog 19:30Z (Oct 15 Tashkent) + trigger execution + broadcast recipient
    expect(value(rows, "campaign.sent")).toBe(3);
    expect(value(rows, "campaign.sent", ["automation", "auto_1"])).toBe(1);
    expect(value(rows, "campaign.sent", ["trigger_campaign", "tc_1"])).toBe(1);
    expect(value(rows, "campaign.sent", ["broadcast", "b1"])).toBe(1);
    expect(value(rows, "campaign.sent", null, ACCT)).toBe(3);
    expect(value(rows, "campaign.delivered")).toBe(3);
    expect(value(rows, "campaign.failed")).toBe(1);
    expect(value(rows, "campaign.skipped")).toBe(1);
    expect(value(rows, "campaign.skipped", ["reason", "SKIPPED_DEDUP"])).toBe(1);
    expect(value(rows, "campaign.clicks")).toBe(1);
    // replies: execution opened (fallback) + execution firstInboundAt + broadcast repliedAt
    expect(value(rows, "campaign.replies")).toBe(3);
    expect(value(rows, "campaign.replies", ["trigger_campaign", "tc_1"])).toBe(2);
    // leads: only the non-test lead with a campaign; conversions: the won deal + the broadcast conversion
    expect(value(rows, "campaign.leads")).toBe(1);
    expect(value(rows, "campaign.conversions")).toBe(2);
    expect(value(rows, "campaign.conversions", ["automation", "auto_1"])).toBe(1);
    // funnel: 3 DmLog rows created on the day + 1 comment event; DMs exclude broadcasts
    expect(value(rows, "funnel.comments")).toBe(4);
    expect(value(rows, "funnel.dms")).toBe(2);
  });

  it("builds sales and AI metrics, excluding test leads and other workspaces", async () => {
    seedWorld();
    const rows = await computeDayMetrics(WS, "2026-10-15");

    expect(value(rows, "sales.leads")).toBe(2);
    expect(value(rows, "sales.won")).toBe(1);
    expect(value(rows, "sales.won", ["pipeline", "p1"])).toBe(1);
    expect(value(rows, "sales.cycle_ms_sum")).toBe(2 * 24 * 3600 * 1000);
    expect(value(rows, "sales.cycle_ms_count")).toBe(1);
    expect(value(rows, "sales.qualified")).toBe(1);
    expect(value(rows, "sales.score_sum")).toBe(80);
    expect(value(rows, "sales.score_count")).toBe(1);

    expect(value(rows, "ai.conversations")).toBe(2);
    expect(value(rows, "ai.handoff")).toBe(1);
    expect(value(rows, "ai.handoff", ["reason", "price"])).toBe(1);
    expect(value(rows, "ai.handoff_accepted")).toBe(1);
    expect(value(rows, "ai.handoff_wait_ms_sum")).toBe(10 * 60 * 1000);
    expect(value(rows, "ai.handoff_wait_count")).toBe(1);
    expect(value(rows, "ai.qualified")).toBe(1);
    expect(value(rows, "ai.resolved")).toBe(1);
    // No CRM temperature activity that day: HOT falls back to the insight
    expect(value(rows, "ai.hot")).toBe(1);
    expect(value(rows, "ai.calls")).toBe(2);
    expect(value(rows, "ai.failed_calls")).toBe(1);
    expect(value(rows, "ai.cost_usd")).toBeCloseTo(0.03, 6);
    expect(value(rows, "ai.calls", ["kind", "javobai_reply"])).toBe(2);
    expect(value(rows, "ai.latency_ms_sum")).toBe(1000);
    expect(value(rows, "ai.failed_calls", ["error", "timeout"])).toBe(1);
    expect(value(rows, "ai.customer_calls")).toBe(2);
    expect(value(rows, "ai.customer_failed_calls")).toBe(1);
    expect(value(rows, "ai.customer_latency_ms_sum")).toBe(1000);
    expect(value(rows, "msg.customer")).toBe(1);
    expect(value(rows, "msg.ai")).toBe(1);
    expect(value(rows, "ai.blocked_replies")).toBe(1);
    expect(value(rows, "cohort.ai_only.conversations")).toBe(1);
    expect(value(rows, "cohort.handed_off.conversations")).toBe(1);
    expect(value(rows, "cohort.ai_only.leads")).toBe(1);

    const other = await computeDayMetrics(OTHER, "2026-10-15");
    expect(value(other, "campaign.sent")).toBe(1);
    expect(value(other, "sales.leads")).toBe(1);
    expect(value(other, "ai.conversations")).toBe(0);
  });

  it("counts the previous Tashkent day separately", async () => {
    seedWorld();
    const rows = await computeDayMetrics(WS, "2026-10-14");
    // 18:30Z DmLog + the execution sent at 10:00Z on the 14th
    expect(value(rows, "campaign.sent")).toBe(2);
    expect(value(rows, "campaign.failed")).toBe(0);
  });

  it("uses CRM TEMPERATURE_CHANGED activities for hot leads when present", async () => {
    seedWorld();
    db.seed("crmActivity", { workspaceId: WS, contactId: "c1", type: "TEMPERATURE_CHANGED", occurredAt: at("2026-10-15T12:00:00Z"), actorKind: "AI", title: "t", payload: { from: "WARM", to: "HOT" } });
    db.seed("crmActivity", { workspaceId: WS, contactId: "c1", type: "TEMPERATURE_CHANGED", occurredAt: at("2026-10-15T13:00:00Z"), actorKind: "AI", title: "t", payload: { from: "HOT", to: "WARM" } });
    const rows = await computeDayMetrics(WS, "2026-10-15");
    expect(value(rows, "ai.hot")).toBe(1);
    expect(value(rows, "ai.hot", null, ACCT)).toBe(1);
  });
});

describe("rollup", () => {
  it("replaces a day instead of appending (idempotent) and leaves other days alone", async () => {
    seedWorld();
    const first = await rollupDay(WS, "2026-10-15");
    const count = db.rows("analyticsDaily").length;
    expect(first.rows).toBe(count);
    await rollupDay(WS, "2026-10-14");
    const both = db.rows("analyticsDaily").length;

    await rollupDay(WS, "2026-10-15");
    expect(db.rows("analyticsDaily").length).toBe(both);

    // A source row disappears: the recompute drops its metric instead of keeping the stale value.
    db.tables.linkClick = [];
    await rollupDay(WS, "2026-10-15");
    const clicks = db.rows("analyticsDaily").filter((r) => r.metric === "campaign.clicks" && r.dimKind === "");
    expect(clicks).toHaveLength(0);
    expect(db.rows("analyticsDaily").some((r) => (r.day as Date).toISOString().startsWith("2026-10-14"))).toBe(true);
  });

  it("stores no zero rows and scopes by workspace", async () => {
    seedWorld();
    await rollupDay(OTHER, "2026-10-15");
    expect(db.rows("analyticsDaily").every((r) => r.workspaceId === OTHER && (r.value as number) !== 0)).toBe(true);
  });
});

describe("rollups agree with the campaign report", () => {
  it("7-day campaign.sent / clicks of one automation equal getCampaignReportBySlug", async () => {
    const now = new Date("2026-10-15T10:00:00Z");
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(now);
    db.seed("instagramAccount", { id: ACCT, workspaceId: WS, username: "acme" });
    db.seed("automation", { id: "auto_1", workspaceId: WS, instagramAccountId: ACCT, name: "Promo" });

    // sent per day (Oct 9 .. Oct 15) and clicks, around the 19:00Z day boundaries
    const sentTimes = [
      "2026-10-09T08:00:00Z", "2026-10-09T08:05:00Z", "2026-10-10T19:30:00Z", "2026-10-11T12:00:00Z",
      "2026-10-13T18:59:00Z", "2026-10-13T19:00:00Z", "2026-10-14T19:30:00Z", "2026-10-15T08:00:00Z",
    ];
    for (const t of sentTimes) {
      db.seed("dmLog", { workspaceId: WS, automationId: "auto_1", instagramAccountId: ACCT, status: "SENT", createdAt: at(t), dmSentAt: at(t) });
    }
    for (const t of ["2026-10-10T19:10:00Z", "2026-10-12T05:00:00Z", "2026-10-15T09:00:00Z"]) {
      db.seed("linkClick", { workspaceId: WS, automationId: "auto_1", instagramAccountId: ACCT, createdAt: at(t) });
    }

    await rollupRange(WS, "2026-10-09", "2026-10-15", now);
    const report = await getCampaignReportBySlug("slug_1");
    expect(report).not.toBeNull();

    const read = await readAnalytics(WS, { tab: "campaign", preset: "7d", compare: "none", mode: "period", dim: "automation" }, now);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    const reportSent = report!.daily.reduce((sum, d) => sum + d.sent, 0);
    const reportClicks = report!.daily.reduce((sum, d) => sum + d.clicks, 0);
    const row = read.data.breakdown.find((b) => b.dimId === "auto_1");
    expect(reportSent).toBe(sentTimes.length);
    expect(row?.metrics["campaign.sent"]).toBe(reportSent);
    expect(row?.metrics["campaign.clicks"]).toBe(reportClicks);
    expect(read.data.series.map((p) => p["campaign.sent"])).toEqual(report!.daily.map((d) => d.sent));
    expect(read.data.series.map((p) => p["campaign.clicks"])).toEqual(report!.daily.map((d) => d.clicks));
  });
});
