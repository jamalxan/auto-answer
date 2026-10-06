/**
 * One assistant turn: given the conversation so far and the customer's newest
 * message(s), decide the reply, the next state and whether a lead is captured.
 *
 * The state machine is *code*. The LLM only writes the reply text and extracts
 * facts (name, interest, summary); it can never move the conversation to a new
 * stage or decide that a lead exists. Phone numbers come from `phonenumbers`
 * style validation (lib/leads/phone), never from the model.
 *
 * Shared by the real Instagram flow (engine.ts) and the sandbox chat.
 */

import {
  extractPhone,
  looksLikeBrokenPhone,
  stripPhone,
} from "@/lib/leads/phone";
import type { Collected } from "@/lib/leads/service";
import { isRepeat } from "./humanize";
import { detectLanguage, normalizeLang, type Lang } from "./language";
import { LLM_JSON_SCHEMA, parseLlmOutput, type LlmOutput } from "./llm-output";
import { llmTimeoutMs, type LLMProvider, type LlmMessage } from "./llm/provider";
import { filterReply, type BlockReason } from "./post-filter";
import {
  buildSystemPrompt,
  nextStepInstruction,
  type ProfileSnapshot,
  type StageValue,
} from "./prompt";
import { pickTemplate, renderFinalMessage, type TemplateKey } from "./templates";

export type ActiveState = "NEW" | "NEED" | "CONTACT";
export type ResultState = "NEED" | "CONTACT" | "HANDED_OFF";

export interface TurnContext {
  profile: ProfileSnapshot;
  state: ActiveState;
  collected: Collected & { flag?: string | null };
  botMessageCount: number;
  phoneAskCount: number;
  spamStreak: number;
  maxBotMessages: number;
  fallbackLeadWithoutPhone: boolean;
  /** Prior messages, oldest first, EXCLUDING the customer text of this turn. */
  history: LlmMessage[];
  customerText: string;
  hasMedia: boolean;
  igName: string | null;
  lastBotMessage: string | null;
  templateOnly: boolean;
  offHours: boolean;
  offHoursMessage?: string | null;
  llm: LLMProvider | null;
}

export interface TurnUsage {
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  latencyMs: number;
  ok: boolean;
}

export interface TurnEvent {
  type: string;
  payload?: Record<string, unknown>;
}

export interface TurnResult {
  /** null = stay silent (spam hand-off). */
  reply: string | null;
  state: ResultState;
  collected: Collected & { flag?: string | null };
  botMessageCount: number;
  phoneAskCount: number;
  spamStreak: number;
  lead: null | { flag: "complaint" | "no_phone" | null; summary: string | null };
  unknownQuestion: string | null;
  intent: string;
  usedTemplate: boolean;
  llmFailed: boolean;
  usages: TurnUsage[];
  events: TurnEvent[];
}

const NAME_STOP = new Set([
  "salom", "assalomu", "alaykum", "привет", "здравствуйте", "ha", "yo'q", "yoq", "bor", "kerak",
  "rahmat", "спасибо", "да", "нет", "ok", "okay", "xo'p", "xop", "mayli",
]);

