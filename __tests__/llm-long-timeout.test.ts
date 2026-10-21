/** LLM_TIMEOUT_MS is a chat-turn setting; long generations must never be capped below their own minimum. */
import { afterEach, describe, expect, it, vi } from "vitest";
import { llmLongTimeoutMs, llmTimeoutMs } from "../lib/assistant/llm/provider";

afterEach(() => vi.unstubAllEnvs());

describe("llmLongTimeoutMs", () => {
  it("uses the minimum when the env is unset or smaller", () => {
    vi.stubEnv("LLM_TIMEOUT_MS", "");
    expect(llmLongTimeoutMs(45_000)).toBe(45_000);
    vi.stubEnv("LLM_TIMEOUT_MS", "12000");
    expect(llmTimeoutMs()).toBe(12_000);
    expect(llmLongTimeoutMs(45_000)).toBe(45_000);
  });

  it("honours a larger configured value (local models)", () => {
    vi.stubEnv("LLM_TIMEOUT_MS", "120000");
    expect(llmLongTimeoutMs(45_000)).toBe(120_000);
  });
});
