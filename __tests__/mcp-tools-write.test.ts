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
const variantFailure = vi.hoisted(() => ({ on: false }));
vi.mock("@/lib/triggers/campaign-editing", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../lib/triggers/campaign-editing")>();
  return { ...actual, writeVariants: (...args: Parameters<typeof actual.writeVariants>) => (variantFailure.on ? Promise.reject(new Error("boom")) : actual.writeVariants(...args)) };
});

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
  variantFailure.on = false;
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
    // M1: reply texts are NOT auto-approved - a person approves them in the app.
    expect(variants.every((v) => v.approvedAt === null || v.approvedAt === undefined)).toBe(true);
  });

  it("M1: `publish` is not an option any more - the call is refused and nothing is proposed", async () => {
    const result = await callTool(write, "create_keyword_campaign", { ...input, publish: true });
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/publish/);
    expect(db.rows("mcpAction")).toHaveLength(0);
    const list = await rpc(write, "tools/list");
    const tool = list.json.result.tools.find((t: { name: string }) => t.name === "create_keyword_campaign");
    expect(JSON.stringify(tool.inputSchema)).not.toMatch(/publish/);
  });

  it("M1: always created paused, even on a healthy connection; the preview says a person must switch it on", async () => {
    const { proposal, done } = await run("create_keyword_campaign", input);
    expect(proposal.preview.details).toMatchObject({ willPublish: false, repliesApproved: false });
    expect(done.data.result).toMatchObject({ status: "PAUSED", published: false });
    expect(row("triggerCampaign", done.data.result.campaignId).active).toBe(false);
  });

  it("L4: when saving the reply variants fails, the half-made campaign is deleted again", async () => {
    const before = db.rows("triggerCampaign").length;
    const proposal = await callTool(write, "create_keyword_campaign", input);
    vi.spyOn(console, "error").mockImplementation(() => {});
    variantFailure.on = true;
    const done = await callTool(write, "confirm_action", { actionId: proposal.data.actionId, confirmCode: proposal.data.confirmCode });
    variantFailure.on = false;
    expect(done.isError).toBe(true);
    expect(db.rows("triggerCampaign")).toHaveLength(before);
    expect(row("mcpAction", proposal.data.actionId).status).toBe("FAILED");
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
  const pausedCampaign = () =>
    db.seed("triggerCampaign", { id: "cmpP", workspaceId: WS_A, instagramAccountId: "acA", name: "Pauza", triggerType: "COMMENT", keywords: ["x"], matchingMode: "CONTAINS", responseMessage: "y", active: false, mediaScope: "ANY", mediaIds: [], intents: [], priority: 0, replyMode: "RANDOM", publicReplyEnabled: false, openingButtonLabel: null, mainMessage: null, stopOnReply: true, stopOnLead: true, stopOnHandoff: true, kind: "CAMPAIGN" });

  it("renames and replaces keywords of an ACTIVE campaign (no reply text), keeping the rest and the status", async () => {
    const { proposal, done } = await run("update_campaign", { campaignId: "cmpA", name: "Narx (yangi)", keywords: ["narx", "qancha"] });
    expect(proposal.preview.details.changes.name).toEqual({ from: "Narx A", to: "Narx (yangi)" });
    expect(done.data.result).toMatchObject({ campaignId: "cmpA", status: "ACTIVE" });
    expect(row("triggerCampaign", "cmpA")).toMatchObject({ name: "Narx (yangi)", responseMessage: "Narx 100 000 so'm", active: true, mediaScope: "ANY" });
    expect(row("triggerCampaign", "cmpA").keywords).toEqual(["narx", "qancha"]);
  });

  it("M1: the reply TEXT of an ACTIVE campaign cannot be edited (refused at the preview and nothing is proposed)", async () => {
    const dm = await callTool(write, "update_campaign", { campaignId: "cmpA", dmMessage: "Yangi narx 90 000" });
    expect(dm.isError).toBe(true);
    expect(dm.text).toMatch(/Faol kampaniya/);
    const pub = await callTool(write, "update_campaign", { campaignId: "cmpA", publicReplies: ["Rahmat!"] });
    expect(pub.isError).toBe(true);
    expect(db.rows("mcpAction")).toHaveLength(0);
    expect(row("triggerCampaign", "cmpA").responseMessage).toBe("Narx 100 000 so'm");
  });

  it("M1: a campaign switched on in the app between preview and confirm still cannot get new reply text", async () => {
    pausedCampaign();
    const proposal = await callTool(write, "update_campaign", { campaignId: "cmpP", dmMessage: "Yangi matn" });
    expect(proposal.isError).toBe(false);
    row("triggerCampaign", "cmpP").active = true;
    const done = await callTool(write, "confirm_action", { actionId: proposal.data.actionId, confirmCode: proposal.data.confirmCode });
    expect(done.isError).toBe(true);
    expect(row("triggerCampaign", "cmpP").responseMessage).toBe("y");
  });

  it("M1: a PAUSED campaign's texts can change; new public replies are saved UNAPPROVED and the campaign stays paused", async () => {
    pausedCampaign();
    const { proposal, done } = await run("update_campaign", { campaignId: "cmpP", dmMessage: "Yangi matn", publicReplies: ["Rahmat!"] });
    expect(proposal.preview.warnings.join(" ")).toMatch(/tasdiqlanmagan/);
    expect(done.isError).toBe(false);
    expect(done.data.result.status).toBe("PAUSED");
    expect(row("triggerCampaign", "cmpP")).toMatchObject({ active: false, responseMessage: "Yangi matn", publicReplyEnabled: true });
    const variants = db.rows("triggerReplyVariant").filter((v) => v.campaignId === "cmpP");
    expect(variants.map((v) => v.text)).toEqual(["Rahmat!"]);
    expect(variants.every((v) => !v.approvedAt)).toBe(true);
  });

  it("M1: `active` is not accepted by update_campaign (no resume / go-live over MCP)", async () => {
    pausedCampaign();
    const result = await callTool(write, "update_campaign", { campaignId: "cmpP", active: true });
    expect(result.isError).toBe(true);
    expect(db.rows("mcpAction")).toHaveLength(0);
    expect(row("triggerCampaign", "cmpP").active).toBe(false);
    const list = await rpc(write, "tools/list");
    const tool = list.json.result.tools.find((t: { name: string }) => t.name === "update_campaign");
    expect(JSON.stringify(tool.inputSchema)).not.toMatch(/"active"/);
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
