/**
 * Scenario G (e2e): AI Flow Builder end to end with a mocked LLM.
 *  - the three UI sample prompts ("Namuna 1..3", read from ai-create.tsx) and
 *    the TZ section 39 text each yield a draft that is audited;
 *  - an AI version cannot be published without a passing sandbox test AND an approval;
 *  - provider failures (400 / 502 / timeout) give a plain Uzbek message, never provider text;
 *  - 10 repeated generations through the REAL OpenAI-compatible provider with a flaky
 *    fetch (first call 400, then OK) -> 10/10 drafts.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { db, resetDb } from "./helpers/db-instance";

const mocks = vi.hoisted(() => ({ publishFlowVersion: vi.fn() }));

vi.mock("@/lib/db/client", () => ({ prisma: db.client() }));
vi.mock("@/lib/queue/client", () => ({ getRedisConnection: () => ({}) }));
vi.mock("@/lib/flows/publish", () => ({
  publishFlowVersion: mocks.publishFlowVersion,
  unpublishFlow: vi.fn(),
  archiveFlow: vi.fn(),
}));

import { LlmError, type LLMProvider, type LlmRequest, llmUserMessage, setLlmProviderForTests } from "../lib/assistant/llm/provider";
import { generateFlowFromPrompt } from "../lib/flows/ai-builder";
import { approveVersion, createFlow, publishVersion, run, testVersion } from "../lib/flows/service";
import { findStarterTemplate } from "../lib/flows/templates";

const ROOT = path.resolve(__dirname, "..");
const WS = "w1";
const RAW = 'RAW_PROVIDER_SECRET {"error":{"code":400,"message":"Invalid JSON payload received. Unknown name additionalProperties"}}';

const good = { name: "Narx so'rovi", summary: "Komment, narx, lead", graph: findStarterTemplate("comment_price_lead")!.graph };

/** The "Namuna 1..3" prompts, read straight from the UI component so they cannot drift. */
function uiSamplePrompts(): string[] {
  const source = readFileSync(path.join(ROOT, "components/developer/flows/ai-create.tsx"), "utf8");
  const block = /const EXAMPLES = \[([\s\S]*?)\];/.exec(source)?.[1] ?? "";
  return [...block.matchAll(/"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1]);
}

/** TZ section 39: the quoted natural-language input of "ETAP 7 - AI FLOW BUILDER". */
function tzSection39Input(): string {
  const tz = readFileSync(path.join(ROOT, "SocialAuto_Master_TZ_Mukammal.md"), "utf8");
  const start = tz.indexOf("# 39. ETAP 7");
  const end = tz.indexOf("# 40.", start);
  const section = tz.slice(start, end);
  const quote = /^>\s*[“"](.+)[”"]\s*$/m.exec(section);
  if (!quote) throw new Error("TZ section 39 input quote not found");
  return quote[1].trim();
}

function fakeProvider(replies: Array<unknown | Error>): LLMProvider & { calls: LlmRequest[] } {
  const calls: LlmRequest[] = [];
  const queue = [...replies];
  return {
    name: "fake",
    model: "fake-model",
    calls,
    costUsd: () => 0.01,
    async complete(request: LlmRequest) {
      calls.push(request);
      const next = queue.length > 1 ? queue.shift() : queue[0];
      if (next instanceof Error) throw next;
      return { json: next, inputTokens: 100, outputTokens: 200, model: "fake-model", latencyMs: 5 };
    },
  };
}

beforeEach(() => {
  resetDb();
  setLlmProviderForTests(undefined);
  mocks.publishFlowVersion.mockReset().mockResolvedValue({ ok: true, flow: { id: "published" } });
  db.seed("workspace", { id: WS, ownerId: "u1", name: "Mebel" });
  db.seed("instagramAccount", { id: "a1", workspaceId: WS, username: "mebel", instagramId: "ig1" });
  vi.spyOn(console, "error").mockImplementation(() => {});
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

afterEach(() => {
  setLlmProviderForTests(undefined);
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("G1: sample prompts and the TZ text yield audited drafts", () => {
  it("finds the three UI samples and the TZ section 39 input", () => {
    const samples = uiSamplePrompts();
    expect(samples).toHaveLength(3);
    for (const s of samples) expect(s.length).toBeGreaterThanOrEqual(8);
    expect(tzSection39Input()).toContain("Kommentga narx deb yozganlarga");
  });

  const cases: Array<[string, () => string]> = [
    ["Namuna 1", () => uiSamplePrompts()[0]],
    ["Namuna 2", () => uiSamplePrompts()[1]],
    ["Namuna 3", () => uiSamplePrompts()[2]],
    ["TZ section 39", () => tzSection39Input()],
  ];

  it.each(cases)("%s -> draft graph with audit + policy, nothing saved", async (_label, getText) => {
    const request = getText();
    const provider = fakeProvider([good]);
    setLlmProviderForTests(provider);
    const result = await generateFlowFromPrompt(WS, { request, accountId: "a1" });
    expect(provider.calls).toHaveLength(1);
    expect(provider.calls[0].messages[0].content).toContain(request.slice(0, 40));
    expect(result.graph.nodes.some((n) => n.type === "trigger")).toBe(true);
    expect(result.graph.nodes.length).toBeGreaterThan(3);
    expect(result.audit.errors).toEqual([]);
    expect(["PASS", "WARNING"]).toContain(result.policy.verdict);
    expect(db.rows("flow")).toHaveLength(0);

    // "Qoralama sifatida saqlash": the draft is stored as an AI-sourced version.
    const created = await createFlow(WS, { name: result.name, instagramAccountId: "a1", graph: result.graph, prompt: request, mode: "SIMPLE" }, { userId: "u1" });
    const version = db.rows("flowVersion").find((v) => v.id === created.flow.draftVersionId);
    expect(version).toMatchObject({ source: "AI", prompt: request });
    expect(version!.testedAt ?? null).toBeNull();
    expect(version!.approvedAt ?? null).toBeNull();
  });
});

describe("G2: an AI version is never published without a passing sandbox test and an approval", () => {
  it("test -> approve -> publish in that order only", async () => {
    setLlmProviderForTests(fakeProvider([good]));
    const request = tzSection39Input();
    const generated = await generateFlowFromPrompt(WS, { request, accountId: "a1" });
    const { flow } = await createFlow(WS, { name: generated.name, instagramAccountId: "a1", graph: generated.graph, prompt: request }, { userId: "u1" });
    const vid = flow.draftVersionId!;
    const ack = { acknowledgeWarnings: true };

    // nothing yet: publish refused (no test), approve refused (no test)
    await expect(publishVersion(WS, flow.id, vid, ack, "u1")).rejects.toMatchObject({ status: 422 });
    await expect(approveVersion(WS, vid, "u1")).rejects.toMatchObject({ status: 422 });
    expect(mocks.publishFlowVersion).not.toHaveBeenCalled();

    // tested but not approved: still refused, with the "no approval" explanation
    const tested = await testVersion(WS, flow.id, vid, {});
    expect(tested).toBeTruthy();
    await expect(publishVersion(WS, flow.id, vid, ack, "u1")).rejects.toMatchObject({ status: 422, message: expect.stringContaining("tasdiqsiz ishga tushmaydi") });
    expect(mocks.publishFlowVersion).not.toHaveBeenCalled();

    await approveVersion(WS, vid, "u9");
    const published = await publishVersion(WS, flow.id, vid, ack, "u9");
    expect(published.versionId).toBe(vid);
    expect(mocks.publishFlowVersion).toHaveBeenCalledTimes(1);
  });
});

describe("G3: provider failures give plain Uzbek, never raw provider text", () => {
  const kinds: Array<[string, LlmError]> = [
    ["400", new LlmError("OpenAI 400", 400, undefined, RAW)],
    ["502", new LlmError("OpenAI 502", 502, undefined, RAW)],
    ["timeout", new LlmError(`LLM request timed out after 45000ms ${RAW}`, undefined, "timeout")],
  ];

  it.each(kinds)("mocked provider throws %s -> 502 with the Uzbek message", async (_label, error) => {
    setLlmProviderForTests(fakeProvider([error]));
    const outcome = await run(() => generateFlowFromPrompt(WS, { request: tzSection39Input(), accountId: "a1" }));
    expect(outcome.ok).toBe(false);
    if (outcome.ok) return;
    expect(outcome.status).toBe(502);
    expect(outcome.error).toBe(llmUserMessage(error.kind));
    expect(outcome.error).toMatch(/^Muammo: .*Sabab: .*Yechim: /);
    expect(outcome.error).not.toMatch(/RAW_PROVIDER_SECRET|additionalProperties|Invalid JSON payload|OpenAI|timed out after/);
  });

  it("a non-LlmError crash (raw text) still becomes a plain Uzbek message", async () => {
    setLlmProviderForTests(fakeProvider([new Error("TypeError: Cannot read properties of undefined (reading 'x') RAW_PROVIDER_SECRET")]));
    const outcome = await run(() => generateFlowFromPrompt(WS, { request: tzSection39Input(), accountId: "a1" }));
    expect(outcome).toMatchObject({ ok: false, status: 502 });
    if (!outcome.ok) expect(outcome.error).not.toMatch(/RAW_PROVIDER_SECRET|TypeError/);
  });

  describe("through the real OpenAI-compatible provider with a stubbed fetch", () => {
    function useRealProvider() {
      vi.stubEnv("LLM_PROVIDER", "openai");
      vi.stubEnv("LLM_API_KEY", "test-key");
      vi.stubEnv("LLM_BASE_URL", "https://llm.invalid/v1");
      vi.stubEnv("LLM_FALLBACK_MODELS", "");
    }
    const okBody = () =>
      new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(good) } }], usage: { prompt_tokens: 50, completion_tokens: 80 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });

    it("persistent 400 (also after the degraded retry) -> Uzbek message, no provider body", async () => {
      useRealProvider();
      const fetchMock = vi.fn(async () => new Response(RAW, { status: 400 }));
      vi.stubGlobal("fetch", fetchMock);
      const outcome = await run(() => generateFlowFromPrompt(WS, { request: tzSection39Input(), accountId: "a1" }));
      expect(outcome).toMatchObject({ ok: false, status: 502 });
      if (!outcome.ok) {
        expect(outcome.error).toBe(llmUserMessage("bad_request"));
        expect(outcome.error).not.toMatch(/RAW_PROVIDER_SECRET|additionalProperties/);
      }
      expect(fetchMock).toHaveBeenCalledTimes(2); // schema mode, then one degraded json_object retry
    });

    it("persistent 502 -> Uzbek upstream message, no provider body", async () => {
      useRealProvider();
      vi.stubGlobal("fetch", vi.fn(async () => new Response(RAW, { status: 502 })));
      const outcome = await run(() => generateFlowFromPrompt(WS, { request: tzSection39Input(), accountId: "a1" }));
      expect(outcome).toMatchObject({ ok: false, status: 502 });
      if (!outcome.ok) {
        expect(outcome.error).toBe(llmUserMessage("upstream"));
        expect(outcome.error).not.toContain("RAW_PROVIDER_SECRET");
      }
    }, 20_000);

    it("fetch abort (timeout) -> Uzbek timeout message", async () => {
      useRealProvider();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          throw Object.assign(new Error("The operation was aborted RAW_PROVIDER_SECRET"), { name: "AbortError" });
        })
      );
      const outcome = await run(() => generateFlowFromPrompt(WS, { request: tzSection39Input(), accountId: "a1" }));
      expect(outcome).toMatchObject({ ok: false, status: 502 });
      if (!outcome.ok) {
        expect(outcome.error).toBe(llmUserMessage("timeout"));
        expect(outcome.error).not.toContain("RAW_PROVIDER_SECRET");
      }
    });

    it("10 repeated generations, first fetch of each 400 then OK -> 10/10 drafts (one usage row each)", async () => {
      useRealProvider();
      let n = 0;
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => (n++ % 2 === 0 ? new Response(RAW, { status: 400 }) : okBody()))
      );
      const prompts = [...uiSamplePrompts(), tzSection39Input()];
      const results = [];
      for (let i = 0; i < 10; i++) {
        results.push(await generateFlowFromPrompt(WS, { request: prompts[i % prompts.length], accountId: "a1" }));
      }
      expect(results).toHaveLength(10);
      for (const r of results) {
        expect(r.graph.nodes.length).toBeGreaterThan(3);
        expect(r.audit.errors).toEqual([]);
      }
      expect(n).toBe(20);
      expect(db.rows("llmUsage").filter((u) => u.kind === "javobai_flowbuilder" && u.ok === true)).toHaveLength(10);
    }, 30_000);
  });

  it("a user retrying by hand after each failure: failed calls also count toward the 10/hour limit", async () => {
    // 5 failures + 5 successes = 10 usage rows -> the 11th attempt is refused with 429.
    let call = 0;
    const flaky: LLMProvider = {
      name: "flaky",
      model: "fake-model",
      costUsd: () => 0,
      complete: async () => {
        if (call++ % 2 === 0) throw new LlmError("OpenAI 400", 400, undefined, RAW);
        return { json: good, inputTokens: 1, outputTokens: 1, model: "fake-model", latencyMs: 1 };
      },
    };
    setLlmProviderForTests(flaky);
    let drafts = 0;
    for (let i = 0; i < 10; i++) {
      const out = await run(() => generateFlowFromPrompt(WS, { request: tzSection39Input(), accountId: "a1" }));
      if (out.ok) drafts += 1;
    }
    expect(drafts).toBe(5);
    const eleventh = await run(() => generateFlowFromPrompt(WS, { request: tzSection39Input(), accountId: "a1" }));
    expect(eleventh).toMatchObject({ ok: false, status: 429 });
  });
});
