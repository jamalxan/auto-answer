/**
 * ETAP 7 — AI Flow Builder, the model call (analysis §3.2).
 *
 *   generateFlowFromPrompt(ws, { request, accountId, triggerType? })
 *     → { graph, name, summary, warnings, audit, policy, model }
 *
 * buildFlowBuilderPrompt → provider.complete (JSON) → parseGraphFromLlm →
 * on failure ONE repair round (buildRepairPrompt) → audit + policy on the
 * result so the UI shows the verdicts before anything is saved. Nothing is
 * saved here: the caller turns the graph into a draft. Budget-gated
 * (enforceBudgetBeforeCall), rate-limited per workspace through the usage
 * rows (kind "javobai_flowbuilder", ONE row per generation), model =
 * JAVOBAI_MODEL_SMART with the usual fallbacks; a soft-exceeded budget
 * drops to the default (cheap) model.
 */

import { failureKindOf, describeLlmFailure, getLlmProviderFor, llmLongTimeoutMs, type LlmRequest, type LlmResponse } from "@/lib/assistant/llm/provider";
import { prisma } from "@/lib/db/client";
import { enforceBudgetBeforeCall } from "@/lib/javobai/budget";
import { javobAiModel, javobAiSmartModel } from "@/lib/javobai/config";
import { recordJavobAiUsage } from "@/lib/javobai/usage";
import { type AuditResult, auditGraph } from "./audit";
import { auditContextFrom, loadFlowContext } from "./context";
import { FlowServiceError, notFound } from "./errors";
import { buildFlowBuilderPrompt, buildRepairPrompt, isFlowParseFailure, parseGraphFromLlm, type ParsedFlowFromLlm } from "./ai-builder-prompt";
import { evaluatePolicy, type PolicyResult } from "./policy";
import { FLOW_TRIGGER_TYPES, type FlowGraph, type FlowTriggerType } from "./schema";

export const AI_GENERATE_PER_HOUR = 10;
export const AI_REQUEST_MIN = 8;
export const AI_REQUEST_MAX = 2000;
export const USAGE_KIND_FLOWBUILDER = "javobai_flowbuilder" as const;

export const NO_LLM_MESSAGE = "AI sozlanmagan: serverda LLM_PROVIDER / LLM_API_KEY yo'q — AI bilan yaratish hozircha ishlamaydi";
export const BUDGET_MESSAGE = "AI oylik byudjeti tugadi — AI bilan yaratish vaqtincha to'xtatilgan";
export const RATE_LIMIT_MESSAGE = `Soatiga ${AI_GENERATE_PER_HOUR} tadan ko'p AI so'rovi mumkin emas — birozdan keyin qayta urinib ko'ring`;
export const UNUSABLE_MESSAGE =
  "AI yaroqli oqim tuza olmadi (ikki urinishdan keyin ham). So'rovni aniqroq yozing: nima sodir bo'lganda (komment / xabar), qaysi kalit so'zlar, nima yuborilsin va oxirida nima bo'lsin.";

export interface GenerateFlowInput {
  request: string;
  accountId: string;
  triggerType?: FlowTriggerType;
}

export interface GeneratedFlow {
  graph: FlowGraph;
  name: string;
  summary: string | null;
  warnings: string[];
  audit: AuditResult;
  policy: PolicyResult;
  model: string;
  repaired: boolean;
}

function textOf(json: unknown): string {
  if (typeof json === "string") return json;
  try {
    return JSON.stringify(json);
  } catch {
    return "";
  }
}

/** Builder calls of this workspace in the last 60 minutes (one usage row per generation). */
export async function generationsInLastHour(workspaceId: string, now: Date = new Date()): Promise<number> {
  return prisma.llmUsage.count({
    where: { workspaceId, kind: USAGE_KIND_FLOWBUILDER, createdAt: { gte: new Date(now.getTime() - 3_600_000) } },
  });
}

