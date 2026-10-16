/**
 * ETAP 12 — the write tools through the real services: create_keyword_campaign
 * (paused by default, publish only with a healthy connection), update_campaign,
 * pause_campaign, add_lead_tag, set_lead_stage and create_flow_draft (saved as
 * an AI-source DRAFT, never published; the previewed graph is what is saved).
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("@/lib/triggers/ingest", () => ({ forgetAccountGate: vi.fn() }));
const publishMocks = vi.hoisted(() => ({ publishFlowVersion: vi.fn(), unpublishFlow: vi.fn(), archiveFlow: vi.fn() }));
vi.mock("@/lib/flows/publish", () => publishMocks);

import { type LLMProvider, type LlmRequest, setLlmProviderForTests } from "../lib/assistant/llm/provider";
import { hashGraph } from "../lib/flows/canonical";
import { findStarterTemplate } from "../lib/flows/templates";
import { resetMcpRateLimitsForTests } from "../lib/mcp/auth";
import { callTool, makeToken, rpc, seedWorld, WS_A } from "./helpers/mcp-world";

let write: string;

async function run(tool: string, args: Record<string, unknown>) {
  const proposal = await callTool(write, tool, args);
  expect(proposal.isError, proposal.text).toBe(false);
  expect(proposal.data.status).toBe("PREVIEW");
  const done = await callTool(write, "confirm_action", { actionId: proposal.data.actionId, confirmCode: proposal.data.confirmCode });
  return { proposal: proposal.data, done };
}

const row = (model: string, id: string) => db.rows(model).find((r) => r.id === id)!;

beforeEach(async () => {
  resetDb();
  resetMcpRateLimitsForTests();
  setLlmProviderForTests(undefined);
  for (const fn of Object.values(publishMocks)) fn.mockReset();
  seedWorld();
  write = (await makeToken(WS_A, "WRITE")).raw;
});

describe("create_keyword_campaign", () => {
  const input = { name: "Narx so'rovi", instagramAccountId: "acA", keywords: ["narx", "NARX", "цена"], dmMessage: "Narx 100 000 so'm. Buyurtma uchun yozing.", publicReplies: ["Direct'ga yubordik!", "Tekshiring, DM'da narx bor"] };

  it("creates a PAUSED comment campaign with keywords, DM text and public replies", async () => {
    const { done } = await run("create_keyword_campaign", input);
    expect(done.data.result).toMatchObject({ status: "PAUSED", published: false });
    const campaign = row("triggerCampaign", done.data.result.campaignId);
    expect(campaign).toMatchObject({ workspaceId: WS_A, instagramAccountId: "acA", triggerType: "COMMENT", active: false, publicReplyEnabled: true, responseMessage: input.dmMessage, mediaScope: "ANY" });
    expect(campaign.keywords).toEqual(["narx", "цена"]); // normalised and de-duplicated by the campaign service
    const variants = db.rows("triggerReplyVariant").filter((v) => v.campaignId === campaign.id);
    expect(variants.map((v) => [v.kind, v.text]).sort()).toEqual([["PUBLIC", "Direct'ga yubordik!"], ["PUBLIC", "Tekshiring, DM'da narx bor"]]);
    expect(variants.every((v) => v.approvedAt)).toBe(true);
  });

  it("publish: true goes live when the Instagram connection is healthy", async () => {
    const { proposal, done } = await run("create_keyword_campaign", { ...input, publish: true });
    expect(proposal.preview.details.willPublish).toBe(true);
    expect(done.data.result).toMatchObject({ status: "ACTIVE", published: true });
    expect(row("triggerCampaign", done.data.result.campaignId).active).toBe(true);
  });

  it("publish: true on a broken connection stays a draft and says why (preview warns, result notes)", async () => {
    row("instagramAccount", "acA").tokenStatus = "EXPIRED";
    const { proposal, done } = await run("create_keyword_campaign", { ...input, publish: true });
    expect(proposal.preview.warnings.join(" ")).toMatch(/Nashr qilinmaydi/);
    expect(done.data.result).toMatchObject({ status: "PAUSED", published: false });
    expect(done.data.result.notes.join(" ")).toMatch(/ulanishi faol emas/);
    expect(row("triggerCampaign", done.data.result.campaignId).active).toBe(false);
  });

  it("warns when an active campaign already uses the keyword", async () => {
    const proposal = await callTool(write, "create_keyword_campaign", input);
    expect(proposal.data.preview.warnings.join(" ")).toMatch(/Narx A/);
  });

  it("rejects what the campaign service would reject (too long DM, no keyword) before any proposal", async () => {
    expect((await callTool(write, "create_keyword_campaign", { ...input, dmMessage: "x".repeat(1001) })).isError).toBe(true);
    expect((await callTool(write, "create_keyword_campaign", { ...input, keywords: ["  "] })).isError).toBe(true);
    expect(db.rows("mcpAction")).toHaveLength(0);
  });
});

describe("update_campaign / pause_campaign", () => {
  it("renames and replaces keywords and DM text, keeping the rest", async () => {
    const { proposal, done } = await run("update_campaign", { campaignId: "cmpA", name: "Narx (yangi)", keywords: ["narx", "qancha"], dmMessage: "Yangi narx 90 000" });
    expect(proposal.preview.details.changes.name).toEqual({ from: "Narx A", to: "Narx (yangi)" });
    expect(done.data.result).toMatchObject({ campaignId: "cmpA", status: "ACTIVE" });
    expect(row("triggerCampaign", "cmpA")).toMatchObject({ name: "Narx (yangi)", responseMessage: "Yangi narx 90 000", active: true, mediaScope: "ANY" });
    expect(row("triggerCampaign", "cmpA").keywords).toEqual(["narx", "qancha"]);
  });

  it("replaces the public replies", async () => {
    const { done } = await run("update_campaign", { campaignId: "cmpA", publicReplies: ["Rahmat!"] });
    expect(done.isError).toBe(false);
    expect(row("triggerCampaign", "cmpA").publicReplyEnabled).toBe(true);
    expect(db.rows("triggerReplyVariant").filter((v) => v.campaignId === "cmpA").map((v) => v.text)).toEqual(["Rahmat!"]);
  });

  it("pauses and resumes; resuming needs a healthy connection", async () => {
    await run("update_campaign", { campaignId: "cmpA", active: false });
    expect(row("triggerCampaign", "cmpA").active).toBe(false);
    row("instagramAccount", "acA").tokenStatus = "REVOKED";
    const blocked = await run("update_campaign", { campaignId: "cmpA", active: true });
    expect(blocked.proposal.preview.warnings.join(" ")).toMatch(/Yoqilmaydi/);
    expect(blocked.done.data.result.status).toBe("PAUSED");
    expect(row("triggerCampaign", "cmpA").active).toBe(false);
    row("instagramAccount", "acA").tokenStatus = "ACTIVE";
    const resumed = await run("update_campaign", { campaignId: "cmpA", active: true });
    expect(resumed.done.data.result.status).toBe("ACTIVE");
    expect(row("triggerCampaign", "cmpA").active).toBe(true);
  });

  it("update_campaign needs at least one change", async () => {
    const result = await callTool(write, "update_campaign", { campaignId: "cmpA" });
    expect(result.isError).toBe(true);
    expect(db.rows("mcpAction")).toHaveLength(0);
  });

  it("pause_campaign pauses and deletes nothing", async () => {
    const { done } = await run("pause_campaign", { campaignId: "cmpA" });
    expect(done.data.result).toEqual({ campaignId: "cmpA", status: "PAUSED" });
    expect(row("triggerCampaign", "cmpA").active).toBe(false);
    expect(db.rows("triggerCampaign").filter((c) => c.workspaceId === WS_A)).toHaveLength(1);
  });
});

describe("leads", () => {
  it("add_lead_tag creates the tag, links it once and records an activity", async () => {
    const first = await run("add_lead_tag", { leadId: "ctA", tag: "VIP mijoz" });
    expect(first.proposal.preview.warnings.join(" ")).toMatch(/yangi teg/);
    expect(first.done.data.result).toMatchObject({ leadId: "ctA", tag: "VIP mijoz", added: true });
    expect(db.rows("crmTag").filter((t) => t.workspaceId === WS_A)).toHaveLength(1);
    expect(db.rows("crmContactTag")).toHaveLength(1);
    expect(db.rows("crmContactTag")[0].origin).toBe("AI");
    expect(db.rows("crmActivity").some((a) => a.type === "TAG_ADDED")).toBe(true);

    const second = await run("add_lead_tag", { leadId: "ctA", tag: "VIP mijoz" });
    expect(second.proposal.preview.warnings.join(" ")).toMatch(/allaqachon/);
    expect(second.done.data.result.added).toBe(false);
    expect(db.rows("crmContactTag")).toHaveLength(1);
  });

  it("the tag shows up in list_leads and works as a filter", async () => {
    await run("add_lead_tag", { leadId: "ctA", tag: "vip" });
    const listed = await callTool(write, "list_leads", { tag: "vip" });
    expect(listed.data.leads).toHaveLength(1);
    expect(listed.data.leads[0].tags).toEqual(["vip"]);
  });

  it("set_lead_stage moves the lead and shows the previous stage in the preview", async () => {
    const { proposal, done } = await run("set_lead_stage", { leadId: "ctA", stage: "CUSTOMER" });
    expect(proposal.preview.details).toMatchObject({ from: "NEW", to: "CUSTOMER" });
    expect(done.data.result).toEqual({ leadId: "ctA", stage: "CUSTOMER" });
    expect(row("crmContact", "ctA").status).toBe("CUSTOMER");
    expect(db.rows("crmActivity").some((a) => a.type === "FIELD_CHANGED")).toBe(true);
  });

  it("an invalid stage is refused at the schema", async () => {
    expect((await callTool(write, "set_lead_stage", { leadId: "ctA", stage: "WON" })).isError).toBe(true);
  });
});

describe("create_flow_draft", () => {
  const graph = findStarterTemplate("comment_price_lead")!.graph;

  it("previews the graph summary and findings, then saves a DRAFT with source AI (never published)", async () => {
    const proposal = await callTool(write, "create_flow_draft", { instagramAccountId: "acA", name: "MCP narx oqimi", graph });
    expect(proposal.isError, proposal.text).toBe(false);
    expect(proposal.data.preview.details.graph).toMatchObject({ trigger: { type: "COMMENT" } });
    expect(proposal.data.preview.details.graph.nodeCount).toBe(graph.nodes.length);
    expect(proposal.data.preview.details.policy.verdict).toMatch(/PASS|WARNING|BLOCKED/);
    expect(proposal.data.preview.details.audit).toBeDefined();
    expect(proposal.data.preview.warnings.join(" ")).toMatch(/Nashr qilish MCP orqali mumkin emas/);
    expect(db.rows("flow")).toHaveLength(0); // the preview saved nothing

    const done = await callTool(write, "confirm_action", { actionId: proposal.data.actionId, confirmCode: proposal.data.confirmCode });
    expect(done.isError, done.text).toBe(false);
    expect(done.data.result).toMatchObject({ status: "DRAFT", source: "AI" });
    const flow = row("flow", done.data.result.flowId);
    expect(flow).toMatchObject({ workspaceId: WS_A, instagramAccountId: "acA", name: "MCP narx oqimi", status: "DRAFT" });
    expect(flow.publishedVersionId ?? null).toBeNull();
    const version = db.rows("flowVersion").find((v) => v.flowId === flow.id)!;
    expect(version.source).toBe("AI");
    expect(version.publishedAt ?? null).toBeNull();
    expect(version.hash).toBe(hashGraph(graph));
    for (const fn of Object.values(publishMocks)) expect(fn).not.toHaveBeenCalled();
  });

  it("there is no tool that publishes a flow", async () => {
    const result = await rpc(write, "tools/call", { name: "publish_flow", arguments: { flowId: "x" } });
    expect(result.json.error.code).toBe(-32602);
    const list = await rpc(write, "tools/list");
    expect(JSON.stringify(list.json)).not.toMatch(/publish_flow|publishVersion/);
  });

  it("an invalid graph is refused at the preview", async () => {
    const result = await callTool(write, "create_flow_draft", { instagramAccountId: "acA", graph: { v: 1, nodes: [], edges: [] } });
    expect(result.isError).toBe(true);
    expect(db.rows("mcpAction")).toHaveLength(0);
  });

  it("without an LLM the builder path is a clear tool error, not a crash", async () => {
    const result = await callTool(write, "create_flow_draft", { instagramAccountId: "acA", request: "Komment narx desa narx va telefon so'ra" });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/AI sozlanmagan/);
    expect(db.rows("mcpAction")).toHaveLength(0);
  });

  it("with the AI builder, what was previewed is what is saved", async () => {
    const calls: LlmRequest[] = [];
    const fake: LLMProvider = {
      name: "fake",
      model: "fake-model",
      costUsd: () => 0.01,
      async complete(request: LlmRequest) {
        calls.push(request);
        return { json: { name: "AI narx oqimi", summary: "Komment, narx, lead", graph }, inputTokens: 100, outputTokens: 200, model: "fake-model", latencyMs: 5 };
      },
    };
    setLlmProviderForTests(fake);
    const proposal = await callTool(write, "create_flow_draft", { instagramAccountId: "acA", request: "Komment narx desa narx va telefon so'ra" });
    expect(proposal.isError, proposal.text).toBe(false);
    expect(calls).toHaveLength(1);
    expect(proposal.data.preview.summary).toMatch(/AI narx oqimi/);
    const done = await callTool(write, "confirm_action", { actionId: proposal.data.actionId, confirmCode: proposal.data.confirmCode });
    expect(calls).toHaveLength(1); // confirming does not call the model again
    const version = db.rows("flowVersion").find((v) => v.flowId === done.data.result.flowId)!;
    expect(version.hash).toBe(hashGraph(graph));
    expect(version.source).toBe("AI");
    expect(String(version.prompt)).toMatch(/Komment narx/);
    setLlmProviderForTests(undefined);
  });
});
