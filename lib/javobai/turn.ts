/**
 * One JavobAI turn (design "Turn (v2)"): given the knowledge base, the
 * conversation's v2 state and the customer's newest message(s), decide the
 * reply, the new score, the extracted fields, whether a lead is captured and
 * whether the thread goes to a manager.
 *
 * Same principle as production's turn.ts: the model writes the reply and
 * extracts fields; CODE owns the state machine, the scoring, the lead and the
 * handoff. Phone numbers come from `extractPhone` only, email from a regex.
 * The grounding rule turns an uncited or low-confidence factual answer into
 * "I don't have that" (and a knowledge gap for the owner); `filterReply`
 * (production's post-filter) runs last on every model-written reply.
 *
 * Pure apart from the LLM call: no database, no Instagram. Shared by the
 * engine (runtime.ts) and the sandbox (sandbox.ts).
 */

import type { AiHandoffState } from "@/app/generated/prisma/client";
import { extractPhone, looksLikeBrokenPhone, stripPhone } from "@/lib/leads/phone";
import type { Collected } from "@/lib/leads/service";
import { isRepeat } from "@/lib/assistant/humanize";
import type { Lang } from "@/lib/assistant/language";
import { failureKindOf, LlmError, llmTimeoutMs, type LLMProvider, type LlmMessage } from "@/lib/assistant/llm/provider";
import { filterReply } from "@/lib/assistant/post-filter";
import { pickTemplate, renderFinalMessage } from "@/lib/assistant/templates";
import { askedQuestion, mergeHistory, sanitizeName, stripEmail, type TurnEvent, type TurnUsage } from "@/lib/assistant/turn";
import { containsWords, normalizeForMatch } from "@/lib/triggers/keywords";
import {
  FACTUAL_INTENTS,
  HANDOFF_REASONS,
  type HandoffReason,
  type JavobAiConfig,
  type JavobAiIntent,
  type QualificationField,
} from "./config";
import type { KnowledgeBlock } from "./knowledge";
import { detectLanguageV2, fromLegacyLang, toLegacyLang } from "./language";
import { buildJavobAiSystemPrompt, nextStepInstruction, type AgentStage } from "./prompt";
import { detectsPriceQuestion } from "./price-detector";
import { dropKnownFieldQuestions, limitToOneQuestion, stripQuestions } from "./reply-rules";
import { DEFAULT_TURN_CAPS, type TurnCaps } from "./routing";
import { JAVOBAI_JSON_SCHEMA, parseJavobAiOutput, type JavobAiOutput } from "./schema";
import {
  bandFor,
  computeScore,
  newSignals,
  signalsFromTurn,
  temperatureFor,
  type ScoreBand,
  type ScoreEvent,
  type ScoringConfig,
} from "./scoring";
import { handoffTemplateFor, pickJavobAiTemplate, qualificationTemplate } from "./templates";

export type { TurnEvent, TurnUsage };

/** Fields extracted by code from the model's output, persisted in AiConversationState.extracted. */
export interface ExtractedFields {
  name?: string | null;
  email?: string | null;
  product?: string | null;
  interest?: string | null;
  budget?: string | null;
  location?: string | null;
  extra_field?: string | null;
}

export interface HandoffRuleSnapshot {
  kind: "KEYWORD" | "INTENT" | "SCORE" | "UNKNOWN_COUNT" | "OFF_HOURS";
  value: unknown;
}

export interface JavobAiTurnContext {
  kb: KnowledgeBlock;
  config: JavobAiConfig;
  scoring: ScoringConfig;
  rules: HandoffRuleSnapshot[];
  state: {
    handoffState: AiHandoffState;
    score: number;
    extracted: ExtractedFields;
    unknownStreak: number;
    turns: number;
    /** Signals already counted in this lead cycle. */
    countedSignals: string[];
    phoneAskCount: number;
    /** Qualification fields already asked (each is asked once). */
    askedFields: string[];
    /** Grounded replies already sent while the handoff is pending. */
    postHandoffReplies: number;
  };
  /** Production's Conversation.collected (name, phone, language). */
  collected: Collected;
  /** `text` (4.2) = `contactMemoryBlock(...)`, rendered verbatim in the prompt. */
  memory: { summary: string; facts: Record<string, string>; returning: boolean; text?: string | null };
  context: { campaignName?: string | null; cameFromAd?: boolean; adTitle?: string | null };
  /**
   * 4.3: what vision made of the photo(s) in this turn. `preferredFactIds`
   * (catalog matches, KB ids) satisfy the grounding rule when the model cites
   * nothing; `question` is the model's clarifying question ("ask");
   * `unreadable` = the picture was not understood → counted as an unknown.
   */
  media?: {
    systemNote?: string | null;
    preferredFactIds?: string[];
    question?: string | null;
    unreadable?: boolean;
  } | null;
  /** Prior messages, oldest first, EXCLUDING the customer text of this turn. */
  history: LlmMessage[];
  customerText: string;
  hasMedia: boolean;
  igName: string | null;
  lastBotMessage: string | null;
  templateOnly: boolean;
  now?: Date;
  llm: LLMProvider | null;
  /**
   * 4.4: the stronger model for ONE retry of a low-confidence / uncited
   * factual answer (routing "retry_low_confidence"); null = no retry.
   */
  llmRetry?: LLMProvider | null;
  /** 4.4 per-turn caps (history window, output tokens); defaults when absent. */
  caps?: TurnCaps;
}

