import { afterEach, describe, expect, it, vi } from "vitest";
import { LlmError, OpenAICompatibleProvider, fallbackModelsFromEnv } from "../lib/assistant/llm/provider";

const ok = {
  choices: [{ message: { content: '{"reply":"Salom"}' } }],
  usage: { prompt_tokens: 10, completion_tokens: 5 },
};

function mockStatuses(statuses: number[]) {
  const fetchMock = vi.fn(async () => {
    const status = statuses.shift() ?? 200;
    return new Response(status === 200 ? JSON.stringify(ok) : '[{"error":{"code":503,"status":"UNAVAILABLE"}}]', {
      status,
    });
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const provider = () =>
  new OpenAICompatibleProvider("key", "gemini-flash", "https://generativelanguage.googleapis.com/v1beta/openai");

const request = { system: "s", messages: [{ role: "user" as const, content: "narxi?" }], schema: {}, schemaName: "x" };

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("LLM transient-error retries", () => {
  it("retries a 503 (model overloaded) and returns the answer", async () => {
    vi.useFakeTimers();
    const fetchMock = mockStatuses([503, 200]);
    const pending = provider().complete(request);
    await vi.advanceTimersByTimeAsync(500);
    const result = await pending;

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.json).toBe('{"reply":"Salom"}');
  });

  it("gives up after two retries and reports the status", async () => {
    vi.useFakeTimers();
    const fetchMock = mockStatuses([503, 503, 503]);
    const pending = provider().complete(request);
    const assertion = expect(pending).rejects.toMatchObject({ name: "LlmError", status: 503 });
    await vi.advanceTimersByTimeAsync(2000);
    await assertion;
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not retry a client error such as a bad key", async () => {
    const fetchMock = mockStatuses([401]);
    await expect(provider().complete(request)).rejects.toBeInstanceOf(LlmError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe("LLM fallback models", () => {
  it("moves to the next model when the main one stays overloaded", async () => {
    vi.useFakeTimers();
    const fetchMock = mockStatuses([503, 503, 503, 200]);
    const withFallback = new OpenAICompatibleProvider("key", "main-model", "https://x/v1", ["backup-model"]);
    const pending = withFallback.complete(request);
    await vi.advanceTimersByTimeAsync(2000);
    const result = await pending;

    expect(result.model).toBe("backup-model");
    const models = fetchMock.mock.calls.map((c) => JSON.parse((c as unknown as [string, RequestInit])[1].body as string).model);
    expect(models).toEqual(["main-model", "main-model", "main-model", "backup-model"]);
  });

  it("does not switch models for a non-transient error", async () => {
    const fetchMock = mockStatuses([400]);
    const withFallback = new OpenAICompatibleProvider("key", "main-model", "https://x/v1", ["backup-model"]);
    await expect(withFallback.complete(request)).rejects.toMatchObject({ status: 400 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("reads the comma list from the environment", () => {
    expect(fallbackModelsFromEnv(" a , b,,")).toEqual(["a", "b"]);
    expect(fallbackModelsFromEnv(undefined)).toEqual([]);
  });
});
