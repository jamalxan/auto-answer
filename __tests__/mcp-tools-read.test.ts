/**
 * ETAP 12 — the read tools: shape of the answers, lead filters and limits,
 * the report text, the knowledge-base search and the diagnostics / KPI wiring.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({ loadKpi: vi.fn(), runDiagnostics: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("@/lib/triggers/ingest", () => ({ forgetAccountGate: vi.fn() }));
vi.mock("@/lib/analytics/kpi", () => ({ loadKpi: mocks.loadKpi }));
vi.mock("@/lib/foundation/diagnostics", () => ({ runDiagnostics: mocks.runDiagnostics }));

import { resetMcpRateLimitsForTests } from "../lib/mcp/auth";
import { callTool, makeToken, seedFlows, seedWorld, WS_A } from "./helpers/mcp-world";

let read: string;
let flows: { a: string; b: string };

beforeEach(async () => {
  resetDb();
  resetMcpRateLimitsForTests();
  mocks.loadKpi.mockResolvedValue({ generatedAt: "2026-10-20T00:00:00Z", connections: { total: 1, healthy: 1, broken: 0 }, queueDepths: [], failed: [] });
  mocks.runDiagnostics.mockResolvedValue([
    { key: "token", label: "Token muddati", status: "warning", value: "5 kun", meaning: "Token tez orada tugaydi", lastCheck: null, issue: "Token 5 kunda tugaydi", action: { label: "Qayta ulang", href: "/settings" } },
  ]);
  seedWorld();
  flows = await seedFlows();
  read = (await makeToken(WS_A, "READ")).raw;
});

describe("campaigns and flows", () => {
  it("get_campaign shows the DM text, keywords and status", async () => {
    const { data } = await callTool(read, "get_campaign", { campaignId: "cmpA" });
    expect(data).toMatchObject({ id: "cmpA", name: "Narx A", status: "ACTIVE", keywords: ["narx"], dmMessage: "Narx 100 000 so'm", account: "mebel_a" });
  });

  it("list_campaigns filters by status and respects the limit", async () => {
    db.seed("triggerCampaign", { id: "cmpA2", workspaceId: WS_A, instagramAccountId: "acA", name: "Pauza", triggerType: "COMMENT", keywords: ["x"], responseMessage: "y", active: false, kind: "CAMPAIGN" });
    expect((await callTool(read, "list_campaigns", { status: "paused" })).data.campaigns.map((c: { id: string }) => c.id)).toEqual(["cmpA2"]);
    expect((await callTool(read, "list_campaigns", { status: "active" })).data.campaigns.map((c: { id: string }) => c.id)).toEqual(["cmpA"]);
    const one = await callTool(read, "list_campaigns", { limit: 1 });
    expect(one.data.campaigns).toHaveLength(1);
    expect(one.data.total).toBe(2);
  });

  it("a published proxy campaign of a flow is not listed as a campaign", async () => {
    db.seed("triggerCampaign", { id: "proxy", workspaceId: WS_A, instagramAccountId: "acA", name: "Flow proxy", triggerType: "COMMENT", keywords: [], responseMessage: "", active: true, kind: "FLOW" });
    const ids = (await callTool(read, "list_campaigns")).data.campaigns.map((c: { id: string }) => c.id);
    expect(ids).not.toContain("proxy");
    expect((await callTool(read, "get_campaign", { campaignId: "proxy" })).isError).toBe(true);
  });

  it("get_flow returns a graph summary and findings, not the raw graph", async () => {
    const { data, text } = await callTool(read, "get_flow", { flowId: flows.a });
    expect(data).toMatchObject({ id: flows.a, name: "Flow A", status: "DRAFT" });
    expect(data.draft.graph.nodeCount).toBeGreaterThan(2);
    expect(data.draft.graph.trigger.type).toBe("COMMENT");
    expect(data.draft.graph.messages.length).toBeGreaterThan(0);
    expect(text).not.toContain('"edges"');
  });

  it("list_flows filters by status", async () => {
    expect((await callTool(read, "list_flows", { status: "DRAFT" })).data.flows).toHaveLength(1);
    expect((await callTool(read, "list_flows", { status: "PUBLISHED" })).data.flows).toHaveLength(0);
  });
});

describe("list_leads", () => {
  beforeEach(() => {
    db.seed("crmContact", { id: "ct2", workspaceId: WS_A, instagramAccountId: "acA", igUserId: "u2", username: "sardor", name: "Sardor", status: "CUSTOMER", lastInteractionAt: new Date("2026-09-01T00:00:00Z") });
  });

  it("filters by stage, search and date range", async () => {
    expect((await callTool(read, "list_leads", { stage: "CUSTOMER" })).data.leads.map((l: { id: string }) => l.id)).toEqual(["ct2"]);
    expect((await callTool(read, "list_leads", { search: "@sardor" })).data.leads.map((l: { id: string }) => l.id)).toEqual(["ct2"]);
    expect((await callTool(read, "list_leads", { since: "2026-10-01T00:00:00Z" })).data.leads.map((l: { id: string }) => l.id)).toEqual(["ctA"]);
    expect((await callTool(read, "list_leads", { until: "2026-09-30T00:00:00Z" })).data.leads.map((l: { id: string }) => l.id)).toEqual(["ct2"]);
  });

  it("limit is at most 50 and pages with nextCursor", async () => {
    expect((await callTool(read, "list_leads", { limit: 51 })).isError).toBe(true);
    const first = await callTool(read, "list_leads", { limit: 1 });
    expect(first.data.leads).toHaveLength(1);
    expect(first.data.nextCursor).toBeTruthy();
    const second = await callTool(read, "list_leads", { limit: 1, cursor: first.data.nextCursor });
    expect(second.data.leads).toHaveLength(1);
    expect(second.data.leads[0].id).not.toBe(first.data.leads[0].id);
    expect(first.data.total).toBe(2);
  });
});

describe("analytics, report, knowledge, health", () => {
  it("get_analytics_summary returns labelled metrics for the period", async () => {
    const { data, isError, text } = await callTool(read, "get_analytics_summary", { tab: "campaign", period: "7d" });
    expect(isError, text).toBe(false);
    expect(data.tab).toBe("campaign");
    expect(data.metrics.length).toBeGreaterThan(0);
    expect(data.metrics[0]).toHaveProperty("label");
    expect(data.range).toBeDefined();
  });

  it("generate_report is a plain Uzbek text for every period", async () => {
    for (const period of ["today", "7d", "30d"]) {
      const { data, isError, text } = await callTool(read, "generate_report", { period });
      expect(isError, text).toBe(false);
      expect(data.report).toMatch(/SocialAuto hisoboti/);
      expect(data.report).toMatch(/Kampaniyalar:/);
      expect(data.report).toMatch(/Sotuv:/);
    }
  });

  it("an unknown tab or period is a tool error", async () => {
    expect((await callTool(read, "get_analytics_summary", { tab: "nope" })).isError).toBe(true);
    expect((await callTool(read, "generate_report", { period: "year" })).isError).toBe(true);
  });

  it("search_knowledge_base answers from the workspace profile", async () => {
    db.seed("assistantProfile", { id: "pr1", workspaceId: WS_A, instagramAccountId: null, companyName: "Mebel A", description: "Divan va stol sotamiz", enabled: true });
    db.seed("assistantProduct", { id: "p1", profileId: "pr1", name: "Divan Milan", price: 3500000, currency: "UZS" });
    const hit = await callTool(read, "search_knowledge_base", { query: "divan" });
    expect(hit.isError, hit.text).toBe(false);
    expect(hit.data.found).toBe(true);
    expect(JSON.stringify(hit.data.lines)).toMatch(/Divan/);
  });

  it("search_knowledge_base without a profile says the base is empty", async () => {
    const miss = await callTool(read, "search_knowledge_base", { query: "divan" });
    expect(miss.data.found).toBe(false);
    expect(miss.data.note).toMatch(/to'ldirilmagan/);
  });

  it("run_diagnostics returns each check with the recommended action label", async () => {
    const { data } = await callTool(read, "run_diagnostics");
    expect(data.checks[0]).toMatchObject({ key: "token", status: "warning", action: "Qayta ulang" });
    expect(JSON.stringify(data)).not.toContain("/settings");
  });

  it("get_kpi returns the workspace KPI without platform-wide queue depths", async () => {
    const { data } = await callTool(read, "get_kpi");
    expect(data.connections.total).toBe(1);
    expect(data).not.toHaveProperty("queueDepths");
  });
});
