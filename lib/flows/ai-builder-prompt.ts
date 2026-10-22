/**
 * ETAP 7 — AI Flow Builder prompt contract (analysis §3.2), pure part.
 *
 *   buildFlowBuilderPrompt({ request, ... }) → { system, user, jsonSchema, schemaName }
 *   parseGraphFromLlm(text)                 → { graph, name, summary, warnings } | { error, hints }
 *   buildRepairPrompt(previous, errors)     → the follow-up user message
 *
 * The LLM call itself (provider, budget, usage row, repair round) lives in
 * lib/flows/ai-builder.ts (later, DB-aware). This module never calls a model.
 * The output contract is `{ name, summary, graph }`; `jsonSchema` is the
 * provider schema in the LlmRequest.schema shape (lib/assistant/llm/provider).
 */

import { BUILT_IN_INTENTS } from "@/lib/triggers/keywords";
import { FLOW_CONDITION_FIELDS, FLOW_OPERATORS } from "./conditions";
import {
  FLOW_LIMITS,
  FLOW_NODE_TYPES,
  FLOW_TRIGGER_TYPES,
  type FlowGraph,
  type FlowTriggerType,
  flowGraphSchema,
  formatIssues,
  templateFields,
} from "./schema";
import { FLOW_STARTER_TEMPLATES } from "./templates";
import { VARIABLE_SPECS, validateTemplateKeys } from "./variables";

export const FLOW_BUILDER_SCHEMA_NAME = "flow_graph";

export interface FlowBuilderPromptInput {
  /** The merchant's request (uz / ru). */
  request: string;
  triggerType?: FlowTriggerType;
  /** Business name / short profile line. */
  brand?: string;
  /** Knowledge-base lines the model may quote (prices, address, hours). Nothing else may be invented. */
  kb?: string[];
  /** Existing tag slugs / CRM stages the graph may reference. */
  tags?: string[];
  stages?: Array<{ id: string; name: string }>;
  javobAiLive?: boolean;
  /** Default uz. */
  language?: "uz" | "ru";
}

export interface FlowBuilderPrompt {
  system: string;
  user: string;
  jsonSchema: Record<string, unknown>;
  schemaName: string;
}

// ─── JSON schema (hand-written, like JAVOBAI_JSON_SCHEMA) ─────────────────────

const edgeSchema = {
  type: "object",
  properties: {
    from: { type: "string" },
    to: { type: "string" },
    handle: { type: "string", description: "next | tap | tap:<buttonId> | other | timeout | branch:<id> | else | missing | error | window_closed | fallback" },
  },
  required: ["from", "to", "handle"],
};

export const FLOW_GRAPH_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    v: { type: "integer", enum: [1] },
    nodes: {
      type: "array",
      minItems: 2,
      maxItems: FLOW_LIMITS.nodes,
      items: {
        type: "object",
        properties: {
          id: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" },
          type: { type: "string", enum: [...FLOW_NODE_TYPES] },
        },
        required: ["id", "type"],
        additionalProperties: true,
      },
    },
    edges: { type: "array", maxItems: FLOW_LIMITS.edges, items: edgeSchema },
    variables: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$" },
          label: { type: "string" },
          kind: { type: "string", enum: ["string", "number", "boolean", "phone", "email"] },
        },
        required: ["key", "label", "kind"],
      },
    },
  },
  required: ["v", "nodes", "edges", "variables"],
};

export const FLOW_BUILDER_JSON_SCHEMA: Record<string, unknown> = {
  type: "object",
  properties: {
    name: { type: "string", description: "Oqim nomi, 3-6 so'z, o'zbek lotin" },
    summary: { type: "string", description: "Oqim nima qilishi, 1-2 jumla" },
    graph: FLOW_GRAPH_JSON_SCHEMA,
  },
  required: ["name", "summary", "graph"],
};

// ─── System prompt ────────────────────────────────────────────────────────────

