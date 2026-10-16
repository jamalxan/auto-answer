/**
 * ETAP 11 — pure analyser of a pasted ManyChat flow description (no database,
 * no model). It looks for ManyChat vocabulary in uz / ru / en with the feature
 * catalogue and answers:
 *
 *   triggers     how the flow starts (kind = catalogue key, detail = the line)
 *   nodes        which step kinds appear and how often
 *   unsupported  UNSUPPORTED / PARTIAL features found (channels included)
 *   notes        general observations (info / warning)
 *   language     the language of the text
 *
 * The result is a HINT for the AI converter and a warning list for the owner;
 * it never decides what is imported.
 */

import { catalogEntry, defaultSeverity, FEATURE_CATALOG, type Finding, normalizeText } from "./catalog";

export interface AnalyzedTrigger {
  kind: string;
  detail: string;
}

export interface AnalyzedNode {
  kind: string;
  count: number;
}

export type FlowLanguage = "uz" | "ru" | "en" | "mixed";

export interface FlowAnalysis {
  triggers: AnalyzedTrigger[];
  nodes: AnalyzedNode[];
  unsupported: Finding[];
  notes: Finding[];
  language: FlowLanguage;
}

const MAX_DETAIL = 100;

function countMatches(patterns: readonly RegExp[], text: string): { count: number; first: RegExp | null; index: number } {
  let count = 0;
  let index = -1;
  let first: RegExp | null = null;
  for (const pattern of patterns) {
    for (const match of text.matchAll(pattern)) {
      count += 1;
      if (index === -1 || (match.index ?? 0) < index) {
        index = match.index ?? 0;
        first = pattern;
      }
    }
  }
  return { count, first, index };
}

/** The line around `index`, trimmed and capped. */
function lineAt(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const endRaw = text.indexOf("\n", index);
  const line = text.slice(start, endRaw === -1 ? undefined : endRaw).replace(/\s+/g, " ").trim();
  return line.length > MAX_DETAIL ? `${line.slice(0, MAX_DETAIL - 1)}…` : line;
}

