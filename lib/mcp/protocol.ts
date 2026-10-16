/**
 * ETAP 12 — a minimal MCP server over Streamable HTTP, JSON responses only
 * (spec 2025-03-26, with 2024-11-05 accepted at initialize). JSON-RPC 2.0:
 *
 *   initialize, notifications/initialized (202), ping, tools/list, tools/call
 *
 * Single messages only: a batch (JSON array) is refused (-32600). The server
 * never streams, never sends requests to the client and keeps no session, so
 * every POST stands alone and the bearer token authorises each one.
 *
 * Tool failures are results with isError (the model can read and react);
 * protocol problems are JSON-RPC errors.
 */

import type { McpTokenContext } from "./auth";
import { LATEST_PROTOCOL_VERSION, MAX_RESULT_CHARS, SERVER_INFO, SUPPORTED_PROTOCOL_VERSIONS, UNTRUSTED_NOTE } from "./config";
import { assertCanPropose, assertFlowGenerationBudget, proposeAction } from "./confirm";
import { describeError, McpServiceError, safeMessage } from "./errors";
import { describeTool, findTool, parseArguments, toolsForScope, type McpTool, type WriteTool } from "./tools";

export const RPC = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

type Id = string | number | null;

export interface RpcResponse {
  jsonrpc: "2.0";
  id: Id;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

/** `status` is the HTTP status; `body` null means an empty 202 (notification). */
export interface RpcOutcome {
  status: number;
  body: RpcResponse | null;
}

const rpcError = (id: Id, code: number, message: string, status = 200): RpcOutcome => ({
  status,
  body: { jsonrpc: "2.0", id, error: { code, message } },
});
const rpcResult = (id: Id, result: unknown): RpcOutcome => ({ status: 200, body: { jsonrpc: "2.0", id, result } });

export const INSTRUCTIONS =
  "SocialAuto control layer. Read tools answer immediately. Every write tool only returns a PREVIEW with an actionId and confirmCode; show the preview to the user and call confirm_action only after they agree (tokens that require human approval cannot confirm: a person approves in /developer/mcp). Nothing done over MCP can make anything reach customers: campaigns are created paused, reply texts are created unapproved, flows are saved as drafts, and going live happens only in the SocialAuto app by a person. " +
  UNTRUSTED_NOTE;

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function clipText(text: string): string {
  return text.length > MAX_RESULT_CHARS ? `${text.slice(0, MAX_RESULT_CHARS)}\n… (javob qisqartirildi)` : text;
}

function toolResult(data: unknown, isError = false) {
  const text = typeof data === "string" ? data : JSON.stringify(data, null, 2);
  return { content: [{ type: "text", text: clipText(text ?? "") }], isError };
}

const toolError = (message: string) => toolResult(message, true);

export const READ_ONLY_TOKEN = "Bu token faqat o'qish (READ) uchun. Yozish amallari uchun /developer/mcp da WRITE token yarating.";

async function callTool(ctx: McpTokenContext, tool: McpTool, args: unknown) {
  if (tool.scope === "WRITE" && ctx.scope !== "WRITE") return toolError(READ_ONLY_TOKEN);
  const parsed = parseArguments(tool, args);
  if (!parsed.ok) return toolError(parsed.error);
  try {
    if (tool.kind === "write") {
      // Cheap checks first: a flooded token must not reach the (paid) AI Flow Builder.
      await assertCanPropose(ctx);
      if (tool.name === "create_flow_draft" && (parsed.data as { graph?: unknown }).graph === undefined) await assertFlowGenerationBudget(ctx);
      const { preview, stored } = await (tool as WriteTool).propose(ctx, parsed.data as never);
      return toolResult(await proposeAction(ctx, tool.name, stored, preview));
    }
    return toolResult(await tool.run(ctx, parsed.data as never));
  } catch (error) {
    if (!(error instanceof McpServiceError)) console.error("[MCP] tool failed:", tool.name, describeError(error));
    return toolError(safeMessage(error));
  }
}

/** Handles one parsed JSON-RPC message for an authenticated token. */
export async function handleRpc(ctx: McpTokenContext, message: unknown): Promise<RpcOutcome> {
  if (Array.isArray(message)) {
    return rpcError(null, RPC.invalidRequest, "Batch so'rovlar qo'llab-quvvatlanmaydi: har bir xabarni alohida yuboring", 400);
  }
  // A response to a request (we never send any): acknowledge with an empty 202.
  if (isRecord(message) && message.jsonrpc === "2.0" && !("method" in message) && ("result" in message || "error" in message)) {
    return { status: 202, body: null };
  }
  if (!isRecord(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string") {
    return rpcError(null, RPC.invalidRequest, "Noto'g'ri JSON-RPC so'rovi: jsonrpc '2.0' va method kerak", 400);
  }
  const hasId = "id" in message && message.id !== undefined;
  const id: Id = hasId && (typeof message.id === "string" || typeof message.id === "number") ? message.id : null;
  if (hasId && id === null) return rpcError(null, RPC.invalidRequest, "id matn yoki son bo'lishi kerak (null mumkin emas)", 400);
  const method = message.method;
  const params = message.params;

  // Notifications (no id) never get a body.
  if (!hasId) return { status: 202, body: null };

  switch (method) {
    case "initialize": {
      const requested = isRecord(params) && typeof params.protocolVersion === "string" ? params.protocolVersion : null;
      const version = requested && (SUPPORTED_PROTOCOL_VERSIONS as readonly string[]).includes(requested) ? requested : LATEST_PROTOCOL_VERSION;
      return rpcResult(id, {
        protocolVersion: version,
        capabilities: { tools: { listChanged: false } },
        serverInfo: SERVER_INFO,
        instructions: INSTRUCTIONS,
      });
    }
    case "ping":
      return rpcResult(id, {});
    case "tools/list":
      return rpcResult(id, { tools: toolsForScope(ctx.scope).map(describeTool) });
    case "tools/call": {
      if (!isRecord(params) || typeof params.name !== "string") return rpcError(id, RPC.invalidParams, "params.name (asbob nomi) kerak");
      const tool = findTool(params.name);
      if (!tool) return rpcError(id, RPC.invalidParams, `Noma'lum asbob: ${params.name.slice(0, 60)}`);
      if (params.arguments !== undefined && !isRecord(params.arguments)) return rpcError(id, RPC.invalidParams, "arguments obyekt bo'lishi kerak");
      return rpcResult(id, await callTool(ctx, tool, params.arguments));
    }
    default:
      return rpcError(id, RPC.methodNotFound, `Metod qo'llab-quvvatlanmaydi: ${method.slice(0, 60)}`);
  }
}