const NODE_CATALOGUE = `BLOKLAR (type → maydonlar → chiqishlar):
- trigger: triggerType (${FLOW_TRIGGER_TYPES.join(" | ")}), matchingMode (EVERY | CONTAINS | EXACT), keywords[], intents[] (${BUILT_IN_INTENTS.map((i) => i.key).join(", ")}), audience (ANY | NEW_CONTACT | RETURNING_CONTACT | REOPENED), sourceFilter (ANY | ADS | LINK), cooldownHours, publicReply (faqat COMMENT, ≤ ${FLOW_LIMITS.publicReplyLength}) → next
- message: text (≤ ${FLOW_LIMITS.messageLength}), button? { id, label ≤ ${FLOW_LIMITS.buttonLabelLength} } (tugmali xabar matni ≤ ${FLOW_LIMITS.buttonTemplateTextLength}) → next (tugmasiz) YOKI tap (tugmali; next taqiqlanadi)
- button: text, buttons[1..${FLOW_LIMITS.quickReplies}] { id, label ≤ ${FLOW_LIMITS.buttonLabelLength}, kind (text | phone | email), saveAs? } , timeoutMinutes? → tap:<id> har bir tugma uchun, other (yozib yuborsa), timeout? (timeoutMinutes bo'lsa)
- ai: mode takeover { intro? } → chiqishsiz, ixtiyoriy fallback (JavobAI LIVE bo'lmasa) | mode ask { question, saveAs, extract (phone | email | name | city | product | free_text | yes_no | number), retries, retryText? } → next, missing
- condition: branches[] { id, label, when: { v: 1, all: [{ field, op, value }], any?: [...] } } → branch:<id> har biri uchun, else. field: ${FLOW_CONDITION_FIELDS.join(", ")}, vars.<key>; op: ${FLOW_OPERATORS.join(" | ")}
- delay: minutes (1..${FLOW_LIMITS.delayMaxMinutes}), ifWindowClosed (end | skip_sends | wait_for_inbound), cancelOnReply → next, window_closed?
- tag: action (add | remove), tagSlugs[] → next
- lead: phoneFrom ("vars.phone"), summary?, thanks? → next, missing (telefon bo'lmasa)
- webhook: url (faqat https, ochiq internet), body {k: shablon}, saveAs?, savePath? → next, error?
- crm: action (move_stage {stageId} | create_deal | assign {assignStrategy} | set_field {field, value}) → next, error?
- operator: reply?, note?, reason (wants_human | complaint | purchase_ready | flow_rule) → chiqishsiz, ixtiyoriy next
- action: action (set_variable {key, value} | increment {key} | notify_telegram {text} | opt_out | stop_followups | mark_test) → next
- end: reason? → chiqishsiz`;

const RULES = `QOIDALAR:
1. Aynan bitta trigger. Har blok id noyob: kichik lotin harf, raqam, _ (masalan m1, b1, lead).
2. Har bir majburiy chiqish bog'lanadi (edges: { from, to, handle }). Bir chiqish — bitta bog'lanish. Tugamaydigan yo'l bo'lmasin: oxiri end, operator yoki ai takeover.
3. COMMENT / LIVE_COMMENT trigger: birinchi blok tugmali message (private reply, matn ≤ ${FLOW_LIMITS.buttonTemplateTextLength}); tugma bosilguncha (tap) boshqa hech narsa yuborilmaydi — button / ai / lead / delay faqat tap'dan keyin.
4. DIRECT_MESSAGE / STORY_MENTION: oyna ochiq, darhol message yoki button mumkin.
5. Ketma-ket ko'pi bilan 3 ta xabar, orasiga tugma yoki savol. 24 soatdan uzun kutishdan keyin xabar yuborilmaydi.
6. Telefon so'rash: button { kind: "phone", saveAs: "phone" } yoki ai ask { extract: "phone", saveAs: "phone" }, keyin lead { phoneFrom: "vars.phone" }.
7. Shablonlar: {{name}}, {{username}}, {{product}}, {{vars.<key>|zaxira}}, ${VARIABLE_SPECS.map((v) => `{{${v.key}}}`).slice(0, 8).join(", ")}. vars.<key> ishlatilsa variables[] da e'lon qiling yoki uni saqlaydigan blok bo'lsin.
8. Narx, manzil, ish vaqti, havola, telefon raqami — faqat berilgan ma'lumotlar blokidan. Berilmagan bo'lsa {{vars.price|menejer aytadi}} kabi zaxirali shablon yozing; HECH QACHON narx yoki faktni o'ylab topmang.
9. Matnlar o'zbek lotin (mijoz tiliga mos), qisqa, samimiy, 1-2 emoji mumkin. Tugma nomi ≤ ${FLOW_LIMITS.buttonLabelLength} belgi.
10. Faqat JSON qaytaring: { "name", "summary", "graph": { "v": 1, "nodes": [...], "edges": [...], "variables": [...] } }. layout kerak emas.`;

