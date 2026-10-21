/**
 * ETAP 12 — the MCP tool registry. Each tool is a typed zod input schema (the
 * source of the JSON Schema in tools/list), a scope (READ / WRITE) and either
 * `run` (read tools, control tools) or `propose` + `execute` (write tools).
 *
 * Descriptions are English: the reader is an LLM. Results and errors that a
 * person may see are Uzbek Latin.
 *
 * Write tools NEVER execute directly. `propose` validates, checks that every
 * referenced id belongs to the token's workspace, and returns a preview; the
 * proposal is stored by lib/mcp/confirm and runs only through confirm_action.
 * There is deliberately no tool that publishes a flow (see README).
 */

import { z } from "zod";
import { ANALYTICS_TABS } from "@/lib/analytics/catalog";
import { confirmAction, rejectAction } from "./confirm";
import type { McpTokenContext } from "./auth";
import { MAX_LIST_LIMIT, UNTRUSTED_NOTE } from "./config";
import { McpServiceError } from "./errors";
import * as svc from "./service";

export type ToolScope = "READ" | "WRITE";

interface ToolBase {
  name: string;
  description: string;
  scope: ToolScope;
  input: z.ZodType;
  readOnly: boolean;
}

export interface ReadTool extends ToolBase {
  kind: "read";
  run: (ctx: McpTokenContext, input: never) => Promise<unknown>;
}

export interface WriteTool extends ToolBase {
  kind: "write";
  propose: (ctx: McpTokenContext, input: never) => Promise<{ preview: svc.Preview; stored: unknown }>;
  execute: (ctx: McpTokenContext, stored: unknown) => Promise<unknown>;
}

export interface ControlTool extends ToolBase {
  kind: "control";
  run: (ctx: McpTokenContext, input: never) => Promise<unknown>;
}

export type McpTool = ReadTool | WriteTool | ControlTool;

const limit = z.number().int().min(1).max(MAX_LIST_LIMIT).default(20).describe(`How many rows to return (1-${MAX_LIST_LIMIT}, default 20).`);
const period = z.enum(svc.PERIODS).default("7d").describe("today, 7d or 30d (days are counted in Tashkent time).");

const accountId = z.string().min(1).optional().describe("Optional Instagram account id (from list_instagram_accounts).");

function read<S extends z.ZodType>(def: { name: string; description: string; input: S; run: (ctx: McpTokenContext, input: z.infer<S>) => Promise<unknown> }): ReadTool {
  return { kind: "read", scope: "READ", readOnly: true, ...def } as unknown as ReadTool;
}

function write<S extends z.ZodType>(def: {
  name: string;
  description: string;
  input: S;
  propose: (ctx: McpTokenContext, input: z.infer<S>) => Promise<{ preview: svc.Preview; stored: unknown }>;
  execute: (ctx: McpTokenContext, stored: unknown) => Promise<unknown>;
}): WriteTool {
  return { kind: "write", scope: "WRITE", readOnly: false, ...def } as unknown as WriteTool;
}

const CONFIRM_NOTE =
  " This tool does NOT change anything: it returns status PREVIEW with an actionId and a confirmCode. Show the preview to the user, and only after they agree call confirm_action (tokens that require human approval cannot confirm: the user approves in /developer/mcp). Nothing done over MCP can make anything reach customers.";
const UNTRUSTED = ` ${UNTRUSTED_NOTE}`;

