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
  "mana", "raqam", "raqamim", "nomer", "nomerim", "telefon", "вот", "номер", "мой",
]);

function words(text: string): string[] {
  return text.toLowerCase().match(/[\p{L}\p{N}'ʻ‘’]{3,}/gu) ?? [];
}

/**
 * The category or product the customer's words point at ("web site kerak" ->
 * "Web site"), matching every word of the catalog name by its first letters
 * so "ilova" still finds "Mobil ilovalar". Used when the LLM is unavailable,
 * so a product the customer names is neither lost nor taken for their name.
 */
export function catalogMatch(profile: ProfileSnapshot, text: string): string | null {
  const said = words(text);
  if (said.length === 0) return null;
  const names = [...profile.categories.map((c) => c.name), ...profile.products.map((p) => p.name)];
  const bare = (w: string) => w.replace(/['ʻ‘’]/g, "");
  for (const name of names) {
    const parts = words(name);
    if (parts.length === 0) continue;
    const hit = parts.every((part) => {
      const stem = part.slice(0, Math.min(part.length, 4));
      return said.some((w) => w.startsWith(stem));
    });
    // "website" for "Web site": the name written as one word.
    const joined = bare(parts.join(""));
    const joinedHit =
      parts.length > 1 && said.some((w) => bare(w).startsWith(joined.slice(0, Math.min(joined.length, 6))));
    if (hit || joinedHit) return name.trim();
  }
  return null;
}

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
  ctx: Pick<TurnContext, "llm" | "profile" | "customerText" | "history">,
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

/** Facts the post-filter checks a reply against (prices, owner-written URLs). */
function filterContextFor(profile: ProfileSnapshot) {
  return {
    pricePolicy: profile.pricePolicy,
    knownPrices: profile.products
      .filter((p) => p.price !== null)
      .map((p) => ({ amount: p.price as number, currency: p.currency })),
    profileText: [
      profile.description,
      profile.address ?? "",
      profile.delivery ?? "",
      ...profile.faqs.map((f) => `${f.question} ${f.answer}`),
    ].join(" "),
  };
}

/** Replies the bot may still send after the number was taken, per conversation. */
export const MAX_POST_HANDOFF_REPLIES = 3;

const POST_HANDOFF_STEP =
  "Mijoz telefon raqamini allaqachon qoldirgan, suhbat menejerga topshirilgan. " +
  "Raqam yoki ism SO'RAMA. Mijozning yangi xabarini o'qi: savoli bo'lsa, faqat " +
  "KOMPANIYA MA'LUMOTI asosida 1 gapda qisqa javob ber (bilmasang, o'ylab topma). " +
  "Javobni har doim to'liqroq ma'lumotni menejerimiz beradi degan mazmun bilan tugat.";

export interface PostHandoffResult {
  reply: string;
  usedTemplate: boolean;
  llmFailed: boolean;
  unknownQuestion: string | null;
  usages: TurnUsage[];
  events: TurnEvent[];
}

/**
 * The customer wrote again after leaving their number. Answer what they asked
 * from the company info and point to the manager for the full details; never
 * ask for contact again. Falls back to the plain "manager will reply" line.
 */
export async function runPostHandoffTurn(
  ctx: Pick<TurnContext, "profile" | "collected" | "history" | "customerText" | "lastBotMessage" | "templateOnly" | "llm">
): Promise<PostHandoffResult> {
  const lang = detectLanguage(ctx.customerText, normalizeLang(ctx.collected.language, "uz_latn"));
  const fallback = (): string => pickTemplate("after_handoff", { lang });

  if (ctx.templateOnly || !ctx.llm || !ctx.customerText.trim()) {
    return {
      reply: fallback(),
      usedTemplate: true,
      llmFailed: !ctx.templateOnly && !ctx.llm,
      unknownQuestion: null,
      usages: [],
      events: [],
    };
  }

  const call = await callLlm(ctx, "CONTACT", POST_HANDOFF_STEP);
  const events = [...call.events];
  if (!call.output) {
    return { reply: fallback(), usedTemplate: true, llmFailed: call.failed, unknownQuestion: null, usages: call.usages, events };
  }
  const verdict = filterReply(call.output.reply, filterContextFor(ctx.profile));
  if (!verdict.ok || isRepeat(verdict.text, ctx.lastBotMessage)) {
    events.push({
      type: "blocked_reply",
      payload: { reason: verdict.ok ? "repeat" : verdict.reason, reply: call.output.reply.slice(0, 300), postHandoff: true },
    });
    return { reply: fallback(), usedTemplate: true, llmFailed: false, unknownQuestion: null, usages: call.usages, events };
  }
  return {
    reply: verdict.text,
    usedTemplate: false,
    llmFailed: false,
    unknownQuestion: call.output.unknown_question ?? null,
    usages: call.usages,
    events,
  };
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
  const { knownPrices, profileText } = filterContextFor(ctx.profile);

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
  // Without the LLM (template mode) the catalog is the only way to tell a
  // product ("web site") from a name.
  const mentioned = out ? null : catalogMatch(ctx.profile, ctx.customerText);
  const extractedName = sanitizeName(out?.extracted.name);
  if (extractedName) collected.name = extractedName;
  else if (phone && (!collected.name || !out)) {
    // A name written next to the number is the customer's own answer, so in
    // template mode it also replaces an earlier guess.
    const nameWithPhone = mentioned ? null : nameFromRemainder(ctx.customerText);
    if (nameWithPhone) collected.name = nameWithPhone;
  } else if (!phone && stage === "CONTACT" && !collected.name && !out && !mentioned) {
    collected.name = nameFromRemainder(ctx.customerText);
  }
  if (out?.extracted.product_interest) collected.product_interest = out.extracted.product_interest;
  else if (mentioned && !collected.product_interest) collected.product_interest = mentioned;
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