function compactGraph(graph: FlowGraph): string {
  const { layout: _layout, ...rest } = graph;
  void _layout;
  return JSON.stringify(rest);
}

/** Two few-shot examples from the starters: a comment flow (window rule) and a DM flow with a condition. */
export function fewShotExamples(): Array<{ title: string; json: string }> {
  const t5 = FLOW_STARTER_TEMPLATES.find((t) => t.key === "giveaway_confirm");
  const t3 = FLOW_STARTER_TEMPLATES.find((t) => t.key === "ad_qualify_crm");
  return [t5, t3]
    .filter((t): t is NonNullable<typeof t> => !!t)
    .map((t) => ({ title: t.name, json: JSON.stringify({ name: t.name, summary: t.description, graph: JSON.parse(compactGraph(t.graph)) }) }));
}

export function buildFlowBuilderSystemPrompt(): string {
  const examples = fewShotExamples()
    .map((e, i) => `MISOL ${i + 1} (${e.title}):\n${e.json}`)
    .join("\n\n");
  return [
    "Siz SocialAuto Flow Builder yordamchisisiz: Instagram avtomatlashtirish oqimini (graf) JSON ko'rinishida tuzasiz.",
    NODE_CATALOGUE,
    RULES,
    examples,
  ].join("\n\n");
}

export function buildFlowBuilderPrompt(input: FlowBuilderPromptInput): FlowBuilderPrompt {
  const lines: string[] = [];
  if (input.brand) lines.push(`Biznes: ${input.brand}`);
  if (input.triggerType) lines.push(`Trigger turi: ${input.triggerType}`);
  lines.push(`JavobAI: ${input.javobAiLive ? "LIVE (ai takeover ishlatish mumkin)" : "LIVE emas (ai takeover bo'lsa fallback → operator)"}`);
  if (input.tags?.length) lines.push(`Mavjud teglar: ${input.tags.join(", ")}`);
  if (input.stages?.length) lines.push(`CRM bosqichlari: ${input.stages.map((s) => `${s.name} (stageId: ${s.id})`).join(", ")}`);
  if (input.kb?.length) lines.push(`MA'LUMOTLAR (faqat shulardan foydalaning):\n${input.kb.map((l) => `- ${l}`).join("\n")}`);
  else lines.push("MA'LUMOTLAR: berilmagan — narx / manzil / vaqtni o'ylab topmang, zaxirali shablon yozing.");
  lines.push(`Til: ${input.language === "ru" ? "rus" : "o'zbek lotin"}`);
  lines.push(`SO'ROV:\n${input.request.trim()}`);
  return {
    system: buildFlowBuilderSystemPrompt(),
    user: lines.join("\n"),
    jsonSchema: FLOW_BUILDER_JSON_SCHEMA,
    schemaName: FLOW_BUILDER_SCHEMA_NAME,
  };
}

// ─── Parsing ──────────────────────────────────────────────────────────────────

export interface ParsedFlowFromLlm {
  graph: FlowGraph;
  name: string | null;
  summary: string | null;
  /** Non-fatal: unknown template keys and the like (the auditor repeats them). */
  warnings: string[];
}