/** A usable first name: 1–3 words, letters only, sensible length. */
export function sanitizeName(value: string | null | undefined): string | null {
  if (!value) return null;
  const cleaned = value.replace(/[^\p{L}\s'‘’`ʻ.-]/gu, " ").replace(/\s+/g, " ").trim();
  if (!cleaned || cleaned.length > 40) return null;
  const words = cleaned.split(" ");
  if (words.length > 3) return null;
  if (words.some((w) => NAME_STOP.has(w.toLowerCase()))) return null;
  return cleaned.replace(/(^|\s)\p{L}/gu, (m) => m.toUpperCase());
}

function nameFromRemainder(text: string): string | null {
  return sanitizeName(stripPhone(text));
}

function stageFor(ctx: TurnContext, complaint: boolean): StageValue {
  if (complaint) return "CONTACT";
  if (ctx.state === "NEED" && (ctx.collected.product_interest || ctx.botMessageCount >= 2)) {
    return "CONTACT";
  }
  return ctx.state;
}

export function mergeHistory(history: LlmMessage[], customerText: string): LlmMessage[] {
  const all = [...history, { role: "user" as const, content: customerText }];
  const merged: LlmMessage[] = [];
  for (const m of all) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n${m.content}`;
    else merged.push({ ...m });
  }
  while (merged.length > 1 && merged[0].role !== "user") merged.shift();
  return merged;
}

interface LlmCall {
  output: LlmOutput | null;
  usages: TurnUsage[];
  events: TurnEvent[];
  failed: boolean;
}

async function callLlm(
  ctx: TurnContext,
  stage: StageValue,
  nextStep: string
): Promise<LlmCall> {
  const usages: TurnUsage[] = [];
  const events: TurnEvent[] = [];
  if (!ctx.llm) return { output: null, usages, events, failed: true };

  const system = buildSystemPrompt({
    profile: ctx.profile,
    customerText: ctx.customerText,
    stage,
    nextStep,
  });
  const messages = mergeHistory(ctx.history.slice(-12), ctx.customerText);

  let extraNudge = "";
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const response = await ctx.llm.complete({
        system: system + extraNudge,
        messages,
        schema: LLM_JSON_SCHEMA as unknown as Record<string, unknown>,
        schemaName: "assistant_reply",
        temperature: 0.4,
        maxTokens: 500,
        timeoutMs: llmTimeoutMs(),
      });
      usages.push({
        model: response.model,
        inputTokens: response.inputTokens,
        outputTokens: response.outputTokens,
        costUsd: ctx.llm.costUsd(response.inputTokens, response.outputTokens),
        latencyMs: response.latencyMs,
        ok: true,
      });
      const parsed = parseLlmOutput(response.json);
      if (parsed) {
        if (parsed.reply.length > 300 && attempt === 0) {
          extraNudge = "\n\nOLDINGI JAVOB JUDA UZUN EDI. 300 belgidan qisqa, 1–2 gap yoz.";
          continue;
        }
        return { output: parsed, usages, events, failed: false };
      }
      events.push({ type: "llm_bad_json", payload: { attempt } });
    } catch (error) {
      usages.push({
        model: ctx.llm.model,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
        latencyMs: 0,
        ok: false,
      });
      events.push({
        type: "llm_error",
        payload: { message: error instanceof Error ? error.message : String(error) },
      });
      // A provider outage will not heal within the same turn.
      return { output: null, usages, events, failed: true };
    }
  }
  return { output: null, usages, events, failed: true };
}

function defaultSummary(collected: Collected, lang: Lang): string {
  void lang;
  const interest = collected.product_interest ? ` (${collected.product_interest})` : "";
  return `Mijoz bog'lanish uchun raqam qoldirdi${interest}.`;
}

export async function runTurn(ctx: TurnContext): Promise<TurnResult> {
  const events: TurnEvent[] = [];
  const usages: TurnUsage[] = [];
  const lang = detectLanguage(ctx.customerText, normalizeLang(ctx.collected.language, "uz_latn"));
  const collected: TurnResult["collected"] = { ...ctx.collected, language: lang };
  const knownPrices = ctx.profile.products
    .filter((p) => p.price !== null)
    .map((p) => ({ amount: p.price as number, currency: p.currency }));
  const profileText = [
    ctx.profile.description,
    ctx.profile.address ?? "",
    ctx.profile.delivery ?? "",
    ...ctx.profile.faqs.map((f) => `${f.question} ${f.answer}`),
  ].join(" ");

  const base = {
    collected,
    botMessageCount: ctx.botMessageCount,
    phoneAskCount: ctx.phoneAskCount,
    spamStreak: ctx.spamStreak,
    unknownQuestion: null as string | null,
    intent: "other",
    usedTemplate: false,
    llmFailed: false,
    usages,
    events,
  };

  const phone = extractPhone(ctx.customerText);

  // ── Hard limits come first ────────────────────────────────────────────────
  if (!phone && ctx.botMessageCount >= ctx.maxBotMessages) {
    events.push({ type: "fallback", payload: { reason: "max_bot_messages" } });
    return finishFallback(ctx, base, lang);
  }

  // Customer sent a photo / voice note without text: fixed reply, no LLM.
  if (!phone && ctx.hasMedia && !ctx.customerText.trim()) {
    const reply = pickTemplate("media", { lang, avoid: ctx.lastBotMessage });
    return {
      ...base,
      reply,
      state: "CONTACT",
      botMessageCount: ctx.botMessageCount + 1,
      phoneAskCount: ctx.phoneAskCount + 1,
      lead: null,
      usedTemplate: true,
    };
  }

  const complaintAlready = collected.flag === "complaint";
  const stage = stageFor(ctx, complaintAlready);
  const lastAsk = stage === "CONTACT" && ctx.phoneAskCount >= 1;
  const nextStep = phone
    ? "Mijoz telefon raqamini berdi. Faqat ma'lumotlarni ajrat (ism, qiziqish, xulosa); reply'ga qisqa rahmat yoz."
    : nextStepInstruction({
        stage,
        name: collected.name ?? null,
        lastAsk,
        complaint: complaintAlready,
        extraFieldLabel: ctx.profile.extraFieldLabel,
      });

  // ── LLM call (skipped in template-only mode) ──────────────────────────────
  let call: LlmCall = { output: null, usages: [], events: [], failed: false };
  if (ctx.templateOnly || !ctx.llm) {
    call.failed = !ctx.templateOnly;
  } else {
    call = await callLlm(ctx, stage, nextStep);
  }
  usages.push(...call.usages);
  events.push(...call.events);
  const out = call.output;
  const intent = out?.intent ?? "other";

  // ── Extraction ────────────────────────────────────────────────────────────
  const extractedName = sanitizeName(out?.extracted.name);
  if (extractedName) collected.name = extractedName;
  else if (phone && !collected.name) collected.name = nameFromRemainder(ctx.customerText);
  else if (!phone && stage === "CONTACT" && !collected.name && !out) {
    collected.name = nameFromRemainder(ctx.customerText);
  }
  if (out?.extracted.product_interest) collected.product_interest = out.extracted.product_interest;
  if (out?.extracted.extra_field) collected.extra_field = out.extracted.extra_field;

  const wantsOperator = intent === "complaint" || intent === "wants_human";
  if (wantsOperator && intent === "complaint") collected.flag = "complaint";
  const complaint = collected.flag === "complaint";
  // A complaint / "I want a human" overrides the stage: collect the number now.
  const effStage: StageValue = complaint || wantsOperator ? "CONTACT" : stage;

  // ── Spam ──────────────────────────────────────────────────────────────────
  if (intent === "spam_or_irrelevant" && !phone) {
    const streak = ctx.spamStreak + 1;
    if (streak >= 2) {
      events.push({ type: "fallback", payload: { reason: "spam" } });
      return {
        ...base,
        reply: null,
        state: "HANDED_OFF",
        spamStreak: streak,
        lead: null,
        intent,
        llmFailed: call.failed && !ctx.templateOnly,
      };
    }
    base.spamStreak = streak;
  } else {
    base.spamStreak = 0;
  }

  // ── Phone received → capture ──────────────────────────────────────────────
  if (phone) {
    collected.phone_e164 = phone.e164;
    collected.phone_raw = phone.raw;
    if (!collected.name && ctx.igName) collected.name = sanitizeName(ctx.igName);
    const reply = renderFinalMessage({
      lang,
      name: collected.name ?? null,
      phoneE164: phone.e164,
      template: ctx.profile.finalMessageTemplate,
    });
    return {
      ...base,
      reply,
      state: "HANDED_OFF",
      botMessageCount: ctx.botMessageCount + 1,
      lead: {
        flag: complaint ? "complaint" : null,
        summary: out?.summary ?? defaultSummary(collected, lang),
      },
      intent: out?.intent ?? "gives_contact",
      unknownQuestion: out?.unknown_question ?? null,
      llmFailed: call.failed && !ctx.templateOnly,
      usedTemplate: false,
    };
  }

  // ── No phone this turn ────────────────────────────────────────────────────
  // Two asks without a number: stop asking (TZ 4.1) and hand over.
  if (effStage === "CONTACT" && ctx.phoneAskCount >= 2) {
    events.push({ type: "fallback", payload: { reason: "phone_refused" } });
    return finishFallback(ctx, { ...base, intent, llmFailed: call.failed && !ctx.templateOnly }, lang, out);
  }

  const asksPhone = effStage === "CONTACT";

  // Off-hours first message: dedicated text, still asks for the number.
  if (ctx.offHours && ctx.state === "NEW") {
    const reply =
      ctx.offHoursMessage?.trim()
        ? ctx.offHoursMessage.trim()
        : pickTemplate("off_hours", { lang, avoid: ctx.lastBotMessage });
    return {
      ...base,
      reply,
      state: "CONTACT",
      botMessageCount: ctx.botMessageCount + 1,
      phoneAskCount: ctx.phoneAskCount + 1,
      lead: null,
      intent,
      usedTemplate: true,
      llmFailed: call.failed && !ctx.templateOnly,
    };
  }

  // Looks like a number but is not valid: say so politely (counts as an ask).
  if (asksPhone && looksLikeBrokenPhone(ctx.customerText)) {
    return {
      ...base,
      reply: pickTemplate("bad_phone", { lang, avoid: ctx.lastBotMessage }),
      state: "CONTACT",
      botMessageCount: ctx.botMessageCount + 1,
      phoneAskCount: ctx.phoneAskCount + 1,
      lead: null,
      intent,
      usedTemplate: true,
      llmFailed: call.failed && !ctx.templateOnly,
    };
  }

  // Candidate reply: model text if it passes the post-filter, else a template.
  const templateKey: TemplateKey = complaint || wantsOperator
    ? "complaint"
    : effStage === "NEW"
      ? "new"
      : effStage === "NEED"
        ? "need"
        : lastAsk
          ? "contact_last"
          : collected.name
            ? "contact_name_known"
            : "contact";
  const fromTemplate = () =>
    pickTemplate(templateKey, {
      lang,
      avoid: ctx.lastBotMessage,
      vars: { name: collected.name ?? "" },
    });

  let reply = "";
  let usedTemplate = false;
  if (out) {
    const verdict = filterReply(out.reply, {
      pricePolicy: ctx.profile.pricePolicy,
      knownPrices,
      profileText,
    });
    if (verdict.ok && !isRepeat(verdict.text, ctx.lastBotMessage)) {
      reply = verdict.text;
    } else {
      const reason: BlockReason | "repeat" = verdict.ok ? "repeat" : (verdict.reason as BlockReason);
      events.push({ type: "blocked_reply", payload: { reason, reply: out.reply.slice(0, 300) } });
      reply = fromTemplate();
      usedTemplate = true;
    }
  } else {
    reply = fromTemplate();
    usedTemplate = true;
  }

  // The model answered a stage-CONTACT turn but forgot to ask for contact:
  // append nothing — the next stage instruction will — but make sure the very
  // first CONTACT message is never a bare chit-chat reply.
  const needsContactAsk = asksPhone && !/[?؟]/.test(reply);
  if (needsContactAsk) {
    const ask = pickTemplate(complaint ? "complaint" : collected.name ? "contact_name_known" : "contact", {
      lang,
      vars: { name: collected.name ?? "" },
    });
    reply = ask;
    usedTemplate = true;
  }

  const nextState: ResultState = effStage === "CONTACT" ? "CONTACT" : "NEED";
  return {
    ...base,
    reply,
    state: nextState,
    botMessageCount: ctx.botMessageCount + 1,
    phoneAskCount: ctx.phoneAskCount + (asksPhone ? 1 : 0),
    lead: null,
    intent,
    unknownQuestion: usedTemplate && !out ? null : (out?.unknown_question ?? null),
    usedTemplate,
    llmFailed: call.failed && !ctx.templateOnly,
  };
}

function finishFallback(
  ctx: TurnContext,
  base: Omit<TurnResult, "reply" | "state" | "lead">,
  lang: Lang,
  out?: LlmOutput | null
): TurnResult {
  const reply = pickTemplate("fallback_final", { lang, avoid: ctx.lastBotMessage });
  const complaint = base.collected.flag === "complaint";
  return {
    ...base,
    reply,
    state: "HANDED_OFF",
    botMessageCount: ctx.botMessageCount + 1,
    lead: ctx.fallbackLeadWithoutPhone
      ? {
          flag: complaint ? "complaint" : "no_phone",
          summary:
            out?.summary ??
            (base.collected.product_interest
              ? `Mijoz ${base.collected.product_interest} haqida so'radi, raqam bermadi.`
              : "Mijoz raqam bermadi — Instagram'da yozing."),
        }
      : null,
    usedTemplate: true,
  };
}
