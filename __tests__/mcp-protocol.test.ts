/**
 * ETAP 12 — the MCP JSON-RPC surface: initialize / version negotiation,
 * notifications, ping, tools/list (JSON Schema, scope filtering), tools/call
 * errors, batch rejection, the HTTP edge (GET 405, 413 with a spoofed
 * Content-Length, malformed JSON, kill switch) and the route file itself.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("@/lib/triggers/ingest", () => ({ forgetAccountGate: vi.fn() }));

import { GET as routeGet, POST as routePost, DELETE as routeDelete } from "../app/api/mcp/route";
import { resetMcpRateLimitsForTests } from "../lib/mcp/auth";
import { MAX_BODY_BYTES } from "../lib/mcp/config";
import { ALL_TOOLS } from "../lib/mcp/tools";
import { callTool, makeToken, mcpRequest, rpc, seedWorld, WS_A } from "./helpers/mcp-world";

let read: string;
let write: string;

beforeEach(async () => {
  resetDb();
  resetMcpRateLimitsForTests();
  vi.unstubAllEnvs();
  seedWorld();
  read = (await makeToken(WS_A, "READ")).raw;
  write = (await makeToken(WS_A, "WRITE")).raw;
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("initialize", () => {
  it("echoes a supported protocol version and advertises tools", async () => {
    const { status, json } = await rpc(read, "initialize", { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "t", version: "1" } });
    expect(status).toBe(200);
    expect(json.jsonrpc).toBe("2.0");
    expect(json.id).toBe(1);
    expect(json.result.protocolVersion).toBe("2024-11-05");
    expect(json.result.capabilities.tools).toBeDefined();
    expect(json.result.serverInfo.name).toBe("socialauto");
  });

  it("echoes a supported version and answers the latest (2025-06-18) for an unknown or missing one", async () => {
    expect((await rpc(read, "initialize", { protocolVersion: "2025-06-18" })).json.result.protocolVersion).toBe("2025-06-18");
    expect((await rpc(read, "initialize", { protocolVersion: "2025-03-26" })).json.result.protocolVersion).toBe("2025-03-26");
    expect((await rpc(read, "initialize", { protocolVersion: "1999-01-01" })).json.result.protocolVersion).toBe("2025-06-18");
    expect((await rpc(read, "initialize")).json.result.protocolVersion).toBe("2025-06-18");
  });

  it("keeps the request id (string and number)", async () => {
    expect((await rpc(read, "ping", undefined, "abc")).json).toEqual({ jsonrpc: "2.0", id: "abc", result: {} });
    expect((await rpc(read, "ping", undefined, 7)).json.id).toBe(7);
  });
});

describe("notifications", () => {
  it("notifications/initialized is an empty 202", async () => {
    const res = await (await import("../lib/mcp/http")).handleMcpPost(mcpRequest(read, { jsonrpc: "2.0", method: "notifications/initialized" }));
    expect(res.status).toBe(202);
    expect(await res.text()).toBe("");
  });
});

describe("tools/list", () => {
  it("lists READ tools for a READ token, with JSON Schema and English descriptions", async () => {
    const { json } = await rpc(read, "tools/list");
    const names: string[] = json.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["list_campaigns", "get_campaign", "list_flows", "get_flow", "list_leads", "get_analytics_summary", "get_kpi", "list_instagram_accounts", "run_diagnostics", "generate_report", "search_knowledge_base"]));
    expect(names).not.toContain("create_keyword_campaign");
    expect(names).not.toContain("confirm_action");
    const leads = json.result.tools.find((t: { name: string }) => t.name === "list_leads");
    expect(leads.inputSchema.type).toBe("object");
    expect(leads.inputSchema.properties.limit.maximum).toBe(50);
    expect(leads.inputSchema.$schema).toBeUndefined();
    expect(leads.annotations.readOnlyHint).toBe(true);
  });

  it("lists the write tools and confirm / reject for a WRITE token", async () => {
    const { json } = await rpc(write, "tools/list");
    const names: string[] = json.result.tools.map((t: { name: string }) => t.name);
    expect(names).toEqual(expect.arrayContaining(["create_keyword_campaign", "update_campaign", "pause_campaign", "create_flow_draft", "add_lead_tag", "set_lead_stage", "confirm_action", "reject_action"]));
    // Publishing a flow is deliberately not a tool.
    expect(names.some((n) => /publish/i.test(n))).toBe(false);
    expect(ALL_TOOLS.every((t) => t.description.length > 20)).toBe(true);
  });
});

describe("tools/call errors", () => {
  it("unknown tool is -32602, bad params -32602, unknown method -32601", async () => {
    expect((await rpc(read, "tools/call", { name: "nope" })).json.error.code).toBe(-32602);
    expect((await rpc(read, "tools/call", {})).json.error.code).toBe(-32602);
    expect((await rpc(read, "tools/call", { name: "get_kpi", arguments: [] })).json.error.code).toBe(-32602);
    expect((await rpc(read, "resources/list")).json.error.code).toBe(-32601);
  });

  it("invalid arguments are a tool error in Uzbek-readable form, not an HTTP failure", async () => {
    const result = await callTool(read, "list_leads", { limit: 500 });
    expect(result.status).toBe(200);
    expect(result.isError).toBe(true);
    expect(result.text).toMatch(/Noto'g'ri argument/);
  });

  it("rejects a JSON-RPC batch", async () => {
    const res = await (await import("../lib/mcp/http")).handleMcpPost(mcpRequest(read, [{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "ping" }]));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe(-32600);
    expect(body.error.message).toMatch(/Batch/);
  });

  it("rejects a message that is not JSON-RPC 2.0", async () => {
    const res = await (await import("../lib/mcp/http")).handleMcpPost(mcpRequest(read, { id: 1, method: "ping" }));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32600);
  });
});

describe("HTTP edge", () => {
  it("GET and DELETE answer 405 JSON with Allow: POST (no server-initiated stream)", async () => {
    for (const handler of [routeGet, routeDelete]) {
      const res = await handler();
      expect(res.status).toBe(405);
      expect(res.headers.get("allow")).toMatch(/^POST/);
      expect((await res.json()).success).toBe(false);
    }
  });

  it("malformed JSON is -32700 with 400", async () => {
    const res = await routePost(mcpRequest(read, "{not json"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe(-32700);
  });

  it("an empty body is -32700 too", async () => {
    const res = await routePost(mcpRequest(read, ""));
    expect(res.status).toBe(400);
  });

  it("413 when Content-Length says too big", async () => {
    const res = await routePost(mcpRequest(read, { jsonrpc: "2.0", id: 1, method: "ping" }, { "content-length": String(MAX_BODY_BYTES + 1) }));
    expect(res.status).toBe(413);
  });

  it("413 for a real oversized body even when Content-Length is spoofed small", async () => {
    const big = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "ping", params: { pad: "x".repeat(MAX_BODY_BYTES + 10) } });
    const res = await routePost(mcpRequest(read, big, { "content-length": "10" }));
    expect(res.status).toBe(413);
  });

  it("413 for a chunked stream with no Content-Length", async () => {
    const chunk = new TextEncoder().encode("x".repeat(64 * 1024));
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (sent > MAX_BODY_BYTES) return controller.close();
        sent += chunk.byteLength;
        controller.enqueue(chunk);
      },
    });
    const request = new Request("http://localhost/api/mcp", {
      method: "POST",
      headers: { authorization: `Bearer ${read}`, "content-type": "application/json" },
      body: stream,
      duplex: "half",
    } as RequestInit);
    expect((await routePost(request)).status).toBe(413);
  });

  it("MCP_DISABLED answers 503 (before auth) and tools stop", async () => {
    vi.stubEnv("MCP_DISABLED", "1");
    const res = await routePost(mcpRequest(read, { jsonrpc: "2.0", id: 1, method: "tools/list" }));
    expect(res.status).toBe(503);
    expect((await res.json()).error).toMatch(/MCP_DISABLED/);
    expect((await routePost(mcpRequest(null, { jsonrpc: "2.0", id: 1, method: "ping" }))).status).toBe(503);
    vi.stubEnv("MCP_DISABLED", "");
    expect((await routePost(mcpRequest(read, { jsonrpc: "2.0", id: 1, method: "ping" }))).status).toBe(200);
  });

  it("responses are never cached", async () => {
    const res = await routePost(mcpRequest(read, { jsonrpc: "2.0", id: 1, method: "ping" }));
    expect(res.headers.get("cache-control")).toBe("no-store");
  });
});