export interface FlowParseFailure {
  error: "empty" | "not_json" | "invalid_graph";
  /** Uzbek, one per problem — fed back through buildRepairPrompt. */
  hints: string[];
}

function stripFences(text: string): string {
  return text
    .trim()
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/```\s*$/i, "")
    .trim();
}

function tolerantJsonParse(text: string): unknown | undefined {
  try {
    return JSON.parse(text);
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) return undefined;
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

/** `[from, to, handle?]` triples (the analysis shorthand) → edge objects; defaults `handle` to "next". */
function normaliseEdges(edges: unknown): unknown {
  if (!Array.isArray(edges)) return edges;
  return edges.map((edge) => {
    if (Array.isArray(edge)) return { from: edge[0], to: edge[1], handle: edge[2] ?? "next" };
    if (edge && typeof edge === "object" && !("handle" in edge)) return { ...(edge as object), handle: "next" };
    return edge;
  });
}

function hintsFromIssues(issues: string[], raw: Record<string, unknown>): string[] {
  const hints = new Set<string>();
  const nodes = Array.isArray(raw.nodes) ? (raw.nodes as Array<Record<string, unknown>>) : [];
  if (!nodes.some((n) => n?.type === "trigger")) hints.add("Trigger bloki yo'q: nodes[] ga { type: \"trigger\", triggerType, ... } qo'shing");
  for (const issue of issues) {
    if (/chiqishi yo'q/.test(issue)) hints.add(`Noma'lum chiqish (handle): ${issue}. Ruxsat etilgan: next, tap, tap:<id>, other, timeout, branch:<id>, else, missing, error, window_closed, fallback`);
    else if (/bog'lanmagan/.test(issue)) hints.add(`Majburiy chiqish bog'lanmagan: ${issue}`);
    else if (/oyna/.test(issue)) hints.add(`24 soatlik oyna qoidasi: ${issue}`);
    else if (/Invalid discriminator|invalid_union|Invalid input: expected/i.test(issue) && /type/.test(issue)) hints.add(`Noma'lum blok turi: ${issue}. Ruxsat etilgan: ${FLOW_NODE_TYPES.join(", ")}`);
    else hints.add(issue);
  }
  return [...hints];
}

// ─── Deterministic repair: the comment 24h-window rule ────────────────────────

type RawNode = Record<string, unknown> & { id?: unknown; type?: unknown };
type RawEdge = { from?: unknown; to?: unknown; handle?: unknown };
type RawGraph = Record<string, unknown> & { nodes?: unknown; edges?: unknown };

const OPEN_BUTTON_LABEL = "Davom etish";
const OPEN_MESSAGE_TEXT = "Salom! Davom etish uchun tugmani bosing 👇";
const PASS_THROUGH_TYPES = new Set(["tag", "crm", "action", "webhook"]);
const WINDOW_TYPES = new Set(["button", "ai", "lead", "delay"]);

function freshId(nodes: RawNode[], base: string): string {
  const used = new Set(nodes.map((n) => String(n.id ?? "")));
  if (!used.has(base)) return base;
  for (let i = 2; i < 100; i += 1) if (!used.has(`${base}${i}`)) return `${base}${i}`;
  return `${base}_${Date.now().toString(36)}`;
}

/**
 * Models keep sending a quick-reply block, an ai question or a second message
 * straight after a COMMENT trigger — forbidden, because the 24h window only
 * opens when the private reply's button is tapped. Rather than spend a repair
 * round on it, rewrite the start of the graph: the first send becomes (or is
 * preceded by) a message with an opening button, and the rest hangs off its
 * `tap`. Pure, defensive on raw input; returns the fixes made (Uzbek, for the
 * warnings list) so the merchant knows what to review.
 */
