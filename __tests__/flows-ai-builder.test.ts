/**
 * ETAP 7 — AI builder model call: valid / fenced JSON, the one repair round,
 * budget gate, rate limit, no LLM, usage row, nothing saved.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));

import { LlmError, type LLMProvider, type LlmRequest, setLlmProviderForTests } from "../lib/assistant/llm/provider";
import { AI_GENERATE_PER_HOUR, generateFlowFromPrompt } from "../lib/flows/ai-builder";
import { findStarterTemplate } from "../lib/flows/templates";

const WS = "w1";
const REQUEST = "Komment narx desa narx va telefon so'ra";
const good = { name: "Narx so'rovi", summary: "Komment, narx, lead", graph: findStarterTemplate("comment_price_lead")!.graph };

function provider(replies: Array<unknown | Error>): LLMProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const queue = [...replies];
  return {
    name: "fake",
    model: "fake-model",
    calls,
    costUsd: () => 0.01,
    async complete(request: LlmRequest) {
      calls.push(request);
      const next = queue.shift();
      if (next instanceof Error) throw next;
      return { json: next, inputTokens: 100, outputTokens: 200, model: "fake-model", latencyMs: 5 };
    },
  };
}

beforeEach(() => {
  resetDb();
  setLlmProviderForTests(undefined);
  db.seed("workspace", { id: WS, ownerId: "u1", name: "Mebel" });
  db.seed("workspace", { id: "w2", ownerId: "u2", name: "Boshqa" });
  db.seed("instagramAccount", { id: "a1", workspaceId: WS, username: "mebel", instagramId: "ig1" });
  db.seed("instagramAccount", { id: "a2", workspaceId: "w2", username: "x", instagramId: "ig2" });
  vi.spyOn(console, "error").mockImplementation(() => {});
});

const usageRows = () => db.rows("llmUsage").filter((r) => r.kind === "javobai_flowbuilder");
const seedUsage = (createdAt: Date) =>
  db.seed("llmUsage", { workspaceId: WS, kind: "javobai_flowbuilder", model: "m", inputTokens: 1, outputTokens: 1, costUsd: 0, latencyMs: 1, ok: true, createdAt });

describe("generateFlowFromPrompt", () => {
  it("returns graph + name + audit + policy from valid JSON, records one usage row, saves nothing", async () => {
    const p = provider([good]);
    setLlmProviderForTests(p);
    const result = await generateFlowFromPrompt(WS, { request: REQUEST, accountId: "a1" });
    expect(result.name).toBe("Narx so'rovi");
    expect(result.graph.nodes.length).toBeGreaterThan(3);
    expect(result.audit.errors).toEqual([]);
    expect(["PASS", "WARNING"]).toContain(result.policy.verdict);
    expect(result.repaired).toBe(false);
    expect(p.calls).toHaveLength(1);
    expect(p.calls[0].schemaName).toBe("flow_graph");
    expect(usageRows()).toHaveLength(1);
    expect(usageRows()[0]).toMatchObject({ workspaceId: WS, ok: true, inputTokens: 100, outputTokens: 200 });
    expect(db.rows("flow")).toHaveLength(0);
    expect(db.rows("flowVersion")).toHaveLength(0);
  });

  it("accepts fenced JSON text", async () => {
    setLlmProviderForTests(provider(["```json\n" + JSON.stringify(good) + "\n```"]));
    const result = await generateFlowFromPrompt(WS, { request: REQUEST, accountId: "a1" });
    expect(result.graph.nodes.some((n) => n.type === "lead")).toBe(true);
  });

  it("repairs once: bad first answer, good second (hints go into the second prompt)", async () => {
    const p = provider(["bu JSON emas", good]);
    setLlmProviderForTests(p);
    const result = await generateFlowFromPrompt(WS, { request: REQUEST, accountId: "a1" });
    expect(result.repaired).toBe(true);
    expect(p.calls).toHaveLength(2);
    expect(p.calls[1].messages[0].content).toContain("tekshiruvdan o'tmadi");
    expect(usageRows()).toHaveLength(1);
    expect(usageRows()[0].inputTokens).toBe(200);
  });

  it("fails with 422 and a clear Uzbek message after a failed repair", async () => {
    setLlmProviderForTests(provider(["bu JSON emas", { graph: { nodes: [] } }]));
    await expect(generateFlowFromPrompt(WS, { request: REQUEST, accountId: "a1" })).rejects.toMatchObject({
      status: 422,
      message: expect.stringContaining("yaroqli oqim tuza olmadi"),
    });
    expect(usageRows()).toHaveLength(1);
    expect(usageRows()[0].ok).toBe(true);
  });

  it("maps a provider error to 502 and records a failed usage row", async () => {
    setLlmProviderForTests(provider([new LlmError("timeout")]));
    await expect(generateFlowFromPrompt(WS, { request: REQUEST, accountId: "a1" })).rejects.toMatchObject({ status: 502 });
    expect(usageRows()[0]).toMatchObject({ ok: false });
  });

  it("503 when no LLM is configured", async () => {
    setLlmProviderForTests(null);
    await expect(generateFlowFromPrompt(WS, { request: REQUEST, accountId: "a1" })).rejects.toMatchObject({ status: 503 });
    expect(usageRows()).toHaveLength(0);
  });

  it("refuses when the hard budget is exceeded, without calling the model", async () => {
    const p = provider([good]);
    setLlmProviderForTests(p);
    db.seed("aiBudget", { workspaceId: WS, monthlyUsdSoft: 1, monthlyUsdHard: 2, periodStart: new Date(), alerted50At: null, alerted80At: null, alerted100At: null });
    db.seed("llmUsage", { workspaceId: WS, kind: "javobai_reply", model: "m", inputTokens: 1, outputTokens: 1, costUsd: 5, latencyMs: 1, ok: true, createdAt: new Date() });
    await expect(generateFlowFromPrompt(WS, { request: REQUEST, accountId: "a1" })).rejects.toMatchObject({ status: 429 });
    expect(p.calls).toHaveLength(0);
  });

  it("rate limits to 10 generations per hour per workspace; older rows do not count", async () => {
    setLlmProviderForTests(provider([good]));
    for (let i = 0; i < AI_GENERATE_PER_HOUR; i++) seedUsage(new Date());
    await expect(generateFlowFromPrompt(WS, { request: REQUEST, accountId: "a1" })).rejects.toMatchObject({ status: 429 });

    resetDb();
    db.seed("instagramAccount", { id: "a1", workspaceId: WS, username: "mebel", instagramId: "ig1" });
    for (let i = 0; i < AI_GENERATE_PER_HOUR; i++) seedUsage(new Date(Date.now() - 2 * 3_600_000));
    setLlmProviderForTests(provider([good]));
    await expect(generateFlowFromPrompt(WS, { request: REQUEST, accountId: "a1" })).resolves.toBeTruthy();
  });

  it("validates the request and the account (foreign account is 404)", async () => {
    setLlmProviderForTests(provider([good]));
    await expect(generateFlowFromPrompt(WS, { request: "qisqa", accountId: "a1" })).rejects.toMatchObject({ status: 400 });
    await expect(generateFlowFromPrompt(WS, { request: REQUEST, accountId: "a2" })).rejects.toMatchObject({ status: 404 });
  });
});
