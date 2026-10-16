/**
 * ETAP 12 — tenant isolation, the first review item: a token of workspace A
 * can neither see nor change anything of workspace B through any tool, foreign
 * ids read as "not found", the lead card has no phone / e-mail, tokens of the
 * Instagram account never leave, and platform-wide numbers are stripped.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({
  loadKpi: vi.fn(),
  runDiagnostics: vi.fn(),
}));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("@/lib/triggers/ingest", () => ({ forgetAccountGate: vi.fn() }));
vi.mock("@/lib/analytics/kpi", () => ({ loadKpi: mocks.loadKpi }));
vi.mock("@/lib/foundation/diagnostics", () => ({ runDiagnostics: mocks.runDiagnostics }));

import { resetMcpRateLimitsForTests } from "../lib/mcp/auth";
import { callTool, makeToken, seedFlows, seedWorld, WS_A, WS_B } from "./helpers/mcp-world";

let a: string;
let b: string;
let flows: { a: string; b: string };

beforeEach(async () => {
  resetDb();
  resetMcpRateLimitsForTests();
  mocks.loadKpi.mockReset();
  mocks.runDiagnostics.mockReset();
  mocks.loadKpi.mockImplementation(async (workspaceId: string) => ({ workspaceId, queueDepths: [{ queue: "platform-wide" }], connections: { total: 1, healthy: 1, broken: 0 }, failed: [] }));
  mocks.runDiagnostics.mockImplementation(async (workspaceId: string) => [
    { key: "connection", label: "Ulanish", status: "ok", value: workspaceId, meaning: "m", lastCheck: null, issue: null, action: null },
  ]);
  seedWorld();
  flows = await seedFlows();
  a = (await makeToken(WS_A, "WRITE", "A")).raw;
  b = (await makeToken(WS_B, "WRITE", "B")).raw;
});

const everythingA = [
  ["list_campaigns", {}],
  ["list_flows", {}],
  ["list_leads", {}],
  ["list_instagram_accounts", {}],
  ["get_kpi", {}],
  ["run_diagnostics", {}],
] as const;

describe("reads see only the token's workspace", () => {
  it("list tools return workspace A rows only", async () => {
    const campaigns = await callTool(a, "list_campaigns");
    expect(campaigns.data.campaigns.map((c: { id: string }) => c.id)).toEqual(["cmpA"]);
    const flowList = await callTool(a, "list_flows");
    expect(flowList.data.flows.map((f: { id: string }) => f.id)).toEqual([flows.a]);
    const leads = await callTool(a, "list_leads");
    expect(leads.data.leads.map((l: { id: string }) => l.id)).toEqual(["ctA"]);
    const accounts = await callTool(a, "list_instagram_accounts");
    expect(accounts.data.accounts.map((x: { id: string }) => x.id)).toEqual(["acA"]);
  });

  it("workspace B's token sees B's rows, not A's", async () => {
    expect((await callTool(b, "list_campaigns")).data.campaigns.map((c: { id: string }) => c.id)).toEqual(["cmpB"]);
    expect((await callTool(b, "list_leads")).data.leads.map((l: { id: string }) => l.id)).toEqual(["ctB"]);
  });

  it("get_campaign / get_flow of a foreign id say not found, same as a missing id", async () => {
    const foreign = await callTool(a, "get_campaign", { campaignId: "cmpB" });
    const missing = await callTool(a, "get_campaign", { campaignId: "nope" });
    expect(foreign.isError).toBe(true);
    expect(foreign.text).toBe(missing.text);
    expect(foreign.text).not.toContain("Narx B");
    const flowForeign = await callTool(a, "get_flow", { flowId: flows.b });
    const flowMissing = await callTool(a, "get_flow", { flowId: "nope" });
    expect(flowForeign.isError).toBe(true);
    expect(flowForeign.text).toBe(flowMissing.text);
    expect((await callTool(a, "get_flow", { flowId: flows.a })).isError).toBe(false);
  });

  it("lead filters cannot reach workspace B (search, tag, stage, cursor)", async () => {
    expect((await callTool(a, "list_leads", { search: "Vali Boshqa" })).data.leads).toHaveLength(0);
    expect((await callTool(a, "list_leads", { search: "Boshqa" })).data.leads).toHaveLength(0);
    expect((await callTool(a, "list_leads", { cursor: "ctB" })).data.leads).toHaveLength(0);
    expect((await callTool(a, "list_leads", { tag: "no-such-tag" })).data.leads).toHaveLength(0);
    expect((await callTool(a, "list_leads", { stage: "NEW" })).data.leads.map((l: { id: string }) => l.id)).toEqual(["ctA"]);
  });

  it("KPI and diagnostics are computed for the token's workspace and KPI drops platform-wide queues", async () => {
    const kpi = await callTool(a, "get_kpi");
    expect(mocks.loadKpi).toHaveBeenCalledWith(WS_A);
    expect(kpi.data.queueDepths).toBeUndefined();
    expect(kpi.text).not.toContain("platform-wide");
    await callTool(a, "run_diagnostics");
    expect(mocks.runDiagnostics).toHaveBeenCalledWith(WS_A);
    expect(mocks.runDiagnostics).not.toHaveBeenCalledWith(WS_B);
  });

  it("analytics for a foreign account is refused", async () => {
    const result = await callTool(a, "get_analytics_summary", { accountId: "acB" });
    expect(result.isError).toBe(true);
    const report = await callTool(a, "generate_report", { accountId: "acB" });
    expect(report.isError).toBe(true);
    expect((await callTool(a, "get_analytics_summary", { tab: "campaign", period: "7d" })).isError).toBe(false);
  });

  it("knowledge base search with a foreign account is refused", async () => {
    const result = await callTool(a, "search_knowledge_base", { query: "narx", accountId: "acB" });
    expect(result.isError).toBe(true);
  });
});

describe("what leaves is minimal", () => {
  it("no read tool leaks phone, e-mail, Instagram tokens or user ids", async () => {
    const texts: string[] = [];
    for (const [name, args] of everythingA) texts.push((await callTool(a, name, args)).text);
    texts.push((await callTool(a, "get_campaign", { campaignId: "cmpA" })).text);
    texts.push((await callTool(a, "get_flow", { flowId: flows.a })).text);
    const all = texts.join("\n");
    for (const secret of ["+998901112233", "ali@example.com", "998901112233", "SECRET_TOKEN_A", "SECRET_TOKEN_B", "igu_a", "accessToken", "phoneE164", "email"]) {
      expect(all).not.toContain(secret);
    }
  });

  it("the lead card has exactly the minimal fields", async () => {
    const [lead] = (await callTool(a, "list_leads")).data.leads;
    expect(Object.keys(lead).sort()).toEqual(["id", "lastMessageAt", "name", "stage", "tags", "temperature", "username"]);
    expect(lead.name).toBe("Ali Valiyev");
  });

  it("a search by phone number does not find the lead", async () => {
    expect((await callTool(a, "list_leads", { search: "998901112233" })).data.leads).toHaveLength(0);
  });
});

describe("writes cannot touch workspace B", () => {
  const foreignWrites: Array<[string, Record<string, unknown>]> = [
    ["pause_campaign", { campaignId: "cmpB" }],
    ["update_campaign", { campaignId: "cmpB", name: "Hacked" }],
    ["update_campaign", { campaignId: "cmpB", active: false }],
    ["add_lead_tag", { leadId: "ctB", tag: "vip" }],
    ["set_lead_stage", { leadId: "ctB", stage: "LOST" }],
    ["create_keyword_campaign", { name: "X", instagramAccountId: "acB", keywords: ["narx"], dmMessage: "salom" }],
    ["create_flow_draft", { instagramAccountId: "acB", request: "Komment narx desa narx yubor" }],
  ];

  it.each(foreignWrites)("%s on a foreign id fails at the preview, no proposal is stored", async (tool, args) => {
    const result = await callTool(a, tool, args);
    expect(result.isError).toBe(true);
    expect(db.rows("mcpAction")).toHaveLength(0);
    const campaignB = db.rows("triggerCampaign").find((c) => c.id === "cmpB")!;
    expect(campaignB.active).toBe(true);
    expect(campaignB.name).toBe("Narx B");
    expect(db.rows("crmContact").find((c) => c.id === "ctB")!.status).toBe("NEW");
    expect(db.rows("crmContactTag")).toHaveLength(0);
    expect(db.rows("flow").filter((f) => f.workspaceId === WS_B)).toHaveLength(1);
  });

  it("confirm_action / reject_action with workspace B's action id reads as not found and leaves it PROPOSED", async () => {
    const proposal = await callTool(b, "pause_campaign", { campaignId: "cmpB" });
    expect(proposal.data.status).toBe("PREVIEW");
    const actionId: string = proposal.data.actionId;

    const confirm = await callTool(a, "confirm_action", { actionId, confirmCode: proposal.data.confirmCode });
    expect(confirm.isError).toBe(true);
    expect(confirm.text).toMatch(/topilmadi/);
    expect((await callTool(a, "reject_action", { actionId })).isError).toBe(true);

    const row = db.rows("mcpAction").find((r) => r.id === actionId)!;
    expect(row.status).toBe("PROPOSED");
    expect(db.rows("triggerCampaign").find((c) => c.id === "cmpB")!.active).toBe(true);
    // ...and B itself can still confirm it
    const ok = await callTool(b, "confirm_action", { actionId, confirmCode: proposal.data.confirmCode });
    expect(ok.data.status).toBe("EXECUTED");
    expect(db.rows("triggerCampaign").find((c) => c.id === "cmpB")!.active).toBe(false);
    expect(db.rows("triggerCampaign").find((c) => c.id === "cmpA")!.active).toBe(true);
  });

  it("an action row forged to point at workspace B cannot execute against it", async () => {
    // A proposal row in workspace A whose stored input names a campaign of B: execution is scoped by the token's workspace.
    const token = db.rows("mcpToken").find((r) => r.workspaceId === WS_A)!;
    const row = db.seed("mcpAction", {
      workspaceId: WS_A,
      tokenId: token.id,
      tool: "pause_campaign",
      input: { campaignId: "cmpB" },
      preview: { summary: "forged" },
      status: "PROPOSED",
      expiresAt: new Date(Date.now() + 60_000),
      confirmCodeHash: null,
    });
    const confirm = await callTool(a, "confirm_action", { actionId: String(row.id), confirmCode: "AAAA-AAAA" });
    expect(confirm.isError).toBe(true);
    expect(db.rows("triggerCampaign").find((c) => c.id === "cmpB")!.active).toBe(true);
  });
});
