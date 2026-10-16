/**
 * Shared fixtures of the ETAP 12 MCP tests: two workspaces with one Instagram
 * account, comment campaign, flow and lead each, tokens, and a tiny JSON-RPC
 * client over handleMcpPost. The test file must mock "@/lib/db/client" with
 * the shared in-memory db itself (vi.mock is hoisted per file).
 */

import { db } from "./db-instance";
import { handleMcpPost } from "../../lib/mcp/http";
import { createToken } from "../../lib/mcp/tokens";
import { createFlow } from "../../lib/flows/service";

export const WS_A = "wsA";
export const WS_B = "wsB";

export function seedWorld() {
  db.seed("workspace", { id: WS_A, ownerId: "uA", name: "Mebel A" });
  db.seed("workspace", { id: WS_B, ownerId: "uB", name: "Boshqa B" });
  db.seed("instagramAccount", { id: "acA", workspaceId: WS_A, username: "mebel_a", instagramId: "igA", tokenStatus: "ACTIVE", accessToken: "SECRET_TOKEN_A", connectedAt: new Date("2026-10-01T00:00:00Z") });
  db.seed("instagramAccount", { id: "acB", workspaceId: WS_B, username: "boshqa_b", instagramId: "igB", tokenStatus: "ACTIVE", accessToken: "SECRET_TOKEN_B", connectedAt: new Date("2026-10-01T00:00:00Z") });
  db.seed("triggerCampaign", {
    id: "cmpA",
    workspaceId: WS_A,
    instagramAccountId: "acA",
    name: "Narx A",
    triggerType: "COMMENT",
    keywords: ["narx"],
    matchingMode: "CONTAINS",
    responseMessage: "Narx 100 000 so'm",
    active: true,
    mediaScope: "ANY",
    mediaIds: [],
    intents: [],
    priority: 0,
    replyMode: "RANDOM",
    publicReplyEnabled: false,
    openingButtonLabel: null,
    mainMessage: null,
    stopOnReply: true,
    stopOnLead: true,
    stopOnHandoff: true,
    kind: "CAMPAIGN",
  });
  db.seed("triggerCampaign", {
    id: "cmpB",
    workspaceId: WS_B,
    instagramAccountId: "acB",
    name: "Narx B",
    triggerType: "COMMENT",
    keywords: ["narx"],
    matchingMode: "CONTAINS",
    responseMessage: "B javobi",
    active: true,
    mediaScope: "ANY",
    mediaIds: [],
    intents: [],
    priority: 0,
    replyMode: "RANDOM",
    publicReplyEnabled: false,
    openingButtonLabel: null,
    mainMessage: null,
    stopOnReply: true,
    stopOnLead: true,
    stopOnHandoff: true,
    kind: "CAMPAIGN",
  });
  db.seed("crmContact", {
    id: "ctA",
    workspaceId: WS_A,
    instagramAccountId: "acA",
    igUserId: "igu_a",
    username: "ali",
    name: "Ali Valiyev",
    phoneE164: "+998901112233",
    email: "ali@example.com",
    status: "NEW",
    lastInteractionAt: new Date("2026-10-10T10:00:00Z"),
  });
  db.seed("crmContact", {
    id: "ctB",
    workspaceId: WS_B,
    instagramAccountId: "acB",
    igUserId: "igu_b",
    username: "vali",
    name: "Vali Boshqa",
    phoneE164: "+998909998877",
    email: "vali@example.com",
    status: "NEW",
    lastInteractionAt: new Date("2026-10-11T10:00:00Z"),
  });
}

/** One DRAFT flow per workspace through the real service (so versions / audit exist). */
export async function seedFlows(): Promise<{ a: string; b: string }> {
  const a = await createFlow(WS_A, { instagramAccountId: "acA", fromTemplateKey: "comment_price_lead", name: "Flow A" }, { userId: "uA" });
  const b = await createFlow(WS_B, { instagramAccountId: "acB", fromTemplateKey: "comment_price_lead", name: "Flow B" }, { userId: "uB" });
  return { a: a.flow.id, b: b.flow.id };
}

export async function makeToken(workspaceId: string, scope: "READ" | "WRITE" = "READ", name = "test") {
  const created = await createToken(workspaceId, { name, scope }, "dev");
  return { raw: created.token, id: created.view.id };
}

export function mcpRequest(raw: string | null, body: unknown, extra: Record<string, string> = {}): Request {
  const headers: Record<string, string> = { "content-type": "application/json", ...extra };
  if (raw) headers.authorization = `Bearer ${raw}`;
  return new Request("http://localhost/api/mcp", { method: "POST", headers, body: typeof body === "string" ? body : JSON.stringify(body) });
}

export async function rpc(raw: string | null, method: string, params?: unknown, id: number | string = 1) {
  const res = await handleMcpPost(mcpRequest(raw, { jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }));
  const text = await res.text();
  return { status: res.status, headers: res.headers, json: text ? JSON.parse(text) : null, text };
}

export interface ToolCallResult {
  status: number;
  isError: boolean;
  text: string;
  data: any; // eslint-disable-line @typescript-eslint/no-explicit-any
  rpcError?: { code: number; message: string };
}

export async function callTool(raw: string, name: string, args: Record<string, unknown> = {}): Promise<ToolCallResult> {
  const { status, json } = await rpc(raw, "tools/call", { name, arguments: args });
  if (json?.error) return { status, isError: true, text: json.error.message, data: null, rpcError: json.error };
  const text: string = json?.result?.content?.[0]?.text ?? "";
  let data: unknown = null;
  try {
    data = JSON.parse(text);
  } catch {
    data = null;
  }
  return { status, isError: Boolean(json?.result?.isError), text, data };
}