export interface JavobAiTurnResult {
  /** null = stay silent. */
  reply: string | null;
  intent: string;
  confidence: number;
  usedFacts: string[];
  extracted: ExtractedFields;
  collected: Collected;
  language: Lang;
  score: number;
  temperature: "COLD" | "WARM" | "HOT";
  band: ScoreBand;
  /** Signals first counted in this turn. */
  signals: ScoreEvent[];
  handoff: { needed: boolean; reason?: HandoffReason };
  unknownQuestion: string | null;
  unknownStreak: number;
  turns: number;
  phoneAskCount: number;
  askedField: QualificationField | null;
  askedPhone: boolean;
  /** This reply was one of the few allowed while a handoff is pending. */
  postHandoff: boolean;
  blockedBy: string | null;
  lead: null | { summary: string; flag: "complaint" | null };
  /** The phone number arrived in this turn. */
  phoneCaptured: boolean;
  memoryNote: string | null;
  usedTemplate: boolean;
  llmFailed: boolean;
  usages: TurnUsage[];
  events: TurnEvent[];
}

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const PHONE_WORDS = /(raqam|nomer|telefon|рақам|номер|телефон)/i;
const QUESTION_MARK = /[?؟]/;
const GREETING_ONLY = /^(salom|assalomu alaykum|assalomu aleykum|ассалому алайкум|салом|привет|здравствуйте|hello|hi)[\s!.]*$/i;
const PHONE_ASK_LIMIT = 2;
/** The user line when the customer sent only a photo (the description is in the system prompt). */
const PHOTO_ONLY_TEXT = "[rasm yubordi]";

export function extractEmail(text: string): string | null {
  const m = text.match(EMAIL);
  return m ? m[0].toLowerCase() : null;
}

const TEMP_RANK = { COLD: 0, WARM: 1, HOT: 2 } as const;

// ─── LLM call ─────────────────────────────────────────────────────────────────

interface LlmCall {
  output: JavobAiOutput | null;
  usages: TurnUsage[];
  events: TurnEvent[];
  failed: boolean;
}

async function callLlm(ctx: JavobAiTurnContext, system: string, llm: LLMProvider | null = ctx.llm): Promise<LlmCall> {
  const usages: TurnUsage[] = [];
  const events: TurnEvent[] = [];
  if (!llm) return { output: null, usages, events, failed: true };
  const caps = ctx.caps ?? DEFAULT_TURN_CAPS;
  const messages = mergeHistory(ctx.history.slice(-caps.maxHistory), ctx.customerText.trim() || PHOTO_ONLY_TEXT);

  let extraNudge = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    const callStarted = Date.now();
    try {
      const response = await llm.complete({
        system: system + extraNudge,
        messages,
        schema: JAVOBAI_JSON_SCHEMA as unknown as Record<string, unknown>,
        schemaName: "javobai_reply",
        temperature: 0.3,
        maxTokens: caps.maxTokens,
        timeoutMs: llmTimeoutMs(),
      });
      usages.push({
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        costUsd: llm.costUsd(response.inputTokens, response.outputTokens, response.model),
        latencyMs: response.latencyMs,
        ok: true,
      });
      const parsed = parseJavobAiOutput(response.json);
      if (parsed) {
        if (parsed.reply.length > 300 && attempt === 0) {
          extraNudge = "\n\nOLDINGI JAVOB JUDA UZUN EDI. 300 belgidan qisqa, 1–2 gap yoz.";
          continue;
        }
        return { output: parsed, usages, events, failed: false };
      }
      events.push({ type: "llm_bad_json", payload: { attempt } });
    } catch (error) {
      usages.push({ model: error instanceof LlmError && error.model ? error.model : llm.model, inputTokens: 0, outputTokens: 0, costUsd: 0, latencyMs: error instanceof LlmError && error.latencyMs ? error.latencyMs : Date.now() - callStarted, ok: false, errorKind: failureKindOf(error, "javobai_reply") });
      events.push({ type: "llm_error", payload: { message: error instanceof LlmError ? error.message : "LLM error", kind: error instanceof LlmError ? error.kind : "unknown", status: error instanceof LlmError ? (error.status ?? null) : null } });
      return { output: null, usages, events, failed: true };
    }
  }
  return { output: null, usages, events, failed: true };
}