export function repairCommentOpening(graph: RawGraph): { graph: RawGraph; fixes: string[] } {
  const fixes: string[] = [];
  if (!Array.isArray(graph.nodes) || !Array.isArray(graph.edges)) return { graph, fixes };
  const nodes = (graph.nodes as unknown[]).map((n) => (n && typeof n === "object" ? { ...(n as RawNode) } : n)) as RawNode[];
  const edges = (graph.edges as unknown[]).map((e) => (e && typeof e === "object" ? { ...(e as RawEdge) } : e)) as RawEdge[];
  const trigger = nodes.find((n) => n?.type === "trigger");
  if (!trigger || (trigger.triggerType !== "COMMENT" && trigger.triggerType !== "LIVE_COMMENT")) return { graph, fixes };

  const byId = new Map<string, RawNode>();
  for (const n of nodes) if (n && typeof n.id === "string") byId.set(n.id, n);
  const outOf = (id: string, handle: string) => edges.find((e) => e.from === id && e.handle === handle);

  // Walk trigger → (pass-through blocks) → the first block that sends or needs the window.
  let incoming = outOf(String(trigger.id), "next");
  let first = incoming ? byId.get(String(incoming.to)) : undefined;
  const seen = new Set<string>();
  while (first && PASS_THROUGH_TYPES.has(String(first.type)) && !seen.has(String(first.id))) {
    seen.add(String(first.id));
    incoming = outOf(String(first.id), "next");
    first = incoming ? byId.get(String(incoming.to)) : undefined;
  }
  if (!first || !incoming) return { graph, fixes };
  const id = String(first.id);
  const label = (s: unknown) => (typeof s === "string" && s.trim() ? s.trim().slice(0, FLOW_LIMITS.buttonLabelLength) : OPEN_BUTTON_LABEL);

  const insertOpener = (text: string, buttonLabel: string, note: string) => {
    const openerId = freshId(nodes, "m_open");
    nodes.splice(nodes.indexOf(first!), 0, { id: openerId, type: "message", text, button: { id: "open", label: buttonLabel } });
    incoming!.to = openerId;
    edges.push({ from: openerId, to: id, handle: "tap" });
    fixes.push(`AI oqimi avtomatik tuzatildi: «${id}» oldiga «${openerId}» ochuvchi tugmali xabar qo'shildi — ${note}`);
  };

  if (first.type === "message") {
    const next = outOf(id, "next");
    if (first.button && typeof first.button === "object") {
      if (next && !outOf(id, "tap")) {
        next.handle = "tap";
        fixes.push(`AI oqimi avtomatik tuzatildi: «${id}» tugmali xabardan keyingi chiqish "tap" qilindi (tugma bosilguncha davom etilmaydi)`);
      }
    } else if (next) {
      first.button = { id: "open", label: OPEN_BUTTON_LABEL };
      next.handle = "tap";
      fixes.push(`AI oqimi avtomatik tuzatildi: «${id}» xabariga «${OPEN_BUTTON_LABEL}» tugmasi qo'shildi — komment oqimida keyingi xabarlar faqat tugma bosilgach yuboriladi; tugma nomini o'zgartiring`);
    }
  } else if (first.type === "button") {
    const buttons = Array.isArray(first.buttons) ? (first.buttons as RawNode[]) : [];
    const only = buttons.length === 1 ? buttons[0] : undefined;
    const plain = only && (only.kind === undefined || only.kind === "text") && !only.saveAs && !first.timeoutMinutes;
    if (only && plain) {
      const tapEdge = outOf(id, `tap:${String(only.id)}`);
      for (let i = edges.length - 1; i >= 0; i -= 1) if (edges[i].from === id && edges[i] !== tapEdge) edges.splice(i, 1);
      if (tapEdge) tapEdge.handle = "tap";
      first.type = "message";
      first.button = { id: typeof only.id === "string" ? only.id : "open", label: label(only.label) };
      delete first.buttons;
      delete first.onText;
      delete first.timeoutMinutes;
      fixes.push(`AI oqimi avtomatik tuzatildi: «${id}» tugmalar bloki ochuvchi tugmali xabarga aylantirildi (komment oqimi qoidasi)`);
    } else {
      insertOpener(typeof first.text === "string" && first.text.trim() ? first.text : OPEN_MESSAGE_TEXT, OPEN_BUTTON_LABEL, "komment oqimida tugmalar faqat oyna ochilgach ishlaydi; matnini tekshiring");
    }
  } else if (WINDOW_TYPES.has(String(first.type))) {
    insertOpener(OPEN_MESSAGE_TEXT, OPEN_BUTTON_LABEL, "bu blok oyna ochilmasdan ishlamaydi; ochuvchi xabar matnini o'zingiz yozing");
  }

  return { graph: fixes.length ? { ...graph, nodes, edges } : graph, fixes };
}

