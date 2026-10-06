import { NextRequest } from "next/server";
import { z } from "zod";
import { jsonError, jsonOk, requireWorkspace } from "@/lib/api-auth";
import { findProfile, toSnapshot } from "@/lib/assistant/profile";
import { newSandboxState, sandboxTurn, type SandboxState } from "@/lib/assistant/sandbox";
import { getLlmProvider } from "@/lib/assistant/llm/provider";

export const dynamic = "force-dynamic";
export const maxDuration = 30;

const stateSchema = z.object({
  state: z.enum(["NEW", "NEED", "CONTACT", "HANDED_OFF"]),
  collected: z.record(z.string(), z.unknown()),
  botMessageCount: z.number().int().min(0).max(50),
  phoneAskCount: z.number().int().min(0).max(10),
  spamStreak: z.number().int().min(0).max(10),
  history: z
    .array(z.object({ role: z.enum(["user", "assistant"]), content: z.string().max(2000) }))
    .max(40),
});

const bodySchema = z.object({
  instagramAccountId: z.string().nullable().optional(),
  message: z.string().min(1).max(1000),
  state: stateSchema.optional(),
});

/**
 * Test chat: runs the same turn logic as the Instagram flow against the saved
 * profile. Nothing is sent to Instagram and no lead is created. The
 * conversation state lives in the browser and is passed back each turn.
 */
export async function POST(request: NextRequest) {
  const auth = await requireWorkspace();
  if (!auth.ok) return auth.response;
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) return jsonError("Invalid request", 400);

  const profile = await findProfile(auth.ctx.workspaceId, parsed.data.instagramAccountId ?? null);
  if (!profile || !profile.companyName.trim()) {
    return jsonError("Profile not set up yet", 422, { code: "no_profile" });
  }
  if (!getLlmProvider()) {
    return jsonError("LLM provider is not configured", 503, { code: "no_llm" });
  }

  const state = (parsed.data.state as SandboxState | undefined) ?? newSandboxState();
  const result = await sandboxTurn(toSnapshot(profile), state, parsed.data.message, {
    maxBotMessages: profile.maxBotMessages,
    fallbackLeadWithoutPhone: profile.fallbackLeadWithoutPhone,
  });
  return jsonOk({
    reply: result.reply,
    state: result.state,
    lead: result.lead,
    intent: result.intent,
    blocked: result.blocked,
  });
}