export const TOOLS: McpTool[] = [
  // ── READ ────────────────────────────────────────────────────────────────────
  read({
    name: "list_campaigns",
    description:
      "List comment-to-DM campaigns (keyword campaigns on posts / reels / live) of this workspace with status and basic stats. `legacyCampaigns` are campaigns of the older production engine: they are live too when ACTIVE, but read-only over MCP (get_campaign / update / pause do not apply to them).",
    input: z.object({ status: z.enum(["all", "active", "paused"]).default("all"), limit }),
    run: (ctx, input) => svc.listCampaignsView(ctx.workspaceId, input),
  }),
  read({
    name: "get_campaign",
    description: `Get one campaign: keywords, DM text, comment-reply variants (with approval state), status. Use an id from list_campaigns.${UNTRUSTED}`,
    input: z.object({ campaignId: z.string().min(1) }),
    run: (ctx, input) => svc.campaignView(ctx.workspaceId, input.campaignId),
  }),
  read({
    name: "list_flows",
    description: "List automation flows (visual flow builder) with status DRAFT / REVIEW / PUBLISHED / ARCHIVED.",
    input: z.object({ status: z.enum(["DRAFT", "REVIEW", "PUBLISHED", "ARCHIVED"]).optional(), limit }),
    run: (ctx, input) => svc.listFlowsView(ctx.workspaceId, input),
  }),
  read({
    name: "get_flow",
    description: `Get one flow: status, versions, a summary of the graph (trigger, node counts, message texts) and the latest audit / policy findings.${UNTRUSTED}`,
    input: z.object({ flowId: z.string().min(1) }),
    run: (ctx, input) => svc.flowView(ctx.workspaceId, input.flowId),
  }),
  read({
    name: "list_leads",
    description: `List leads (CRM contacts) with minimal fields: name, Instagram username (both under \`untrusted\`), stage (NEW, ACTIVE, CUSTOMER, LOST, ARCHIVED), tags, last activity time. Phone numbers and e-mails are never returned. Use nextCursor to page. A \`note\` explains an empty list caused by the CRM module being off (then the analytics "Lidlar" count can be non-zero while this list is empty).${UNTRUSTED}`,
    input: z.object({
      stage: z.enum(svc.LEAD_STAGES).optional(),
      tag: z.string().trim().min(1).max(40).optional().describe("Tag name or slug."),
      search: z.string().trim().min(1).max(60).optional().describe("Matches name or username."),
      since: z.string().datetime({ offset: true }).optional().describe("ISO date-time: last activity at or after."),
      until: z.string().datetime({ offset: true }).optional().describe("ISO date-time: last activity at or before."),
      limit,
      cursor: z.string().min(1).max(64).optional(),
    }),
    run: (ctx, input) => svc.listLeadsView(ctx.workspaceId, input),
  }),
  read({
    name: "get_analytics_summary",
    description: "Analytics numbers for a period with comparison to the previous period. tab: campaign (sent / opened / leads), ai, sales or funnel.",
    input: z.object({ tab: z.enum(ANALYTICS_TABS as [string, ...string[]]).default("campaign"), period, accountId }),
    run: (ctx, input) => svc.analyticsView(ctx.workspaceId, { tab: input.tab as never, period: input.period, accountId: input.accountId }),
  }),
  read({
    name: "get_kpi",
    description: "Live operational KPIs of this workspace: connections, active campaigns, messages per minute, errors, AI latency and cost today, worker health.",
    input: z.object({}),
    run: (ctx) => svc.kpiView(ctx.workspaceId),
  }),
  read({
    name: "list_instagram_accounts",
    description: "List connected Instagram accounts with connection status and token expiry. Tokens themselves are never returned.",
    input: z.object({}),
    run: async (ctx) => ({ accounts: await svc.listAccountsView(ctx.workspaceId) }),
  }),
  read({
    name: "run_diagnostics",
    description: "Run the platform health checks for this workspace (connection, token expiry, queue, worker, webhook, AI) and return each check with status and the recommended action.",
    input: z.object({}),
    run: async (ctx) => ({ checks: await svc.diagnosticsView(ctx.workspaceId) }),
  }),
  read({
    name: "generate_report",
    description: "Generate a plain-text (Uzbek) summary report of campaign, AI and sales analytics for a period.",
    input: z.object({ period, accountId }),
    run: async (ctx, input) => ({ report: await svc.reportText(ctx.workspaceId, input) }),
  }),
  read({
    name: "search_knowledge_base",
    description: `Search the business knowledge base (products, FAQs, policies) the AI sales assistant answers from.${UNTRUSTED}`,
    input: z.object({ query: z.string().trim().min(2).max(200), accountId }),
    run: (ctx, input) => svc.searchKnowledge(ctx.workspaceId, input),
  }),

  // ── WRITE (preview first) ───────────────────────────────────────────────────
  write({
    name: "create_keyword_campaign",
    description:
      "Create a comment keyword campaign: when someone comments one of the keywords (e.g. 'narx') on any post, SocialAuto optionally replies publicly under the comment and sends a DM. The campaign is ALWAYS created PAUSED and its public-reply texts are created UNAPPROVED; a person switches it on and approves the texts in the SocialAuto app (not possible over MCP)." +
      CONFIRM_NOTE,
    input: svc.createCampaignInput,
    propose: async (ctx, input: svc.CreateCampaignInput) => ({ preview: await svc.previewCreateCampaign(ctx.workspaceId, input), stored: input }),
    execute: (ctx, stored) => svc.executeCreateCampaign(ctx.workspaceId, stored),
  }),
  write({
    name: "update_campaign",
    description:
      "Change a comment campaign: rename, replace keywords, DM text or public comment replies. The reply TEXT (dmMessage / publicReplies) of an ACTIVE campaign cannot be edited over MCP (pause it first with pause_campaign); new public replies are saved unapproved. Switching a campaign on is not possible over MCP - only in the SocialAuto app." +
      CONFIRM_NOTE,
    input: svc.updateCampaignInput,
    propose: async (ctx, input: svc.UpdateCampaignInput) => ({ preview: await svc.previewUpdateCampaign(ctx.workspaceId, input), stored: input }),
    execute: (ctx, stored) => svc.executeUpdateCampaign(ctx.workspaceId, stored),
  }),
  write({
    name: "pause_campaign",
    description: "Pause (stop) a comment campaign immediately after confirmation. Nothing is deleted." + CONFIRM_NOTE,
    input: svc.pauseCampaignInput,
    propose: async (ctx, input: z.infer<typeof svc.pauseCampaignInput>) => ({ preview: await svc.previewPauseCampaign(ctx.workspaceId, input), stored: input }),
    execute: (ctx, stored) => svc.executePauseCampaign(ctx.workspaceId, stored),
  }),
  write({
    name: "create_flow_draft",
    description:
      "Create a flow DRAFT from a plain-language description (the AI Flow Builder writes the graph; it is validated, audited and policy-checked). The preview shows the graph summary and findings. The flow is saved as DRAFT only; publishing is NOT possible over MCP - a person must test and approve it in the Flows screen. Limited to a few AI generations per hour per token." +
      CONFIRM_NOTE + UNTRUSTED,
    input: svc.createFlowDraftInput,
    propose: (ctx, input: svc.CreateFlowDraftInput) => svc.previewCreateFlowDraft(ctx.workspaceId, input),
    execute: (ctx, stored) => svc.executeCreateFlowDraft(ctx.workspaceId, stored),
  }),
  write({
    name: "add_lead_tag",
    description: "Add a tag to a lead (CRM contact). The tag is created if it does not exist." + CONFIRM_NOTE + UNTRUSTED,
    input: svc.leadTagInput,
    propose: async (ctx, input: z.infer<typeof svc.leadTagInput>) => ({ preview: await svc.previewLeadTag(ctx.workspaceId, input), stored: input }),
    execute: (ctx, stored) => svc.executeLeadTag(ctx.workspaceId, stored),
  }),
  write({
    name: "set_lead_stage",
    description: "Move a lead (CRM contact) to a stage: NEW, ACTIVE, CUSTOMER, LOST or ARCHIVED." + CONFIRM_NOTE + UNTRUSTED,
    input: svc.leadStageInput,
    propose: async (ctx, input: z.infer<typeof svc.leadStageInput>) => ({ preview: await svc.previewLeadStage(ctx.workspaceId, input), stored: input }),
    execute: (ctx, stored) => svc.executeLeadStage(ctx.workspaceId, stored),
  }),
];

