/**
 * ETAP 7 — AI Flow Auditor, deterministic part (analysis §4, TZ 40).
 *
 * `auditGraph(graph, ctx)` → { errors, warnings, suggestions } of Findings
 * { code, nodeId?, edgeIndex?, message, fix? } (Uzbek). Rules:
 *
 *   unreachable           node the trigger never reaches               Error
 *   dead_end              required handle with no edge / broken edge   Error
 *   duplicate_action      same tag twice on a path, identical          Warning
 *                         consecutive messages
 *   conflicting_condition branch that can never match                  Warning
 *   missing_delay         ≥ 3 sends in a row with no delay / wait      Warning (2 → suggestion)
 *   spam_risk             > 3 consecutive sends (> 6 error), EVERY     Warning / Error
 *                         trigger with no cooldown
 *   policy_risk           window / limits / delay rules of policy.ts   per verdict
 *   forbidden_content     phone number, foreign URL, blocklist, price  Warning
 *                         under NEVER
 *   incorrect_variable    unknown template key, vars.x never set       Error / Warning
 *   broken_integration    webhook url, crm ids, unknown tags,          Error / Warning
 *                         SPECIFIC media without ids
 *   missing_handoff       ai without handoff / JavobAI not LIVE        Warning
 *   endless_loop          cycle with no wait                           Error
 *   suggestion            readability / sales hints                    Suggestion
 *
 * The LLM-assisted pass (§4.1) is separate and never changes these results.
 * Pure: no database — tags / stages / price policy / JavobAI mode come in
 * through `ctx`.
 */

import { ancestorsOf, buildIndex, consecutiveSendsMax, findBrokenEdges, findCycles, findDeadEnds, findUnreachable, pathsFromTrigger, reachableFrom, variableSetters } from "./graph";
import { evaluatePolicy, type PolicyCode, type PolicyContext, type PolicyItem, SPAM_BLOCKED_SENDS, SPAM_WARNING_SENDS } from "./policy";
import { COMMENT_TRIGGER_TYPES, type FlowGraph, type FlowNode, isSendNode, NODE_LABELS, sendText, templateFields } from "./schema";
import { parseTemplateRefs, validateTemplateKeys, varsKey } from "./variables";

export const AUDIT_CODES = [
  "unreachable",
  "dead_end",
  "duplicate_action",
  "conflicting_condition",
  "missing_delay",
  "spam_risk",
  "policy_risk",
  "forbidden_content",
  "incorrect_variable",
  "broken_integration",
  "missing_handoff",
  "endless_loop",
  "suggestion",
] as const;
export type AuditCode = (typeof AUDIT_CODES)[number];

export interface Finding {
  code: AuditCode;
  nodeId?: string;
  edgeIndex?: number;
  /** Uzbek. */
  message: string;
  /** Uzbek: what to do. */
  fix?: string;
  /** The policy check behind a policy_risk / mapped finding. */
  policyCode?: PolicyCode;
}

export interface AuditResult {
  errors: Finding[];
  warnings: Finding[];
  suggestions: Finding[];
}

export interface AuditContext extends PolicyContext {
  /** Tag slugs that exist in the workspace; undefined = unknown (tag checks skipped). */
  declaredTags?: string[];
  /** CRM stage ids that exist; undefined = unknown. */
  stages?: string[];
  /** URLs / domains the merchant wrote in the profile — allowed in messages. */
  allowedUrls?: string[];
}

// ─── Content heuristics (minimal reimplementation of lib/assistant/post-filter) ──

/** "+998 90 123 45 67", "90-123-45-67", "(90) 123 45 67": ≥ 9 digits in one span. */
const PHONE_CANDIDATE = /(?<![\w.])\+?\(?\d[\d\s().-]{6,}\d(?![\w])/g;
const URL_PATTERN =
  /(https?:\/\/[^\s]+|www\.[^\s]+|\b[a-z0-9-]+\.(?:com|uz|ru|org|net|io|me|tg|ly|info|biz|app)\b[^\s]*|t\.me\/[^\s]+)/gi;
const BLOCKLIST: Array<{ pattern: RegExp; label: string }> = [
  { pattern: /kafolatlangan\s+daromad|гарантированн\w*\s+доход|guaranteed\s+income/iu, label: "kafolatlangan daromad" },
  { pattern: /100\s*%\s*(davolaydi|natija|kafolat|излечивает|гарантия|результат)/iu, label: "100% kafolat / davolash" },
  { pattern: /\b(davolaydi|shifo\s+beradi|излечивает|вылечивает)\b/iu, label: "tibbiy da'vo" },
];

/**
 * Drops `{{key}}` references but KEEPS a `{{key|fallback}}` fallback: when the
 * variable is empty the fallback is what the customer receives, so a foreign
 * URL or phone number in it must be checked like any other message text.
 */
function withoutTemplates(text: string): string {
  return text.replace(/\{\{[^{}|]*(?:\|([^{}]*))?\}\}/g, (_match, fallback: string | undefined) => ` ${fallback ?? ""} `);
}

export function findPhoneNumbers(text: string): string[] {
  return (withoutTemplates(text).match(PHONE_CANDIDATE) ?? []).filter((span) => span.replace(/\D/g, "").length >= 9);
}

export function findUrls(text: string): string[] {
  return (withoutTemplates(text).match(URL_PATTERN) ?? []).map((u) => u.toLowerCase().replace(/[.,;:!?)]+$/, ""));
}