const QUOTED = /["«“„]([^"»”“]{1,40})["»”]/gu;

/** Words in double quotes / «guillemets» on lines that talk about keywords or comments. */
export function extractKeywords(text: string): string[] {
  const normalized = normalizeText(text);
  const entry = catalogEntry("trigger_keyword");
  const out: string[] = [];
  for (const line of normalized.split("\n")) {
    const hasVocabulary = (entry?.patterns ?? []).some((p) => [...line.matchAll(p)].length > 0);
    if (!hasVocabulary) continue;
    for (const match of line.matchAll(QUOTED)) {
      const word = match[1].trim();
      if (word && !out.some((w) => w.toLowerCase() === word.toLowerCase())) out.push(word);
    }
  }
  return out.slice(0, 20);
}

// ─── Language ─────────────────────────────────────────────────────────────────

const UZ_MARKERS = /\b(?:salom|xabar|tugma|yubor\w*|narx|qo'sh\w*|kerak|bo'lsa|agar|mijoz|rahmat|buyurtma|so'ra\w*|kalit|yoz\w*|keyin|daqiqa|soat|bering|bosilsa|teg)\b|o'|g'/giu;
const RU_MARKERS = /(?:сообщени|кнопк|если|отправ|клиент|спасибо|привет|заказ|через|минут|добав|пользовател|ответ)/giu;
const EN_MARKERS = /\b(?:the|send|message|button|when|then|if|user|add|tag|wait|reply|comment|flow|step|after|minutes?|hours?)\b/giu;

export function detectLanguage(text: string): FlowLanguage {
  const normalized = normalizeText(text);
  const uz = [...normalized.matchAll(UZ_MARKERS)].length + [...normalized.matchAll(/[ўқғҳ]/giu)].length;
  const ru = [...normalized.matchAll(RU_MARKERS)].length;
  const en = [...normalized.matchAll(EN_MARKERS)].length;
  const total = uz + ru + en;
  if (total === 0) return /[а-яё]/iu.test(normalized) ? "ru" : "uz";
  const top = Math.max(uz, ru, en);
  // One language carries at least 70% of the evidence, otherwise it is a mix.
  if (top / total < 0.7) return "mixed";
  return top === uz ? "uz" : top === ru ? "ru" : "en";
}

// ─── Analysis ─────────────────────────────────────────────────────────────────

export function analyzeFlowText(rawText: string): FlowAnalysis {
  const text = normalizeText(rawText ?? "");
  const triggers: AnalyzedTrigger[] = [];
  const nodes: AnalyzedNode[] = [];
  const unsupported: Finding[] = [];
  const notes: Finding[] = [];

  for (const entry of FEATURE_CATALOG) {
    const { count, index } = countMatches(entry.patterns, text);
    if (count === 0) continue;

    if (entry.category === "trigger") {
      let detail = lineAt(text, index);
      if (entry.key === "trigger_keyword" || entry.key === "trigger_comment") {
        const words = extractKeywords(text);
        if (words.length > 0) detail = `Kalit so'zlar: ${words.join(", ")}`;
      }
      triggers.push({ kind: entry.key, detail });
    } else if (entry.category === "node") {
      nodes.push({ kind: entry.key, count });
    }

    if (entry.status !== "SUPPORTED") {
      unsupported.push({
        code: entry.key,
        severity: entry.severity ?? defaultSeverity(entry.status),
        message: entry.message,
        suggestion: entry.suggestion,
        feature: entry.key,
        count,
      });
    }
  }

  const hasFlowTrigger = triggers.some((t) => t.kind !== "trigger_story_reply");
  if (text.trim().length > 0 && !hasFlowTrigger) {
    notes.push({
      code: "no_trigger",
      severity: "warning",
      message: "Matndan oqim triggeri aniqlanmadi (komment, kalit so'z, story mention...).",
      suggestion: "Konvertatsiya vaqtida trigger turini qo'lda tanlang yoki matnga «Trigger: kalit so'z NARX» kabi satr qo'shing.",
    });
  }
  if (triggers.some((t) => t.kind === "trigger_comment")) {
    notes.push({
      code: "comment_window",
      severity: "info",
      message: "Komment triggerida birinchi xabar tugmali private reply bo'ladi; qolgan qadamlar tugma bosilgandan keyin yuboriladi.",
    });
  }
  if (triggers.filter((t) => t.kind !== "trigger_story_reply").length > 1) {
    notes.push({
      code: "multiple_triggers",
      severity: "warning",
      message: "Matnda bir nechta trigger turi bor, lekin bitta oqimda faqat bitta trigger bo'ladi.",
      suggestion: "Har bir trigger uchun alohida oqim yarating yoki konvertatsiyada birini tanlang.",
    });
  }
  if (nodes.length === 0 && text.trim().length > 0) {
    notes.push({ code: "no_nodes", severity: "warning", message: "Matndan oqim qadamlari (xabar, tugma, kechiktirish...) aniq ko'rinmadi — AI faqat taxmin qila oladi." });
  }

  return { triggers, nodes, unsupported, notes, language: detectLanguage(text) };
}

/** A flow trigger type suggested by the analysis, or undefined when it is unclear. */
export function suggestTriggerType(analysis: FlowAnalysis): "COMMENT" | "DIRECT_MESSAGE" | "STORY_MENTION" | undefined {
  const kinds = new Set(analysis.triggers.map((t) => t.kind));
  if (kinds.has("trigger_comment")) return "COMMENT";
  if (kinds.has("trigger_story_mention")) return "STORY_MENTION";
  if (kinds.has("trigger_keyword") || kinds.has("trigger_default_reply") || kinds.has("trigger_ref") || kinds.has("trigger_ads") || kinds.has("trigger_story_reply")) return "DIRECT_MESSAGE";
  return undefined;
}