/** Runs a stored proposal (called by confirm_action after the code and expiry checks). */
export async function executeStored(tool: string, ctx: McpTokenContext, stored: unknown): Promise<unknown> {
  const def = TOOLS.find((t): t is WriteTool => t.kind === "write" && t.name === tool);
  if (!def) throw new McpServiceError(500, "Noma'lum amal turi");
  return def.execute(ctx, stored);
}

const CONTROL_TOOLS: McpTool[] = [
  {
    kind: "control",
    name: "confirm_action",
    description:
      "Execute a previously previewed write action. Needs the actionId and confirmCode from the PREVIEW answer, only works once, only within 10 minutes and only for the token that proposed it. Call it only after the user agreed to the preview. Tokens that require human approval (the default) get 'inson tasdig'i kerak' and the action stays PROPOSED until a person approves it in /developer/mcp. 5 wrong codes reject the action.",
    scope: "WRITE",
    readOnly: false,
    input: z.object({ actionId: z.string().min(1), confirmCode: z.string().min(1).max(32) }),
    run: (ctx: McpTokenContext, input: { actionId: string; confirmCode: string }) => confirmAction(ctx, input, executeStored),
  } as ControlTool,
  {
    kind: "control",
    name: "reject_action",
    description: "Cancel a previewed write action so it can never be executed.",
    scope: "WRITE",
    readOnly: false,
    input: z.object({ actionId: z.string().min(1) }),
    run: (ctx: McpTokenContext, input: { actionId: string }) => rejectAction(ctx, input),
  } as ControlTool,
];

export const ALL_TOOLS: McpTool[] = [...TOOLS, ...CONTROL_TOOLS];

export function findTool(name: string): McpTool | undefined {
  return ALL_TOOLS.find((t) => t.name === name);
}

/** Tools a token of this scope may call (a WRITE token can do everything a READ token can). */
export function toolsForScope(scope: ToolScope): McpTool[] {
  return ALL_TOOLS.filter((t) => t.scope === "READ" || scope === "WRITE");
}

export function inputSchemaOf(tool: McpTool): Record<string, unknown> {
  const schema = z.toJSONSchema(tool.input, { io: "input", unrepresentable: "any", target: "draft-7" }) as Record<string, unknown>;
  delete schema.$schema;
  return schema;
}

export interface ToolDescriptor {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  annotations: { readOnlyHint: boolean; destructiveHint: boolean; openWorldHint: boolean };
}

export function describeTool(tool: McpTool): ToolDescriptor {
  return {
    name: tool.name,
    description: tool.description,
    inputSchema: inputSchemaOf(tool),
    annotations: { readOnlyHint: tool.readOnly, destructiveHint: false, openWorldHint: false },
  };
}

/** Parses the arguments against the tool schema; returns the Uzbek-readable first issue on failure. */
export function parseArguments(tool: McpTool, args: unknown): { ok: true; data: unknown } | { ok: false; error: string } {
  const parsed = tool.input.safeParse(args ?? {});
  if (parsed.success) return { ok: true, data: parsed.data };
  const issue = parsed.error.issues[0];
  const path = issue?.path.join(".");
  return { ok: false, error: `Noto'g'ri argument${path ? ` (${path})` : ""}: ${issue?.message ?? "tekshiring"}` };
}