export async function generateFlowFromPrompt(workspaceId: string, input: GenerateFlowInput): Promise<GeneratedFlow> {
  const request = (input.request ?? "").trim();
  if (request.length < AI_REQUEST_MIN) throw new FlowServiceError(400, "So'rov juda qisqa — oqim nima qilishini bir-ikki gapda yozing");
  if (request.length > AI_REQUEST_MAX) throw new FlowServiceError(400, `So'rov ${AI_REQUEST_MAX} belgidan oshmasin`);
  if (input.triggerType && !FLOW_TRIGGER_TYPES.includes(input.triggerType)) throw new FlowServiceError(400, "Trigger turi noto'g'ri");

  const account = await prisma.instagramAccount.findFirst({ where: { id: input.accountId, workspaceId }, select: { id: true } });
  if (!account) throw notFound("Instagram akkaunt topilmadi");

  if ((await generationsInLastHour(workspaceId)) >= AI_GENERATE_PER_HOUR) throw new FlowServiceError(429, RATE_LIMIT_MESSAGE);

  const gate = await enforceBudgetBeforeCall(workspaceId);
  if (!gate.allowed) throw new FlowServiceError(429, BUDGET_MESSAGE);

  const provider = getLlmProviderFor(gate.flagged ? javobAiModel() : javobAiSmartModel());
  if (!provider) throw new FlowServiceError(503, NO_LLM_MESSAGE);

  const ctx = await loadFlowContext(workspaceId, account.id);
  const prompt = buildFlowBuilderPrompt({
    request,
    triggerType: input.triggerType,
    brand: ctx.brand ?? undefined,
    kb: ctx.kb,
    tags: ctx.declaredTags,
    stages: ctx.stages.map((s) => ({ id: s.id, name: s.name })),
    javobAiLive: ctx.javobAiMode === "LIVE",
  });

  let inputTokens = 0;
  let outputTokens = 0;
  let costUsd = 0;
  let latencyMs = 0;
  let usedModel = provider.model;
  let ok = false;
  let errorKind: string | null = null;
  const started = Date.now();

  const call = async (userMessage: string): Promise<unknown> => {
    const req: LlmRequest = {
      system: prompt.system,
      messages: [{ role: "user", content: userMessage }],
      schema: prompt.jsonSchema,
      schemaName: prompt.schemaName,
      temperature: 0.2,
      maxTokens: 4000,
      timeoutMs: llmLongTimeoutMs(45_000),
    };
    const response: LlmResponse = await provider.complete(req);
    inputTokens += response.inputTokens;
    outputTokens += response.outputTokens;
    latencyMs += response.latencyMs;
    usedModel = response.model || usedModel;
    costUsd += provider.costUsd(response.inputTokens, response.outputTokens, response.model);
    return response.json;
  };

  let parsed: ParsedFlowFromLlm;
  let repaired = false;
  try {
    const first = await call(prompt.user);
    const firstResult = parseGraphFromLlm(first);
    if (!isFlowParseFailure(firstResult)) {
      parsed = firstResult;
    } else {
      repaired = true;
      const second = await call(`${prompt.user}\n\n${buildRepairPrompt(textOf(first), firstResult.hints)}`);
      const secondResult = parseGraphFromLlm(second);
      if (isFlowParseFailure(secondResult)) {
        ok = true; // the model answered; the answer was unusable
        throw new FlowServiceError(422, `${UNUSABLE_MESSAGE} Oxirgi xatolar: ${secondResult.hints.slice(0, 3).join("; ")}`);
      }
      parsed = secondResult;
    }
    ok = true;
  } catch (error) {
    if (!ok) errorKind = failureKindOf(error, "flow_builder");
    if (error instanceof FlowServiceError) throw error;
    console.warn("[flow-builder] LLM call failed:", error instanceof Error ? error.message.slice(0, 200) : "unknown");
    throw new FlowServiceError(502, describeLlmFailure(error));
  } finally {
    // A failed call has no response latency: record the wall time spent (a timeout is 45 s, not 0).
    await recordJavobAiUsage({ workspaceId, kind: USAGE_KIND_FLOWBUILDER, model: usedModel, inputTokens, outputTokens, costUsd, latencyMs: latencyMs || Date.now() - started, ok, errorKind });
  }

  const trigger = parsed.graph.nodes.find((n) => n.type === "trigger");
  const triggerType = trigger && trigger.type === "trigger" ? trigger.triggerType : input.triggerType;
  const auditCtx = auditContextFrom(ctx, triggerType);
  return {
    graph: parsed.graph,
    name: parsed.name ?? "AI oqim",
    summary: parsed.summary,
    warnings: parsed.warnings,
    audit: auditGraph(parsed.graph, auditCtx),
    policy: evaluatePolicy(parsed.graph, auditCtx),
    model: usedModel,
    repaired,
  };
}
