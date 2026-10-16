/**
 * Review fix M4: LLM total latency budget, no retry of a timeout on the same
 * model, and no provider body in LlmError.message / persisted llm_error events.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  LLM_ERROR_MESSAGE_MAX,
  LlmError,
  OpenAICompatibleProvider,
  llmTotalBudgetMs,
  type LLMProvider,
} from "../lib/assistant/llm/provider";
import { runTurn, type TurnContext } from "../lib/assistant/turn";

const request = { system: "s", messages: [{ role: "user" as const, content: "narxi?" }], schema: {}, schemaName: "x" };
const ok = { choices: [{ message: { content: "{}" } }], usage: { prompt_tokens: 1, completion_tokens: 1 } };

/** A fetch that never answers; it rejects with AbortError when its signal fires. */
function hangingFetch() {
  return vi.fn((_url: string, init: RequestInit) =>
    new Promise<Response>((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
    })
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

describe("total budget", () => {
  it("defaults to 25s, never below the request timeout, env wins", () => {
    expect(llmTotalBudgetMs(12_000)).toBe(25_000);
    expect(llmTotalBudgetMs(40_000)).toBe(40_000);
    vi.stubEnv("LLM_TOTAL_BUDGET_MS", "9000");
    expect(llmTotalBudgetMs(12_000)).toBe(9_000);
  });

  it("a timeout is not retried on the same model: the next model is tried", async () => {
    vi.useFakeTimers();
    const calls: string[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn((_url: string, init: RequestInit) => {
        const model = JSON.parse(init.body as string).model as string;
        calls.push(model);
        if (model === "main") {
          return new Promise<Response>((_res, reject) =>
            init.signal?.addEventListener("abort", () => reject(Object.assign(new Error("a"), { name: "AbortError" })))
          );
        }
        return Promise.resolve(new Response(JSON.stringify(ok), { status: 200 }));
      })
    );
    const p = new OpenAICompatibleProvider("k", "main", "https://x/v1", ["backup"]);
    const pending = p.complete({ ...request, timeoutMs: 5000 });
    await vi.advanceTimersByTimeAsync(5000);
    const result = await pending;
    expect(result.model).toBe("backup");
    expect(calls).toEqual(["main", "backup"]);
  });

  it("stops at the overall deadline with a typed timeout error", async () => {
    vi.useFakeTimers();
    vi.stubEnv("LLM_TOTAL_BUDGET_MS", "3000");
    const fetchMock = hangingFetch();
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAICompatibleProvider("k", "m1", "https://x/v1", ["m2", "m3", "m4"]);
    const assertion = expect(p.complete({ ...request, timeoutMs: 2000 })).rejects.toMatchObject({ name: "LlmError", kind: "timeout" });
    await vi.advanceTimersByTimeAsync(10_000);
    await assertion;
    // m1 uses 2000ms, m2 the remaining 1000ms, nothing is left for m3.
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not sleep into a retry the budget cannot afford", async () => {
    vi.useFakeTimers();
    vi.stubEnv("LLM_TOTAL_BUDGET_MS", "800");
    const fetchMock = vi.fn(async () => new Response("overloaded", { status: 503 }));
    vi.stubGlobal("fetch", fetchMock);
    const p = new OpenAICompatibleProvider("k", "m1", "https://x/v1");
    const assertion = expect(p.complete(request)).rejects.toMatchObject({ status: 503 });
    await vi.advanceTimersByTimeAsync(5000);
    await assertion;
    // 400ms wait + 500ms minimum attempt does not fit in 800ms.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("provider body never reaches the message", () => {
  it("LlmError.message carries kind/status only; the body sits in debugBody", async () => {
    const body = "SECRET-PROMPT-ECHO " + "x".repeat(400);
    vi.stubGlobal("fetch", vi.fn(async () => new Response(body, { status: 400 })));
    const p = new OpenAICompatibleProvider("k", "m1", "https://x/v1");
    const error = (await p.complete(request).catch((e) => e)) as LlmError;
    expect(error).toBeInstanceOf(LlmError);
    expect(error.message).toBe("OpenAI 400");
    expect(error.message.length).toBeLessThanOrEqual(LLM_ERROR_MESSAGE_MAX);
    expect(error.debugBody).toContain("SECRET-PROMPT-ECHO");
    expect(JSON.stringify({ message: error.message })).not.toContain("SECRET");
  });

  it("the message is capped at 120 chars whatever the constructor gets", () => {
    expect(new LlmError("y".repeat(500)).message).toHaveLength(LLM_ERROR_MESSAGE_MAX);
  });

  it("turn.ts records the llm_error event without the provider body (nor foreign error text)", async () => {
    const withBody = new LlmError("OpenAI 503", 503, undefined, "SECRET-BODY");
    const mk = (err: unknown): LLMProvider => ({
      name: "t",
      model: "t",
      costUsd: () => 0,
      complete: async () => {
        throw err;
      },
    });
    const base = {
      profile: { companyName: "X", description: "d", pricePolicy: "NEVER", tone: "FRIENDLY", personaName: null, extraFieldLabel: null, address: null, delivery: null, workingHours: null, paymentMethods: [], categories: [], faqs: [], products: [], finalMessageTemplate: null },
      state: "NEW", collected: {}, botMessageCount: 0, phoneAskCount: 0, spamStreak: 0, maxBotMessages: 6,
      fallbackLeadWithoutPhone: true, history: [], customerText: "Salom, divan bormi?", hasMedia: false,
      igName: "Aziz", lastBotMessage: null, templateOnly: false, offHours: false,
    };
    for (const err of [withBody, new Error("db password=hunter2")]) {
      const r = await runTurn({ ...base, llm: mk(err) } as unknown as TurnContext);
      const event = (r as unknown as { events: Array<{ type: string; payload: { message: string } }> }).events.find((e) => e.type === "llm_error")!;
      expect(event).toBeTruthy();
      expect(JSON.stringify(event)).not.toMatch(/SECRET|hunter2/);
      expect(event.payload.message.length).toBeLessThanOrEqual(LLM_ERROR_MESSAGE_MAX);
    }
  });
});