/** Everything a model might return: raw text (fenced or not), a JSON string, or the parsed object. */
export function parseGraphFromLlm(raw: unknown): ParsedFlowFromLlm | FlowParseFailure {
  let value: unknown = raw;
  if (typeof raw === "string") {
    const text = stripFences(raw);
    if (!text) return { error: "empty", hints: ["Javob bo'sh — faqat JSON qaytaring"] };
    value = tolerantJsonParse(text);
    if (value === undefined) return { error: "not_json", hints: ["Javob JSON emas — code fence'siz, izohsiz, faqat { \"name\", \"summary\", \"graph\" } obyektini qaytaring"] };
  }
  if (!value || typeof value !== "object") return { error: "not_json", hints: ["JSON obyekt kutilgan edi"] };
  const wrapper = value as Record<string, unknown>;
  const rawGraph = (wrapper.graph && typeof wrapper.graph === "object" ? wrapper.graph : wrapper) as Record<string, unknown>;
  const repaired = repairCommentOpening({ v: 1, variables: [], ...rawGraph, edges: normaliseEdges(rawGraph.edges ?? []) });
  const candidate = repaired.graph;
  const parsed = flowGraphSchema.safeParse(candidate);
  if (!parsed.success) {
    return { error: "invalid_graph", hints: hintsFromIssues(formatIssues(parsed.error), candidate) };
  }
  const graph = parsed.data;
  const warnings: string[] = [...repaired.fixes];
  const declared = new Set(graph.variables.map((v) => v.key));
  for (const node of graph.nodes) {
    if (node.type === "button") node.buttons.forEach((b) => b.saveAs && declared.add(b.saveAs));
    if (node.type === "ai" && node.saveAs) declared.add(node.saveAs);
    if (node.type === "webhook" && node.saveAs) declared.add(node.saveAs);
    if (node.type === "action" && node.key) declared.add(node.key);
  }
  for (const node of graph.nodes) {
    for (const { field, text } of templateFields(node)) {
      for (const key of validateTemplateKeys(text, declared)) {
        warnings.push(`«${node.id}» ${field}: {{${key}}} o'zgaruvchisi e'lon qilinmagan — variables[] ga qo'shing yoki uni saqlaydigan blok qo'ying`);
      }
    }
  }
  return {
    graph,
    name: typeof wrapper.name === "string" && wrapper.name.trim() ? wrapper.name.trim().slice(0, 120) : null,
    summary: typeof wrapper.summary === "string" && wrapper.summary.trim() ? wrapper.summary.trim().slice(0, 500) : null,
    warnings,
  };
}

export function isFlowParseFailure(result: ParsedFlowFromLlm | FlowParseFailure): result is FlowParseFailure {
  return "error" in result;
}

/** The second-round user message: same JSON, these problems fixed. */
export function buildRepairPrompt(previous: string, errors: string[]): string {
  const list = errors.slice(0, 30).map((e, i) => `${i + 1}. ${e}`);
  return [
    "Oldingi javobingiz tekshiruvdan o'tmadi. Quyidagi xatolarni tuzating va XUDDI SHU formatda to'liq JSON qaytaring (faqat JSON, izohsiz):",
    ...list,
    "",
    "OLDINGI JAVOB:",
    stripFences(previous).slice(0, 20_000),
  ].join("\n");
}
