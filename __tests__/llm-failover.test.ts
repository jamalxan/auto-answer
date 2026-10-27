/**
 * Audit 2026-10-26: why a call failed is stored (llm_usage.errorKind), and a
 * second vendor answers when the primary's whole chain fails.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));

import { FailoverProvider, LlmError, failureKindOf, fallbackProviderFromEnv, type LLMProvider, type LlmRequest } from "@/lib/assistant/llm/provider";

const request: LlmRequest = { system: "s", messages: [{ role: "user", content: "salom" }], schema: { type: "object" }, schemaName: "x", usage: { workspaceId: "ws", kind: "reply" } };

function fake(name: string, model: string, outcome: "ok" | LlmError | Error): LLMProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  return {
    name,
    model,
    calls,
    costUsd: (i: number, o: number) => (i + o) / 1000,
    async complete(req: LlmRequest) {
      calls.push(req);
      if (outcome !== "ok") throw outcome;
      return { json: { reply: "ok" }, inputTokens: 10, outputTokens: 5, model, latencyMs: 5 };
    },
  };
}

afterEach(() => {
  resetDb();
  vi.restoreAllMocks();
});

describe("failureKindOf", () => {
  it("keeps the typed kind of an LlmError and calls anything else internal", () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(failureKindOf(new LlmError("x", 503))).toBe("upstream");
    expect(failureKindOf(new LlmError("x", undefined, "timeout"))).toBe("timeout");
    expect(failureKindOf(new TypeError("boom"))).toBe("internal");
  });
});

describe("FailoverProvider", () => {
  it("asks the second vendor when the primary fails and records ONE ok row", async () => {
    const primary = fake("openai", "gemini-3.1-flash-lite", new LlmError("x", 503));
    const secondary = fake("anthropic", "claude-haiku-4-5", "ok");
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const response = await new FailoverProvider(primary, secondary).complete(request);
    expect(response.model).toBe("claude-haiku-4-5");
    // The inner providers never write their own usage rows.
    expect(primary.calls[0].usage).toBeUndefined();
    expect(secondary.calls[0].usage).toBeUndefined();
    const rows = db.rows("llmUsage");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ ok: true, model: "claude-haiku-4-5", errorKind: null });
  });

  it("does not call the second vendor when the primary answers", async () => {
    const primary = fake("openai", "gemini", "ok");
    const secondary = fake("anthropic", "claude", "ok");
    await new FailoverProvider(primary, secondary).complete(request);
    expect(secondary.calls).toHaveLength(0);
  });

  it("records the second vendor's error kind when both fail", async () => {
    vi.spyOn(console, "warn").mockImplementation(() => {});
    const provider = new FailoverProvider(fake("openai", "gemini", new LlmError("x", 503)), fake("anthropic", "claude", new LlmError("y", 429)));
    await expect(provider.complete(request)).rejects.toMatchObject({ kind: "rate_limit" });
    expect(db.rows("llmUsage")[0]).toMatchObject({ ok: false, errorKind: "rate_limit" });
  });

  it("a code bug is not masked by the second vendor", async () => {
    const secondary = fake("anthropic", "claude", "ok");
    vi.spyOn(console, "error").mockImplementation(() => {});
    await expect(new FailoverProvider(fake("openai", "gemini", new TypeError("bug")), secondary).complete(request)).rejects.toThrow("bug");
    expect(secondary.calls).toHaveLength(0);
    expect(db.rows("llmUsage")[0]).toMatchObject({ ok: false, errorKind: "internal" });
  });

  it("is built from LLM_FALLBACK_* only when a key is set", () => {
    expect(fallbackProviderFromEnv({ LLM_FALLBACK_PROVIDER: "anthropic" })).toBeNull();
    expect(fallbackProviderFromEnv({ LLM_FALLBACK_PROVIDER: "anthropic", LLM_FALLBACK_API_KEY: "k" })?.name).toBe("anthropic");
    expect(fallbackProviderFromEnv({ LLM_FALLBACK_PROVIDER: "openai", LLM_FALLBACK_API_KEY: "k", LLM_FALLBACK_MODEL: "gpt-5-mini" })?.model).toBe("gpt-5-mini");
  });
});
