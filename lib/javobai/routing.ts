/**
 * Model routing and per-turn caps (ETAP 4.4, TZ §66 "model routing", "token
 * limits", "max context"). Pure: the engine passes the budget status it got
 * from `enforceBudgetBeforeCall` and the models it read from the environment.
 *
 *   reply / summary          → default model
 *   stt / vision / retry_low_confidence → smart model when configured, else default
 *   soft_exceeded            → always the default model (cheap path), smaller caps
 *   hard_exceeded            → null: the caller must not make the call
 *
 * The env readers here only read process.env (JAVOBAI_MODEL, JAVOBAI_MODEL_SMART,
 * LLM_MODEL); the provider for a model id comes from
 * `getLlmProviderFor(model)` in lib/assistant/llm/provider.ts.
 */

import type { BudgetStatus } from "./budget";

export type RoutingTask = "reply" | "summary" | "stt" | "vision" | "retry_low_confidence";

export const SMART_TASKS: readonly RoutingTask[] = ["stt", "vision", "retry_low_confidence"];

export interface RoutingConfig {
  /** Model for ordinary turns (JAVOBAI_MODEL). */
  default: string;
  /** Optional stronger model for voice / image / low-confidence retries (JAVOBAI_MODEL_SMART). */
  smart?: string | null;
}

export interface PickModelInput {
  task: RoutingTask;
  config: RoutingConfig;
  budgetStatus: BudgetStatus;
}

/** The model id for this call, or null when the budget forbids any call. */
export function pickModel({ task, config, budgetStatus }: PickModelInput): string | null {
  if (budgetStatus === "hard_exceeded") return null;
  const fallback = config.default.trim();
  if (budgetStatus === "soft_exceeded") return fallback;
  const smart = config.smart?.trim();
  if (SMART_TASKS.includes(task) && smart) return smart;
  return fallback;
}

export interface TurnCaps {
  /** Conversation messages sent to the model (newest first when trimming). */
  maxHistory: number;
  /** Knowledge-base characters in the prompt. */
  maxKbChars: number;
  /** Output tokens of the reply. */
  maxTokens: number;
}

export const DEFAULT_TURN_CAPS: TurnCaps = { maxHistory: 12, maxKbChars: 6000, maxTokens: 400 };
export const REDUCED_TURN_CAPS: TurnCaps = { maxHistory: 8, maxKbChars: 4000, maxTokens: 300 };

/** Per-turn caps; reduced once the soft budget is exceeded (hard_exceeded never reaches a call, but gets the reduced caps too). */
export function perTurnCaps(budgetStatus: BudgetStatus): TurnCaps {
  return budgetStatus === "ok" ? { ...DEFAULT_TURN_CAPS } : { ...REDUCED_TURN_CAPS };
}

// ─── Environment ──────────────────────────────────────────────────────────────

function envModel(name: string): string | undefined {
  const value = process.env[name]?.trim();
  return value ? value : undefined;
}

/** JAVOBAI_MODEL, else production's LLM_MODEL. Undefined when neither is set (provider default applies). */
export function javobAiModelFromEnv(): string | undefined {
  return envModel("JAVOBAI_MODEL") ?? envModel("LLM_MODEL");
}

/** JAVOBAI_MODEL_SMART only — no fallback, so `pickModel` can tell "not configured" apart. */
export function javobAiSmartModelFromEnv(): string | undefined {
  return envModel("JAVOBAI_MODEL_SMART");
}

/**
 * Routing config from the environment. `fallbackDefault` is what to use when
 * neither JAVOBAI_MODEL nor LLM_MODEL is set (the provider's own default id);
 * without it the result is null and the caller should treat JavobAI as not
 * configured.
 */
export function routingConfigFromEnv(fallbackDefault?: string): RoutingConfig | null {
  const def = javobAiModelFromEnv() ?? fallbackDefault?.trim();
  if (!def) return null;
  const smart = javobAiSmartModelFromEnv();
  return { default: def, smart: smart && smart !== def ? smart : null };
}

/**
 * The model id the engine hands to `getLlmProviderFor` for one task under the
 * current budget status: `null` = hard limit, do not call; `undefined` = no
 * JAVOBAI_MODEL / LLM_MODEL configured, the provider's own default applies.
 */
export function modelForTask(task: RoutingTask, budgetStatus: BudgetStatus): string | null | undefined {
  if (budgetStatus === "hard_exceeded") return null;
  const config = routingConfigFromEnv();
  return config ? pickModel({ task, config, budgetStatus }) : undefined;
}