/**
 * 4.4 "retry_low_confidence": a factual answer the default model could not
 * ground (no cited fact or confidence under the threshold) gets ONE more try
 * on the smart model when the engine configured one; the better-grounded
 * answer wins. Never called without `ctx.llmRetry`.
 */
async function retryLowConfidence(ctx: JavobAiTurnContext, system: string, first: JavobAiOutput, validIds: Set<string>): Promise<LlmCall | null> {
  if (!ctx.llmRetry || ctx.llmRetry === ctx.llm) return null;
  const cited = first.used_facts.filter((id) => validIds.has(id));
  const weak = FACTUAL_INTENTS.includes(first.intent) && (cited.length === 0 || first.confidence < ctx.config.confidenceThreshold);
  if (!weak || first.unknown_question) return null;
  const retry = await callLlm(ctx, system, ctx.llmRetry);
  retry.events.push({ type: "retry_low_confidence", payload: { confidence: first.confidence, retried: Boolean(retry.output) } });
  if (!retry.output) return retry;
  const retryCited = retry.output.used_facts.filter((id) => validIds.has(id));
  const better = retryCited.length > cited.length || (retryCited.length === cited.length && retry.output.confidence > first.confidence);
  return better ? retry : { ...retry, output: first };
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function knownFields(extracted: ExtractedFields, collected: Collected) {
  return {
    name: extracted.name ?? collected.name ?? null,
    product: extracted.product ?? collected.product_interest ?? null,
    budget: extracted.budget ?? null,
    location: extracted.location ?? null,
    phone: Boolean(collected.phone_e164),
  };
}

function isFieldKnown(field: QualificationField, extracted: ExtractedFields, collected: Collected): boolean {
  if (field === "product") return Boolean(extracted.product || collected.product_interest);
  return Boolean(extracted[field]);
}

/** The merged extraction after a model answer (code-sanitised). */
function mergeExtracted(prev: ExtractedFields, out: JavobAiOutput | null, text: string): ExtractedFields {
  const next: ExtractedFields = { ...prev };
  const name = sanitizeName(out?.extracted.name);
  if (name) next.name = name;
  const email = extractEmail(text) ?? (out?.extracted.email && EMAIL.test(out.extracted.email) ? out.extracted.email.toLowerCase() : null);
  if (email) next.email = email;
  if (out?.extracted.product) next.product = out.extracted.product.slice(0, 120);
  if (out?.extracted.interest) next.interest = out.extracted.interest.slice(0, 200);
  if (out?.extracted.budget && !extractPhone(out.extracted.budget)) next.budget = out.extracted.budget.slice(0, 80);
  if (out?.extracted.location) next.location = out.extracted.location.slice(0, 80);
  // A phone number is never the owner's extra field (same guard as production).
  const extra = out?.extracted.extra_field;
  if (extra && !extractPhone(extra) && (extra.match(/\d/g)?.length ?? 0) < 7) next.extra_field = extra.slice(0, 120);
  return next;
}

function toMinutes(hhmm: unknown): number | null {
  const m = typeof hhmm === "string" ? hhmm.match(/^(\d{1,2}):(\d{2})$/) : null;
  return m ? Number(m[1]) * 60 + Number(m[2]) : null;
}

/** First business rule (AiHandoffRule) that fires, or null. OFF_HOURS = the off-hours window itself. */
export function matchHandoffRule(
  rules: HandoffRuleSnapshot[],
  input: { text: string; intent: string; score: number; unknownStreak: number; now: Date }
): HandoffRuleSnapshot | null {
  const normalizedText = normalizeForMatch(input.text);
  for (const rule of rules) {
    const value = (rule.value && typeof rule.value === "object" ? rule.value : {}) as Record<string, unknown>;
    switch (rule.kind) {
      case "KEYWORD": {
        const keywords = Array.isArray(value.keywords) ? (value.keywords as unknown[]).map(String) : [];
        if (keywords.some((k) => containsWords(normalizedText, normalizeForMatch(k)))) return rule;
        break;
      }
      case "INTENT": {
        const intents = Array.isArray(value.intents) ? (value.intents as unknown[]).map(String) : [];
        if (intents.includes(input.intent)) return rule;
        break;
      }
      case "SCORE":
        if (Number.isFinite(Number(value.min)) && input.score >= Number(value.min)) return rule;
        break;
      case "UNKNOWN_COUNT":
        if (Number.isFinite(Number(value.count)) && Number(value.count) > 0 && input.unknownStreak >= Number(value.count)) return rule;
        break;
      case "OFF_HOURS": {
        const from = toMinutes(value.from);
        const to = toMinutes(value.to);
        if (from === null || to === null) break;
        const offset = Number.isFinite(Number(value.tzOffsetMinutes)) ? Number(value.tzOffsetMinutes) : 300;
        const local = new Date(input.now.getTime() + offset * 60_000);
        const minutes = local.getUTCHours() * 60 + local.getUTCMinutes();
        const inside = from <= to ? minutes >= from && minutes < to : minutes >= from || minutes < to;
        if (inside) return rule;
        break;
      }
    }
  }
  return null;
}

function leadSummary(extracted: ExtractedFields, intent: string, reason: HandoffReason | null): string {
  const parts: string[] = [];
  if (intent === "purchase_intent" || intent === "payment_intent" || reason === "purchase_ready") {
    parts.push(`Sotib olmoqchi${extracted.product ? `: ${extracted.product}` : ""}.`);
  } else if (extracted.product) {
    parts.push(`Qiziqqan mahsulot: ${extracted.product}.`);
  }
  if (extracted.interest) parts.push(`Ehtiyoj: ${extracted.interest}.`);
  if (extracted.budget) parts.push(`Byudjet: ${extracted.budget}.`);
  if (extracted.location) parts.push(`Hudud: ${extracted.location}.`);
  if (extracted.email) parts.push(`Email: ${extracted.email}.`);
  if (reason && reason !== "phone_captured" && reason !== "purchase_ready") parts.push(`Sabab: ${HANDOFF_REASONS[reason]}.`);
  if (!parts.length) parts.push("Mijoz bog'lanish uchun raqam qoldirdi.");
  return parts.join(" ");
}

// ─── The turn ─────────────────────────────────────────────────────────────────

export async function runJavobAiTurn(ctx: JavobAiTurnContext): Promise<JavobAiTurnResult> {
  const now = ctx.now ?? new Date();
  const events: TurnEvent[] = [];
  const usages: TurnUsage[] = [];
  const text = ctx.customerText.trim();
  // v2 detector (4.2): the previous turn breaks Cyrillic ties; emoji / numbers
  // only keep the earlier language; a fresh thread falls back to Uzbek Latin.
  const previousLang = fromLegacyLang(ctx.collected.language);
  const langV2 = detectLanguageV2(text, previousLang);
  const lang = toLegacyLang(langV2 === "unknown" ? previousLang : langV2);
  const collected: Collected = { ...ctx.collected, language: lang };
  const { config, scoring, kb } = ctx;
  const thresholds = scoring.thresholds;
  const media = ctx.media ?? null;
  const photoUnderstood = Boolean(media?.systemNote);

  const phoneNow = collected.phone_e164 ? null : extractPhone(text);
  if (phoneNow) {
    collected.phone_e164 = phoneNow.e164;
    collected.phone_raw = phoneNow.raw;
  }
  const phoneKnown = Boolean(collected.phone_e164);

  const base = {
    intent: "other" as string,
    confidence: 0,
    usedFacts: [] as string[],
    extracted: { ...ctx.state.extracted },
    collected,
    language: lang,
    score: ctx.state.score,
    temperature: temperatureFor(ctx.state.score, thresholds),
    band: bandFor(ctx.state.score, thresholds),
    signals: [] as ScoreEvent[],
    handoff: { needed: false } as JavobAiTurnResult["handoff"],
    unknownQuestion: null as string | null,
    unknownStreak: ctx.state.unknownStreak,
    turns: ctx.state.turns,
    phoneAskCount: ctx.state.phoneAskCount,
    askedField: null as QualificationField | null,
    askedPhone: false,
    postHandoff: false,
    blockedBy: null as string | null,
    lead: null as JavobAiTurnResult["lead"],
    phoneCaptured: Boolean(phoneNow),
    memoryNote: null as string | null,
    usedTemplate: false,
    llmFailed: false,
    usages,
    events,
  };

  // ── Handoff pending: a few grounded short replies, then silence ───────────
  if (ctx.state.handoffState === "HANDOFF_PENDING") {
    return postHandoffTurn(ctx, base, lang, phoneNow !== null);
  }

  // ── Hard limit: the conversation is too long for a bot ────────────────────
  if (!phoneNow && ctx.state.turns >= config.maxTurns) {
    events.push({ type: "fallback", payload: { reason: "max_turns" } });
    return finishHandoff(ctx, base, lang, "max_turns", null);
  }

  // ── Photo / voice without text: fixed reply, no model ─────────────────────
  // (4.3: a photo vision described goes to the model with the note instead.)
  if (!phoneNow && ctx.hasMedia && !text && !photoUnderstood) {
    const askPhone = !phoneKnown && ctx.state.phoneAskCount < PHONE_ASK_LIMIT;
    return {
      ...base,
      reply: askPhone ? pickTemplate("media", { lang, avoid: ctx.lastBotMessage }) : pickJavobAiTemplate("unknown", { lang }),
      turns: ctx.state.turns + 1,
      phoneAskCount: ctx.state.phoneAskCount + (askPhone ? 1 : 0),
      askedPhone: askPhone,
      usedTemplate: true,
    };
  }

  // ── What code wants from this turn (chosen before the model answers) ──────
  const known = knownFields(ctx.state.extracted, collected);
  const askField =
    config.qualificationQuestions.find(
      (f) => !isFieldKnown(f, ctx.state.extracted, collected) && !ctx.state.askedFields.includes(f)
    ) ?? null;
  const qualificationDone = config.qualificationQuestions.every(
    (f) => isFieldKnown(f, ctx.state.extracted, collected) || ctx.state.askedFields.includes(f)
  );
  const warmEnough = TEMP_RANK[temperatureFor(ctx.state.score, thresholds)] >= TEMP_RANK[config.askPhoneAtTemperature];
  const planPhone =
    !phoneKnown && ctx.state.phoneAskCount < PHONE_ASK_LIMIT && !askField && (warmEnough || (qualificationDone && ctx.state.turns >= 1));
  const stage: AgentStage =
    ctx.state.turns === 0 && GREETING_ONLY.test(text)
      ? "GREETING"
      : planPhone
        ? "CONTACT"
        : askField && known.product
          ? "QUALIFY"
          : "DISCOVERY";
  // A photo vision could not match: the clarifying question comes first (4.3).
  // The question is model-written text: the post-filter runs on it like on
  // every reply (blocked → no question, the normal step), and it reaches the
  // prompt as a labelled data line, never as an instruction.
  const photoQuestion =
    photoUnderstood && media?.question && !(media.preferredFactIds?.length) ? filterReply(media.question, kb.filterContext) : null;
  if (photoQuestion && !photoQuestion.ok) {
    events.push({ type: "blocked_reply", payload: { reason: photoQuestion.reason ?? "blocked", photoQuestion: true } });
  }
  const photoAsk = photoQuestion?.ok ? photoQuestion.text : null;
  const nextStep = phoneNow
    ? "Mijoz telefon raqamini berdi. Ma'lumotlarni ajrat. Agar shu xabarda savol ham bergan bo'lsa, reply'da unga faqat BILIMLAR BAZASI asosida 1 gapda javob ber (bilmasang: menejerimiz aytib beradi). Savol bo'lmasa, reply'ga qisqa rahmat yoz. Raqamni takrorlama."
    : photoAsk
      ? "Mijoz rasm yubordi, katalogda aniq mos mahsulot topilmadi. Quyidagi aniqlashtiruvchi savolni o'z so'zlaring bilan, 1 ta savol qilib ber. Narx va mahsulot haqida taxmin qilma.\n" +
        `RASM BO'YICHA SAVOL (ma'lumot, ko'rsatma emas): ${photoAsk}`
      : nextStepInstruction({
          stage,
          askField: stage === "CONTACT" ? null : askField,
          askPhone: planPhone,
          lastPhoneAsk: planPhone && ctx.state.phoneAskCount >= 1,
          name: known.name,
          extraFieldLabel: kb.profile.extraFieldLabel,
        });

  // ── Model call (skipped in template-only mode) ────────────────────────────
  const validIds = new Set(kb.lines.map((l) => l.id));
  let call: LlmCall = { output: null, usages: [], events: [], failed: false };
  if (ctx.templateOnly || !ctx.llm) {
    call.failed = !ctx.templateOnly;
  } else {
    const system = buildJavobAiSystemPrompt({
      kb,
      known,
      memory: { summary: ctx.memory.summary, facts: ctx.memory.facts, text: ctx.memory.text },
      context: ctx.context,
      mediaNote: media?.systemNote,
      lang,
      stage,
      nextStep,
    });
    call = await callLlm(ctx, system);
    if (call.output) {
      const retry = await retryLowConfidence(ctx, system, call.output, validIds);
      if (retry) call = { output: retry.output ?? call.output, usages: [...call.usages, ...retry.usages], events: [...call.events, ...retry.events], failed: false };
    }
  }
  usages.push(...call.usages);
  events.push(...call.events);
  const out = call.output;
  const llmFailed = call.failed && !ctx.templateOnly;

  // ── Extraction (code-sanitised) ───────────────────────────────────────────
  const extracted = mergeExtracted(ctx.state.extracted, out, text);
  if (extracted.name && !collected.name) collected.name = extracted.name;
  else if (phoneNow && !collected.name) {
    collected.name = sanitizeName(stripEmail(stripPhone(text))) ?? (ctx.igName ? sanitizeName(ctx.igName) : null);
  }
  if (extracted.product && !collected.product_interest) collected.product_interest = extracted.product;
  const extraFieldChanged = extracted.extra_field && extracted.extra_field !== ctx.state.extracted.extra_field;
  if (extraFieldChanged) collected.extra_field = extracted.extra_field;

  // Union with the deterministic price detector (B-05): a price question the
  // model labelled OTHER / greeting still counts as one.
  const priceHit = detectsPriceQuestion(text);
  let intent: JavobAiIntent = out?.intent ?? (phoneNow ? "gives_contact" : "other");
  if (priceHit && (intent === "other" || intent === "greeting")) intent = "price_question";
  const confidence = out?.confidence ?? 0;
  const cited = (out?.used_facts ?? []).filter((id) => validIds.has(id));
  // A confident catalog match from the photo grounds an uncited answer (4.3).
  const preferred = (media?.preferredFactIds ?? []).filter((id) => validIds.has(id));
  const usedFacts = cited.length === 0 && out !== null && preferred.length ? preferred : cited;

  // ── Grounding rule ────────────────────────────────────────────────────────
  // A price question under a NEVER policy is answered with "the manager will
  // tell you" by design — not a gap; neither is the clarifying question about
  // a photo (a question, not a claim — the post-filter still runs on it). A
  // photo vision could not read counts as an unknown (gap + streak), never as
  // a handoff on its own.
  const factual =
    FACTUAL_INTENTS.includes(intent) && !(intent === "price_question" && kb.profile.pricePolicy === "NEVER") && !photoAsk;
  const photoUnreadable = Boolean(media?.unreadable) && !phoneNow;
  const unknown =
    photoUnreadable ||
    (!phoneNow &&
      out !== null &&
      (Boolean(out.unknown_question) || (factual && (usedFacts.length === 0 || confidence < config.confidenceThreshold))));
  const unknownStreak = unknown ? ctx.state.unknownStreak + 1 : 0;
  const unknownQuestion = unknown ? (out?.unknown_question ?? (text || PHOTO_ONLY_TEXT).slice(0, 200)) : null;
  if (unknown) {
    events.push({
      type: "grounding_unknown",
      payload: {
        intent,
        confidence,
        usedFacts,
        reason: photoUnreadable ? "photo_unreadable" : out?.unknown_question ? "model" : usedFacts.length === 0 ? "no_facts" : "low_confidence",
      },
    });
  }

  // ── Scoring (code, once per signal per cycle) ─────────────────────────────
  const candidates = signalsFromTurn(
    { intent, extracted, phoneKnown, returningContact: ctx.memory.returning, cameFromAd: Boolean(ctx.context.cameFromAd), priceAsked: priceHit },
    scoring.rules
  );
  const signals = newSignals(candidates, ctx.state.countedSignals);
  const score = computeScore([{ signal: "_previous", points: ctx.state.score }, ...signals]);
  const temperature = temperatureFor(score, thresholds);
  const band = bandFor(score, thresholds);
  const purchase = intent === "purchase_intent" || intent === "payment_intent" || ctx.state.countedSignals.includes("purchase_intent");

  // ── Handoff decision (TZ 25), first reason wins ───────────────────────────
  let reason: HandoffReason | null = null;
  const requested = out?.handoff_request.needed ? out.handoff_request.reason : null;
  if (intent === "wants_human" || requested === "wants_human") reason = "wants_human";
  else if (intent === "complaint" || requested === "complaint") reason = "complaint";
  else if (intent === "sensitive" || requested === "sensitive") reason = "sensitive";
  else if (unknown && unknownStreak >= config.unknownStreakForHandoff) reason = "unknown_streak";
  else if (purchase && phoneKnown) reason = "purchase_ready";
  else if (phoneNow) reason = "phone_captured";
  else if (scoring.handoffAtScore !== null && score >= scoring.handoffAtScore) reason = "score";
  else if (matchHandoffRule(ctx.rules, { text, intent, score, unknownStreak, now })) reason = "rule";

  const scored = {
    ...base,
    intent,
    confidence,
    usedFacts,
    extracted,
    collected,
    score,
    temperature,
    band,
    signals,
    unknownStreak,
    unknownQuestion,
    memoryNote: out?.memory_note ?? null,
    llmFailed,
  };

  if (reason) {
    // The model's answer to a question asked together with the number / the
    // request is kept in front of the closing line (as production does).
    const answer =
      out && (phoneNow ? askedQuestion(stripPhone(text), intent) : reason === "purchase_ready") && !unknown
        ? filterReply(out.reply, kb.filterContext)
        : null;
    return finishHandoff(ctx, scored, lang, reason, answer?.ok && !isRepeat(answer.text, ctx.lastBotMessage) ? answer.text : null);
  }

  // ── Reply composition ─────────────────────────────────────────────────────
  let reply = "";
  let usedTemplate = false;
  let blockedBy: string | null = null;
  const fallback = () =>
    photoAsk
      ? photoAsk
      : askField && !planPhone
        ? qualificationTemplate(askField, lang)
        : planPhone
          ? pickJavobAiTemplate("ask_phone", { lang, avoid: ctx.lastBotMessage })
          : stage === "GREETING"
            ? pickTemplate("new", { lang, avoid: ctx.lastBotMessage })
            : pickTemplate("need", { lang, avoid: ctx.lastBotMessage });

  if (unknown) {
    reply = pickJavobAiTemplate("unknown", { lang, avoid: ctx.lastBotMessage });
    usedTemplate = true;
  } else if (out) {
    const verdict = filterReply(out.reply, kb.filterContext);
    if (verdict.ok && !isRepeat(verdict.text, ctx.lastBotMessage)) {
      reply = verdict.text;
    } else {
      blockedBy = verdict.ok ? "repeat" : (verdict.reason ?? "blocked");
      events.push({ type: "blocked_reply", payload: { reason: blockedBy, reply: out.reply.slice(0, 300) } });
      reply = fallback();
      usedTemplate = true;
    }
  } else {
    reply = fallback();
    usedTemplate = true;
  }

  // ── Re-plan with what this turn extracted ─────────────────────────────────
  // The model may have just given us the field we were about to ask for
  // ("5 mln" answers the budget question), and the score may have warmed up.
  const askFieldNow =
    config.qualificationQuestions.find((f) => !isFieldKnown(f, extracted, collected) && !ctx.state.askedFields.includes(f)) ?? null;
  const qualificationDoneNow = config.qualificationQuestions.every(
    (f) => isFieldKnown(f, extracted, collected) || ctx.state.askedFields.includes(f)
  );
  const warmNow = TEMP_RANK[temperature] >= TEMP_RANK[config.askPhoneAtTemperature];
  const askPhoneNow =
    !phoneKnown && ctx.state.phoneAskCount < PHONE_ASK_LIMIT && !askFieldNow && (warmNow || (qualificationDoneNow && ctx.state.turns >= 1));

  // Looks like a number but is not one: say so (counts as a phone ask).
  if (!phoneKnown && askPhoneNow && looksLikeBrokenPhone(text) && !unknown) {
    reply = pickTemplate("bad_phone", { lang, avoid: ctx.lastBotMessage });
    usedTemplate = true;
  }

  // ── Make sure the step code wanted is in the reply ────────────────────────
  // B-09 / B-10: never ask about a field the customer already gave, and never
  // more than ONE question. A question chosen by code replaces the model's own.
  const knownNow = { name: Boolean(collected.name), budget: Boolean(extracted.budget), location: Boolean(extracted.location), phone: phoneKnown, product: Boolean(extracted.product || collected.product_interest) };
  reply = dropKnownFieldQuestions(reply, knownNow);
  let askedPhone = false;
  let askedField: QualificationField | null = null;
  if (purchase && !phoneKnown && ctx.state.phoneAskCount < PHONE_ASK_LIMIT) {
    // Purchase-ready without a number: ask for it now, whatever was planned.
    if (!(PHONE_WORDS.test(reply) && QUESTION_MARK.test(reply))) reply = `${stripQuestions(reply)}\n${pickJavobAiTemplate("ask_phone_purchase", { lang })}`.trim();
    askedPhone = true;
  } else if (askPhoneNow && !unknown) {
    if (!PHONE_WORDS.test(reply) || !QUESTION_MARK.test(reply)) {
      reply = `${stripQuestions(reply)}\n${pickJavobAiTemplate("ask_phone", { lang, avoid: ctx.lastBotMessage })}`.trim();
    }
    askedPhone = true;
  } else if (askFieldNow && !unknown) {
    if (!QUESTION_MARK.test(reply)) reply = `${reply}
${qualificationTemplate(askFieldNow, lang)}`.trim();
    askedField = askFieldNow;
  }
  reply = limitToOneQuestion(reply);
  if (!reply.trim()) reply = fallback();

  return {
    ...scored,
    reply,
    turns: ctx.state.turns + 1,
    phoneAskCount: ctx.state.phoneAskCount + (askedPhone ? 1 : 0),
    askedField,
    askedPhone,
    blockedBy,
    lead: null,
    usedTemplate,
  };
}

const WORKING_HOURS_LABEL: Record<Lang, string> = { uz_latn: "Ish vaqtimiz", uz_cyrl: "Иш вақтимиз", ru: "Время работы" };

/** The ONE "qabul qilindi" line carries an approximate time: the shop's working hours (B-06). */
function withWorkingHours(message: string, workingHours: string | null | undefined, lang: Lang): string {
  const hours = workingHours?.trim();
  return hours ? `${message} (${WORKING_HOURS_LABEL[lang] ?? WORKING_HOURS_LABEL.uz_latn}: ${hours.slice(0, 80)})` : message;
}

/** Close the AI's part: handoff reply (+ an optional answer line), lead when the phone is known. */
function finishHandoff(
  ctx: JavobAiTurnContext,
  base: Omit<JavobAiTurnResult, "reply">,
  lang: Lang,
  reason: HandoffReason,
  answer: string | null
): JavobAiTurnResult {
  const phone = base.collected.phone_e164 ?? null;
  const closing =
    base.phoneCaptured && phone
      ? renderFinalMessage({ lang, name: base.collected.name ?? null, phoneE164: phone, template: ctx.kb.profile.finalMessageTemplate })
      : withWorkingHours(handoffTemplateFor(reason, lang), ctx.kb.profile.workingHours, lang);
  const reply = answer ? `${answer}\n${closing}` : closing;
  const complaint = reason === "complaint";
  return {
    ...base,
    reply,
    handoff: { needed: true, reason },
    turns: base.turns + 1,
    lead: phone ? { summary: leadSummary(base.extracted, base.intent, reason), flag: complaint ? "complaint" : null } : null,
    usedTemplate: !answer,
  };
}

/**
 * While a handoff is pending the customer may still ask something: a few
 * short grounded replies, then silence (the manager owns the thread). A
 * number given now is still captured as the lead.
 */
async function postHandoffTurn(
  ctx: JavobAiTurnContext,
  base: Omit<JavobAiTurnResult, "reply">,
  lang: Lang,
  phoneNow: boolean
): Promise<JavobAiTurnResult> {
  const phone = base.collected.phone_e164 ?? null;
  if (phoneNow && phone) {
    const signals = newSignals(
      signalsFromTurn({ intent: "gives_contact", extracted: base.extracted, phoneKnown: true, returningContact: false, cameFromAd: false }, ctx.scoring.rules),
      ctx.state.countedSignals
    );
    const score = computeScore([{ signal: "_previous", points: ctx.state.score }, ...signals]);
    return {
      ...base,
      reply: renderFinalMessage({ lang, name: base.collected.name ?? null, phoneE164: phone, template: ctx.kb.profile.finalMessageTemplate }),
      intent: "gives_contact",
      signals,
      score,
      temperature: temperatureFor(score, ctx.scoring.thresholds),
      band: bandFor(score, ctx.scoring.thresholds),
      lead: { summary: leadSummary(base.extracted, "gives_contact", null), flag: null },
      postHandoff: true,
      usedTemplate: true,
    };
  }
  if (ctx.state.postHandoffReplies >= ctx.config.postHandoffReplies) {
    return { ...base, reply: null, postHandoff: true };
  }
  const text = ctx.customerText.trim();
  // The "manager will answer soon" line goes out at most once: a repeat stays silent.
  const silent = () => {
    const line = pickJavobAiTemplate("silent_pending", { lang, avoid: ctx.lastBotMessage });
    return { ...base, reply: isRepeat(line, ctx.lastBotMessage) ? null : line, postHandoff: true, usedTemplate: true };
  };
  if (ctx.templateOnly || !ctx.llm || !text) return silent();

  const system = buildJavobAiSystemPrompt({
    kb: ctx.kb,
    known: knownFields(base.extracted, base.collected),
    memory: { summary: ctx.memory.summary, facts: ctx.memory.facts, text: ctx.memory.text },
    context: ctx.context,
    mediaNote: ctx.media?.systemNote,
    lang,
    stage: "POST_HANDOFF",
    nextStep: nextStepInstruction({ stage: "POST_HANDOFF", askField: null, askPhone: false, lastPhoneAsk: false, name: null, extraFieldLabel: null }),
  });
  const call = await callLlm(ctx, system);
  base.usages.push(...call.usages);
  base.events.push(...call.events);
  const out = call.output;
  if (!out) return { ...silent(), llmFailed: call.failed };
  const validIds = new Set(ctx.kb.lines.map((l) => l.id));
  const usedFacts = out.used_facts.filter((id) => validIds.has(id));
  const factual = FACTUAL_INTENTS.includes(out.intent);
  if (out.unknown_question || (factual && usedFacts.length === 0)) {
    return { ...silent(), intent: out.intent, unknownQuestion: out.unknown_question ?? text.slice(0, 200) };
  }
  const verdict = filterReply(out.reply, ctx.kb.filterContext);
  if (!verdict.ok || isRepeat(verdict.text, ctx.lastBotMessage)) {
    base.events.push({ type: "blocked_reply", payload: { reason: verdict.ok ? "repeat" : verdict.reason, postHandoff: true } });
    return { ...silent(), intent: out.intent, blockedBy: verdict.ok ? "repeat" : (verdict.reason ?? "blocked") };
  }
  return { ...base, reply: verdict.text, intent: out.intent, confidence: out.confidence, usedFacts, postHandoff: true };
}
