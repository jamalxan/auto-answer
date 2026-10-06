/**
 * Sandbox chat: the exact same `runTurn` logic as the Instagram flow, with the
 * conversation state held by the caller (panel UI or the Telegram test mode).
 * Nothing is sent to Instagram and no lead is created.
 */

import type { Collected } from "@/lib/leads/service";
import { getLlmProvider } from "./llm/provider";
import type { ProfileSnapshot } from "./prompt";
import { runTurn, type ActiveState } from "./turn";

export interface SandboxState {
  state: ActiveState | "HANDED_OFF";
  collected: Collected & { flag?: string | null };
  botMessageCount: number;
  phoneAskCount: number;
  spamStreak: number;
  history: Array<{ role: "user" | "assistant"; content: string }>;
}

export function newSandboxState(): SandboxState {
  return {
    state: "NEW",
    collected: {},
    botMessageCount: 0,
    phoneAskCount: 0,
    spamStreak: 0,
    history: [],
  };
}

export interface SandboxOptions {
  maxBotMessages?: number;
  fallbackLeadWithoutPhone?: boolean;
  igName?: string | null;
}

export interface SandboxResult {
  reply: string | null;
  state: SandboxState;
  /** Would a lead have been created? (shown as a banner in the UI) */
  lead: null | { flag: string | null; summary: string | null };
  intent: string;
  blocked: boolean;
}

export async function sandboxTurn(
  profile: ProfileSnapshot,
  current: SandboxState,
  customerText: string,
  options: SandboxOptions = {}
): Promise<SandboxResult> {
  if (current.state === "HANDED_OFF") {
    return {
      reply: null,
      state: current,
      lead: null,
      intent: "other",
      blocked: false,
    };
  }

  const lastBot = [...current.history].reverse().find((m) => m.role === "assistant")?.content ?? null;
  const result = await runTurn({
    profile,
    state: current.state,
    collected: current.collected,
    botMessageCount: current.botMessageCount,
    phoneAskCount: current.phoneAskCount,
    spamStreak: current.spamStreak,
    maxBotMessages: options.maxBotMessages ?? 6,
    fallbackLeadWithoutPhone: options.fallbackLeadWithoutPhone ?? true,
    history: current.history,
    customerText,
    hasMedia: false,
    igName: options.igName ?? null,
    lastBotMessage: lastBot,
    templateOnly: false,
    offHours: false,
    llm: getLlmProvider(),
  });

  const history = [...current.history, { role: "user" as const, content: customerText }];
  if (result.reply) history.push({ role: "assistant", content: result.reply });

  return {
    reply: result.reply,
    state: {
      state: result.state,
      collected: result.collected,
      botMessageCount: result.botMessageCount,
      phoneAskCount: result.phoneAskCount,
      spamStreak: result.spamStreak,
      history: history.slice(-24),
    },
    lead: result.lead,
    intent: result.intent,
    blocked: result.events.some((e) => e.type === "blocked_reply"),
  };
}
