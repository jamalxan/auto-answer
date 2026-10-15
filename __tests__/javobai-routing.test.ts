/**
 * ETAP 4.4 — pure model routing and per-turn caps.
 */

import { afterEach, describe, expect, it } from "vitest";
import {
  DEFAULT_TURN_CAPS,
  REDUCED_TURN_CAPS,
  javobAiModelFromEnv,
  javobAiSmartModelFromEnv,
  perTurnCaps,
  pickModel,
  routingConfigFromEnv,
  type RoutingTask,
} from "@/lib/javobai/routing";

const config = { default: "gemini-3.1-flash-lite", smart: "gemini-3.1-flash" };
const TASKS: RoutingTask[] = ["reply", "summary", "stt", "vision", "retry_low_confidence"];

describe("pickModel", () => {
  it("reply / summary use the default, stt / vision / low-confidence retry use the smart model", () => {
    expect(pickModel({ task: "reply", config, budgetStatus: "ok" })).toBe("gemini-3.1-flash-lite");
    expect(pickModel({ task: "summary", config, budgetStatus: "ok" })).toBe("gemini-3.1-flash-lite");
    expect(pickModel({ task: "stt", config, budgetStatus: "ok" })).toBe("gemini-3.1-flash");
    expect(pickModel({ task: "vision", config, budgetStatus: "ok" })).toBe("gemini-3.1-flash");
    expect(pickModel({ task: "retry_low_confidence", config, budgetStatus: "ok" })).toBe("gemini-3.1-flash");
  });

  it("falls back to the default when no smart model is configured", () => {
    for (const task of TASKS) {
      expect(pickModel({ task, config: { default: "d" }, budgetStatus: "ok" })).toBe("d");
      expect(pickModel({ task, config: { default: "d", smart: null }, budgetStatus: "ok" })).toBe("d");
      expect(pickModel({ task, config: { default: "d", smart: "  " }, budgetStatus: "ok" })).toBe("d");
    }
  });

  it("soft_exceeded always routes to the default model", () => {
    for (const task of TASKS) {
      expect(pickModel({ task, config, budgetStatus: "soft_exceeded" })).toBe("gemini-3.1-flash-lite");
    }
  });

  it("hard_exceeded returns null for every task", () => {
    for (const task of TASKS) {
      expect(pickModel({ task, config, budgetStatus: "hard_exceeded" })).toBeNull();
    }
  });

  it("trims model ids", () => {
    expect(pickModel({ task: "reply", config: { default: " m1 ", smart: " m2 " }, budgetStatus: "ok" })).toBe("m1");
    expect(pickModel({ task: "vision", config: { default: " m1 ", smart: " m2 " }, budgetStatus: "ok" })).toBe("m2");
  });
});

describe("perTurnCaps", () => {
  it("full caps when ok, reduced once the soft budget is exceeded", () => {
    expect(perTurnCaps("ok")).toEqual({ maxHistory: 12, maxKbChars: 6000, maxTokens: 400 });
    expect(perTurnCaps("soft_exceeded")).toEqual({ maxHistory: 8, maxKbChars: 4000, maxTokens: 300 });
    expect(perTurnCaps("hard_exceeded")).toEqual(REDUCED_TURN_CAPS);
    expect(perTurnCaps("ok")).toEqual(DEFAULT_TURN_CAPS);
  });

  it("returns copies, not the shared constants", () => {
    const caps = perTurnCaps("ok");
    caps.maxTokens = 1;
    expect(DEFAULT_TURN_CAPS.maxTokens).toBe(400);
  });
});

describe("env readers", () => {
  const saved = { ...process.env };
  afterEach(() => {
    for (const key of ["JAVOBAI_MODEL", "JAVOBAI_MODEL_SMART", "LLM_MODEL"]) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("JAVOBAI_MODEL wins over LLM_MODEL; the smart model has no fallback", () => {
    delete process.env.JAVOBAI_MODEL;
    delete process.env.JAVOBAI_MODEL_SMART;
    delete process.env.LLM_MODEL;
    expect(javobAiModelFromEnv()).toBeUndefined();
    expect(javobAiSmartModelFromEnv()).toBeUndefined();
    expect(routingConfigFromEnv()).toBeNull();
    expect(routingConfigFromEnv("provider-default")).toEqual({ default: "provider-default", smart: null });

    process.env.LLM_MODEL = "gpt-4o-mini";
    expect(javobAiModelFromEnv()).toBe("gpt-4o-mini");

    process.env.JAVOBAI_MODEL = " gemini-3.1-flash-lite ";
    process.env.JAVOBAI_MODEL_SMART = "gemini-3.1-flash";
    expect(javobAiModelFromEnv()).toBe("gemini-3.1-flash-lite");
    expect(javobAiSmartModelFromEnv()).toBe("gemini-3.1-flash");
    expect(routingConfigFromEnv()).toEqual({ default: "gemini-3.1-flash-lite", smart: "gemini-3.1-flash" });
  });

  it("drops a smart model equal to the default", () => {
    process.env.JAVOBAI_MODEL = "same";
    process.env.JAVOBAI_MODEL_SMART = "same";
    expect(routingConfigFromEnv()).toEqual({ default: "same", smart: null });
  });
});