function urlAllowed(url: string, allowed: string[] | undefined): boolean {
  if (!allowed?.length) return false;
  const bare = url.replace(/^https?:\/\//, "").replace(/^www\./, "");
  return allowed.some((a) => {
    const b = a.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "");
    return b && (bare.startsWith(b) || b.startsWith(bare));
  });
}

// ─── Policy mapping ───────────────────────────────────────────────────────────

/** Policy checks the auditor computes itself (not re-reported from policy). */
const OWN_POLICY_CODES: ReadonlySet<PolicyCode> = new Set<PolicyCode>(["unreachable", "dead_end", "endless_loop", "consecutive_sends", "duplicate_text"]);

const POLICY_TO_AUDIT: Partial<Record<PolicyCode, AuditCode>> = {
  price_under_never: "forbidden_content",
  ai_not_live: "missing_handoff",
  ai_no_handoff: "missing_handoff",
  webhook_not_https: "broken_integration",
  webhook_private_host: "broken_integration",
  webhook_host_not_allowed: "broken_integration",
  lead_no_phone_source: "broken_integration",
};

const POLICY_FIX: Partial<Record<PolicyCode, string>> = {
  window_no_opening_button: "Birinchi xabarga tugma qo'shing va davomini uning \"tap\" chiqishiga ulang",
  window_first_not_message: "Triggerdan keyin birinchi bo'lib tugmali xabar blokini qo'ying",
  window_closed_send: "Blokni tugmali xabarning \"tap\" chiqishidan keyinga ko'chiring",
  send_after_delay: "Kutishdan oldin tugma yoki savol qo'ying — mijoz javob bersin",
  send_after_long_delay: "Kutishni 24 soatdan qisqartiring yoki \"window_closed\" chiqishini ulang",
  consecutive_sends: "Xabarlar orasiga tugma yoki savol qo'ying",
  lead_no_phone_source: "Lead blokidan oldin telefon tugmasi (kind: phone, saveAs: phone) qo'ying",
  webhook_private_host: "Faqat ochiq internetdagi https:// manzil",
  webhook_not_https: "Manzilni https:// bilan boshlang",
  price_under_never: "Narxni olib tashlang yoki profil siyosatini o'zgartiring",
  ai_no_handoff: "JavobAI blokining \"fallback\" chiqishini yoki keyingi qadamni operator blokiga ulang",
  ai_not_live: "\"fallback\" chiqishini operator blokiga ulang yoki JavobAI'ni LIVE qiling",
};

function fromPolicy(item: PolicyItem): Finding {
  return {
    code: POLICY_TO_AUDIT[item.code] ?? "policy_risk",
    nodeId: item.nodeId,
    message: item.message,
    fix: POLICY_FIX[item.code],
    policyCode: item.code,
  };
}

// ─── Audit ────────────────────────────────────────────────────────────────────

function label(node: FlowNode): string {
  return `«${node.id}» (${NODE_LABELS[node.type]})`;
}

function conditionKey(when: unknown): string {
  return JSON.stringify(when);
}

export function auditGraph(graph: FlowGraph, ctx: AuditContext = {}): AuditResult {
  const errors: Finding[] = [];
  const warnings: Finding[] = [];
  const suggestions: Finding[] = [];
  const index = buildIndex(graph);
  const trigger = index.trigger;
  const node = (id: string) => index.nodes.get(id);
  const reachable = trigger ? reachableFrom(index, trigger.id) : new Set<string>();

  // ── structure ──
  if (!trigger) {
    errors.push({ code: "dead_end", message: "Oqimda trigger bloki yo'q", fix: "Trigger blokini qo'shing" });
  } else if (graph.nodes.filter((n) => n.type === "trigger").length > 1) {
    errors.push({ code: "dead_end", message: "Oqimda bir nechta trigger bloki bor — faqat bittasi bo'lishi kerak" });
  }
  for (const id of findUnreachable(index)) {
    const n = node(id);
    if (!n || n.type === "trigger") continue;
    errors.push({ code: "unreachable", nodeId: id, message: `${label(n)} bloki hech qayerdan ulanmagan`, fix: "Blokni oqimga ulang yoki o'chiring" });
  }
  for (const dead of findDeadEnds(index)) {
    const n = node(dead.nodeId)!;
    errors.push({
      code: "dead_end",
      nodeId: dead.nodeId,
      message: `${label(n)} blokidan keyin davomi yo'q ("${dead.handle}" chiqishi bo'sh)`,
      fix: `"${dead.handle}" chiqishini keyingi blokka yoki "Tugash" blokiga ulang`,
    });
  }
  for (const broken of findBrokenEdges(graph)) {
    const edge = graph.edges[broken.edgeIndex];
    const message =
      broken.reason === "handle"
        ? `«${edge.from}» blokida "${edge.handle}" chiqishi yo'q`
        : `Bog'lanish mavjud bo'lmagan blokka ishora qiladi (${broken.reason === "from" ? edge.from : edge.to})`;
    errors.push({ code: "dead_end", edgeIndex: broken.edgeIndex, nodeId: edge.from, message, fix: "Bog'lanishni o'chiring yoki to'g'rilang" });
  }
  for (const cycle of findCycles(index)) {
    const route = cycle.nodes.map((id) => `«${id}»`).join(" → ");
    if (!cycle.hasWait) {
      errors.push({ code: "endless_loop", nodeId: cycle.nodes[0], message: `Cheksiz aylanish: ${route} — orasida kutish yo'q`, fix: "Aylanishga tugma, savol yoki kutish qo'ying, yoki uni uzing" });
    } else {
      suggestions.push({ code: "suggestion", nodeId: cycle.nodes[0], message: `Aylanish bor: ${route}. Dvigatel bir blokka 20 martadan ko'p kirmaydi — kerak bo'lsa hisoblagich sharti qo'ying` });
    }
  }

  // ── policy (computed once, mapped) ──
  const policy = evaluatePolicy(graph, ctx);
  for (const item of policy.items) {
    if (OWN_POLICY_CODES.has(item.code)) continue;
    (item.severity === "BLOCKED" ? errors : warnings).push(fromPolicy(item));
  }

  // ── spam / missing delay ──
  const chain = consecutiveSendsMax(index);
  if (chain.max > SPAM_BLOCKED_SENDS) {
    errors.push({ code: "spam_risk", nodeId: chain.atNodeId ?? undefined, message: `Ketma-ket ${chain.max} ta xabar mijoz javobisiz — spam`, fix: "Xabarlar orasiga tugma yoki savol qo'ying" });
  } else if (chain.max > SPAM_WARNING_SENDS) {
    warnings.push({ code: "spam_risk", nodeId: chain.atNodeId ?? undefined, message: `Ketma-ket ${chain.max} ta xabar mijoz javobisiz`, fix: "Xabarlar orasiga tugma yoki savol qo'ying" });
  }
  const noDelay = consecutiveSendsMax(index, { delayResets: true, countWaits: false });
  if (noDelay.max >= 3) {
    warnings.push({ code: "missing_delay", nodeId: noDelay.atNodeId ?? undefined, message: `${noDelay.max} ta xabar birin-ketin, orasida kutish ham, tugma ham yo'q`, fix: "Orasiga \"Kutish\" yoki tugma qo'ying" });
  } else if (noDelay.max === 2) {
    suggestions.push({ code: "missing_delay", nodeId: noDelay.atNodeId ?? undefined, message: "Ikki xabar birin-ketin ketadi — orasiga qisqa kutish qo'yish o'qilishini yaxshilaydi" });
  }
  if (trigger && trigger.matchingMode === "EVERY" && trigger.cooldownHours === 0) {
    if (COMMENT_TRIGGER_TYPES.has(trigger.triggerType)) {
      warnings.push({ code: "spam_risk", nodeId: trigger.id, message: "Har bir kommentga cooldown'siz javob — bir odam ketma-ket yozsa har safar DM oladi", fix: "cooldownHours ≥ 1 qo'ying yoki kalit so'z tanlang" });
    } else if (trigger.audience === "ANY") {
      warnings.push({ code: "spam_risk", nodeId: trigger.id, message: "Har bir xabarga, har kimga, cooldown'siz javob — spam xavfi", fix: "Auditoriyani toraytiring yoki cooldownHours qo'ying" });
    }
  }

  // ── duplicate actions ──
  const dupReported = new Set<string>();
  for (const path of pathsFromTrigger(index)) {
    const tagsSeen = new Map<string, string>();
    let previousSend: FlowNode | null = null;
    for (const id of path) {
      const n = node(id);
      if (!n) continue;
      if (n.type === "tag") {
        for (const slug of n.tagSlugs) {
          const key = `${n.action}:${slug}`;
          const first = tagsSeen.get(key);
          if (first && first !== id && !dupReported.has(`tag:${id}`)) {
            dupReported.add(`tag:${id}`);
            warnings.push({ code: "duplicate_action", nodeId: id, message: `${label(n)}: "${slug}" tegi shu yo'lda «${first}» blokida allaqachon ${n.action === "add" ? "qo'shilgan" : "olib tashlangan"}`, fix: "Takroriy teg blokini o'chiring" });
          }
          if (!first) tagsSeen.set(key, id);
        }
      }
      if (isSendNode(n)) {
        const text = sendText(n)?.trim().toLowerCase();
        const prev = previousSend ? sendText(previousSend)?.trim().toLowerCase() : null;
        if (text && prev && text === prev && !dupReported.has(`send:${id}`)) {
          dupReported.add(`send:${id}`);
          warnings.push({ code: "duplicate_action", nodeId: id, message: `${label(n)} matni oldingi «${previousSend!.id}» xabari bilan bir xil`, fix: "Takroriy xabarni o'chiring yoki matnini o'zgartiring" });
        }
        previousSend = n;
      }
    }
  }

  // ── conflicting conditions ──
  for (const n of graph.nodes) {
    if (n.type !== "condition") continue;
    const seen = new Map<string, string>();
    const setFields = new Map<string, Set<string>>();
    for (const branch of n.branches) {
      const key = conditionKey(branch.when);
      const first = seen.get(key);
      if (first) {
        warnings.push({ code: "conflicting_condition", nodeId: n.id, message: `${label(n)}: «${branch.label || branch.id}» sharti «${first}» bilan bir xil — unga hech qachon o'tilmaydi`, fix: "Shartni o'zgartiring yoki tarmoqni o'chiring" });
      } else {
        seen.set(key, branch.label || branch.id);
      }
      const conds = [...branch.when.all, ...(branch.when.any ?? [])];
      if (branch.when.all.length === 1 && !branch.when.any?.length) {
        const only = branch.when.all[0];
        if (only.op === "is_set" || only.op === "not_set") {
          const ops = setFields.get(only.field) ?? new Set<string>();
          ops.add(only.op);
          setFields.set(only.field, ops);
        }
      }
      if (trigger) {
        for (const cond of conds) {
          if (cond.field === "audience" && cond.op === "eq" && trigger.audience !== "ANY") {
            const expected = String(cond.value).toUpperCase().replace("_CONTACT", "");
            const actual = trigger.audience.replace("_CONTACT", "");
            if (expected !== actual) {
              warnings.push({ code: "conflicting_condition", nodeId: n.id, message: `${label(n)}: «${branch.label || branch.id}» auditoriya = ${String(cond.value)} ni tekshiradi, lekin trigger faqat ${trigger.audience} ni qabul qiladi`, fix: "Shartni yoki trigger auditoriyasini o'zgartiring" });
            }
          }
          if (cond.field === "trigger.source" && cond.op === "eq" && trigger.sourceFilter !== "ANY" && String(cond.value).toUpperCase() !== trigger.sourceFilter) {
            warnings.push({ code: "conflicting_condition", nodeId: n.id, message: `${label(n)}: «${branch.label || branch.id}» manba = ${String(cond.value)} ni tekshiradi, lekin trigger faqat ${trigger.sourceFilter} ni qabul qiladi` });
          }
        }
      }
    }
    for (const [field, ops] of setFields) {
      if (ops.has("is_set") && ops.has("not_set")) {
        warnings.push({ code: "conflicting_condition", nodeId: n.id, message: `${label(n)}: "${field}" uchun ham "bor", ham "yo'q" tarmog'i bor — "else" chiqishiga hech qachon o'tilmaydi` });
      }
    }
  }

  // ── variables ──
  const declared = new Set(graph.variables.map((v) => v.key));
  const setters = variableSetters(graph);
  const known = new Set([...declared, ...setters.keys()]);
  for (const n of graph.nodes) {
    const ancestors = ancestorsOf(index, n.id);
    for (const { field, text } of templateFields(n)) {
      for (const key of validateTemplateKeys(text, known)) {
        errors.push({ code: "incorrect_variable", nodeId: n.id, message: `${label(n)} ${field}: {{${key}}} o'zgaruvchisi mavjud emas`, fix: key.startsWith("vars.") ? `"${key.slice(5)}" ni o'zgaruvchilar ro'yxatiga qo'shing yoki uni saqlaydigan blok qo'ying` : "O'zgaruvchini ro'yxatdan tanlang" });
      }
      for (const ref of parseTemplateRefs(text)) {
        const key = varsKey(ref.key);
        if (!key || !known.has(key) || ref.fallback) continue;
        const sources = setters.get(key) ?? [];
        const upstream = sources.some((id) => ancestors.has(id));
        if (sources.length === 0) {
          warnings.push({ code: "incorrect_variable", nodeId: n.id, message: `${label(n)} ${field}: {{vars.${key}}} hech qayerda saqlanmaydi — bo'sh chiqadi`, fix: `Zaxira matn bering ({{vars.${key}|...}}) yoki uni saqlaydigan blok qo'ying` });
        } else if (!upstream) {
          warnings.push({ code: "incorrect_variable", nodeId: n.id, message: `${label(n)} ${field}: {{vars.${key}}} bu blokdan oldin saqlanmaydi — bo'sh chiqishi mumkin`, fix: `Zaxira matn bering ({{vars.${key}|...}})` });
        }
      }
    }
  }
  for (const key of setters.keys()) {
    if (!declared.has(key)) {
      suggestions.push({ code: "incorrect_variable", nodeId: setters.get(key)![0], message: `"${key}" o'zgaruvchisi saqlanadi, lekin ro'yxatda e'lon qilinmagan`, fix: `variables ro'yxatiga { key: "${key}" } qo'shing` });
    }
  }

  // ── integrations ──
  for (const n of graph.nodes) {
    if (n.type === "crm") {
      if (n.action === "move_stage") {
        if (!n.stageId) errors.push({ code: "broken_integration", nodeId: n.id, message: `${label(n)}: bosqich tanlanmagan`, fix: "stageId ni tanlang" });
        else if (ctx.stages && !ctx.stages.includes(n.stageId)) errors.push({ code: "broken_integration", nodeId: n.id, message: `${label(n)}: "${n.stageId}" bosqichi CRM'da yo'q`, fix: "Mavjud bosqichni tanlang" });
      }
      if (n.action === "assign" && n.assignStrategy === "member" && !n.memberId) errors.push({ code: "broken_integration", nodeId: n.id, message: `${label(n)}: operator tanlanmagan` });
      if (n.action === "set_field" && !n.field) errors.push({ code: "broken_integration", nodeId: n.id, message: `${label(n)}: maydon nomi yo'q` });
    }
    if (n.type === "tag" && ctx.declaredTags) {
      for (const slug of n.tagSlugs) {
        if (!ctx.declaredTags.includes(slug)) {
          warnings.push({ code: "broken_integration", nodeId: n.id, message: `${label(n)}: "${slug}" tegi hali yaratilmagan`, fix: "Tegni CRM'da yarating (publish paytida avtomatik taklif qilinadi)" });
        }
      }
    }
    if (n.type === "trigger") {
      if (n.mediaScope === "SPECIFIC" && n.mediaIds.length === 0) errors.push({ code: "broken_integration", nodeId: n.id, message: "Trigger «faqat tanlangan postlar» rejimida, lekin post tanlanmagan", fix: "Postlarni tanlang yoki mediaScope = ANY qiling" });
      if (n.storyScope === "SPECIFIC" && n.storyIds.length === 0) errors.push({ code: "broken_integration", nodeId: n.id, message: "Trigger «faqat tanlangan story'lar» rejimida, lekin story tanlanmagan" });
      if (n.matchingMode !== "EVERY" && n.keywords.length === 0 && n.intents.length === 0) errors.push({ code: "broken_integration", nodeId: n.id, message: "Trigger kalit so'z yoki niyatsiz hech qachon ishlamaydi", fix: "Kalit so'z qo'shing yoki matchingMode = EVERY qiling" });
    }
    if (n.type === "action") {
      if ((n.action === "set_variable" || n.action === "increment") && !n.key) errors.push({ code: "broken_integration", nodeId: n.id, message: `${label(n)}: o'zgaruvchi nomi yo'q` });
      if (n.action === "notify_telegram" && !n.text) errors.push({ code: "broken_integration", nodeId: n.id, message: `${label(n)}: Telegram xabari matni yo'q` });
    }
    if (n.type === "ai" && n.mode === "ask") {
      if (!n.question) errors.push({ code: "broken_integration", nodeId: n.id, message: `${label(n)}: savol matni yo'q` });
      if (!n.saveAs) errors.push({ code: "broken_integration", nodeId: n.id, message: `${label(n)}: javob qaysi o'zgaruvchiga saqlanishi ko'rsatilmagan (saveAs)` });
    }
  }

  // ── forbidden content ──
  for (const n of graph.nodes) {
    for (const { field, text } of templateFields(n)) {
      if (field === "note" || field === "summary" || field.startsWith("body.") || (n.type === "action" && field !== "text")) continue;
      const phones = findPhoneNumbers(text);
      if (phones.length) warnings.push({ code: "forbidden_content", nodeId: n.id, message: `${label(n)}: matnda telefon raqami bor (${phones[0]})`, fix: "Raqam o'rniga telefon tugmasi yoki operator qo'ying" });
      const urls = findUrls(text).filter((u) => !urlAllowed(u, ctx.allowedUrls));
      if (urls.length) warnings.push({ code: "forbidden_content", nodeId: n.id, message: `${label(n)}: matnda begona havola bor (${urls[0]})`, fix: "Havolani profildagi matnga qo'shing yoki olib tashlang" });
      for (const rule of BLOCKLIST) {
        if (rule.pattern.test(text)) warnings.push({ code: "forbidden_content", nodeId: n.id, message: `${label(n)}: taqiqlangan va'da — ${rule.label}` });
      }
    }
  }

  // ── missing handoff (beyond the policy items) ──
  const asksQuestions = graph.nodes.some((n) => reachable.has(n.id) && (n.type === "button" || (n.type === "ai" && n.mode === "ask")));
  const hasSink = graph.nodes.some(
    (n) => reachable.has(n.id) && (n.type === "operator" || n.type === "lead" || (n.type === "action" && n.action === "notify_telegram") || (n.type === "ai" && n.mode === "takeover" && ctx.javobAiMode !== "OFF" && ctx.javobAiMode !== "SHADOW"))
  );
  if (asksQuestions && !hasSink) {
    warnings.push({ code: "missing_handoff", message: "Oqim mijozdan javob so'raydi, lekin hech qayerda operator / lead / Telegram xabari yo'q — javoblar hech kimga yetib bormaydi", fix: "Operator, Lead yoki \"Telegramga xabar\" blokini qo'shing" });
  }

  // ── suggestions ──
  if (trigger) {
    const firstEdge = index.edgeOf(trigger.id, "next");
    const first = firstEdge ? node(firstEdge.to) : null;
    if (first?.type === "message" && first.text.length > 300) {
      suggestions.push({ code: "suggestion", nodeId: first.id, message: "Birinchi xabar 300 belgidan uzun — telefonda o'qish qiyin, qisqartiring" });
    }
    if (COMMENT_TRIGGER_TYPES.has(trigger.triggerType) && !trigger.publicReply) {
      suggestions.push({ code: "suggestion", nodeId: trigger.id, message: "Komment ostiga ochiq javob yozilmagan (publicReply) — \"Direct'ga yubordik\" kabi qisqa javob ishonchni oshiradi" });
    }
  }
  const leadNodes = graph.nodes.filter((n): n is Extract<FlowNode, { type: "lead" }> => n.type === "lead" && reachable.has(n.id));
  for (const lead of leadNodes) {
    if (!lead.thanks) suggestions.push({ code: "suggestion", nodeId: lead.id, message: `${label(lead)}: raqamdan keyin rahmat xabari yo'q (thanks)` });
  }
  if (leadNodes.length && !graph.nodes.some((n) => n.type === "tag" && reachable.has(n.id))) {
    suggestions.push({ code: "suggestion", nodeId: leadNodes[0].id, message: "Lead yo'lida teg qo'yilmaydi — CRM segmentlari uchun \"lead\" tegini qo'shing" });
  }

  return { errors, warnings, suggestions };
}

/** True when the version may be published as far as the auditor is concerned. */
export function auditPasses(result: AuditResult): boolean {
  return result.errors.length === 0;
}
