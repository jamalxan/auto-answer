/**
 * ETAP 7 — policy engine at publish (analysis §3.3, TZ 55). Pure over the
 * graph; verdict PASS / WARNING / BLOCKED.
 *
 *   P1/P7 messaging window: a comment flow's first send must be a message
 *          carrying the opening button; nothing (button / ai / lead / delay /
 *          further sends) runs until it is tapped — Blocked.
 *   P2     message with a button longer than 640 chars — Blocked; a
 *          LIVE_COMMENT flow with sends after the first — Warning.
 *   P3     send after a delay with no customer input in between: without an
 *          open window — Blocked; after more than 24h of delays — Warning
 *          ("faqat mijoz yozsa ketadi"); a delay of 7 days — Blocked.
 *   P4     > 3 consecutive sends — Warning, > 6 — Blocked.
 *   P5     identical text sent twice on one path — Warning.
 *   P6/P10 ai node without a handoff path / JavobAI not LIVE — Warning;
 *          lead node with no phone source upstream — Blocked.
 *   P7     quick replies > 13, label > 20, text > 1000 — Blocked; webhook to
 *          http:// or a private / internal host — Blocked; host outside the
 *          workspace allowlist — Warning.
 *   P8     price text while pricePolicy = NEVER — Warning.
 *   P9     endless loop (cycle with no wait) — Blocked.
 *   structure: unreachable node / dead-end — Blocked (ERROR class).
 *
 * Blocked disables Publish; Warning needs an explicit acknowledgement.
 * Messages are Uzbek Latin. No DNS: the private-host check is static
 * (isInternalHostname + the IP-literal rules of lib/integrations/net).
 */

import { isInternalHostname } from "@/lib/integrations/net";
import {
  buildIndex,
  consecutiveSendsMax,
  findDeadEnds,
  findEndlessLoops,
  findUnreachable,
  type FlowIndex,
  maxDelaySinceInputAt,
  pathsFromTrigger,
  phoneSources,
  reachableFrom,
  windowStateAt,
} from "./graph";
import {
  COMMENT_TRIGGER_TYPES,
  FLOW_LIMITS,
  type FlowGraph,
  type FlowNode,
  type FlowTriggerType,
  isSendNode,
  NODE_LABELS,
  sendText,
} from "./schema";
import { parseTemplateRefs, varsKey } from "./variables";

export type PolicyVerdict = "PASS" | "WARNING" | "BLOCKED";
export type PolicySeverity = "WARNING" | "BLOCKED";

export const POLICY_CODES = [
  "window_first_not_message",
  "window_no_opening_button",
  "window_closed_send",
  "message_button_too_long",
  "live_comment_extra_send",
  "send_after_delay",
  "send_after_long_delay",
  "delay_too_long",
  "consecutive_sends",
  "duplicate_text",
  "ai_not_live",
  "ai_no_handoff",
  "lead_no_phone_source",
  "too_many_quick_replies",
  "button_label_too_long",
  "message_too_long",
  "webhook_not_https",
  "webhook_private_host",
  "webhook_host_not_allowed",
  "price_under_never",
  "endless_loop",
  "unreachable",
  "dead_end",
] as const;
export type PolicyCode = (typeof POLICY_CODES)[number];

export interface PolicyItem {
  severity: PolicySeverity;
  code: PolicyCode;
  message: string;
  nodeId?: string;
}

export interface PolicyResult {
  verdict: PolicyVerdict;
  items: PolicyItem[];
}

export interface PolicyContext {
  /** Defaults to the trigger node's type. */
  triggerType?: FlowTriggerType;
  pricePolicy?: "NEVER" | "FROM_ONLY" | "EXACT";
  /** JavobAI mode of the account; undefined = unknown (the LIVE-only checks are skipped). */
  javobAiMode?: "OFF" | "SHADOW" | "LIVE";
  /** Owner decision 3: allowlist is a Warning until ETAP 8. Undefined = no allowlist configured. */
  webhookAllowedHosts?: string[];
}

export const SPAM_WARNING_SENDS = 3;
export const SPAM_BLOCKED_SENDS = 6;

// ─── Content heuristics ───────────────────────────────────────────────────────

/** `1 200 000 so'm`, `300k`, `$25`, `250 ming`, `от 500 000 сум` — digits next to a money marker. */
const PRICE_PATTERN =
  /(\d[\d\s.,]*\s*(?:so['‘’`ʻ]?m|сум|сўм|sum|som|uzs|usd|dollar|доллар|руб|rub|ming|минг|mln|млн|k)(?![\p{L}]))|(?:\$|€|₽)\s*\d|\d\s*(?:\$|€|₽)/iu;

/** Template references removed: `{{vars.price|so'rang}}` is not a price. */
function withoutTemplates(text: string): string {
  return text.replace(/\{\{[^{}]*\}\}/g, " ");
}

export function mentionsPrice(text: string): boolean {
  return PRICE_PATTERN.test(withoutTemplates(text));
}

/** Static SSRF check for a webhook URL: https only, no internal / private host. Null when fine. */
export function webhookUrlProblem(url: string): "not_https" | "private_host" | "invalid" | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return "invalid";
  }
  if (parsed.protocol !== "https:") return "not_https";
  if (isInternalHostname(parsed.hostname)) return "private_host";
  return null;
}

function hostAllowed(url: string, allowed: string[] | undefined): boolean {
  if (!allowed) return true;
  let host: string;
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return false;
  }
  return allowed.some((entry) => {
    const h = entry.trim().toLowerCase();
    return h === host || (h.startsWith("*.") && host.endsWith(h.slice(1)));
  });
}

/** True when the flow reaches a human / JavobAI sink from `fromId` (operator, lead, notify, takeover). */
function hasHandoffFrom(index: FlowIndex, fromId: string, javobAiMode: PolicyContext["javobAiMode"]): boolean {
  for (const id of reachableFrom(index, fromId)) {
    if (id === fromId) continue;
    const node = index.nodes.get(id);
    if (!node) continue;
    if (node.type === "operator" || node.type === "lead") return true;
    if (node.type === "action" && node.action === "notify_telegram") return true;
    if (node.type === "ai" && node.mode === "takeover" && javobAiMode !== "OFF" && javobAiMode !== "SHADOW") return true;
  }
  return false;
}

function label(node: FlowNode): string {
  return `«${node.id}» (${NODE_LABELS[node.type]})`;
}

// ─── Evaluate ─────────────────────────────────────────────────────────────────

export function evaluatePolicy(graph: FlowGraph, ctx: PolicyContext = {}): PolicyResult {
  const index = buildIndex(graph);
  const items: PolicyItem[] = [];
  const add = (severity: PolicySeverity, code: PolicyCode, message: string, nodeId?: string) => {
    if (items.some((i) => i.code === code && i.nodeId === nodeId)) return;
    items.push({ severity, code, message, nodeId });
  };
  const triggerType = ctx.triggerType ?? index.trigger?.triggerType;
  const isComment = !!triggerType && COMMENT_TRIGGER_TYPES.has(triggerType);
  const reachable = index.trigger ? reachableFrom(index, index.trigger.id) : new Set<string>();
  const node = (id: string) => index.nodes.get(id);

  // Structure (ERROR class).
  for (const id of findUnreachable(index)) {
    const n = node(id);
    add("BLOCKED", "unreachable", `${n ? label(n) : `«${id}»`} bloki hech qayerdan ulanmagan`, id);
  }
  for (const dead of findDeadEnds(index)) {
    const n = node(dead.nodeId);
    add("BLOCKED", "dead_end", `${n ? label(n) : `«${dead.nodeId}»`} blokidan keyin davomi yo'q ("${dead.handle}" chiqishi bo'sh)`, dead.nodeId);
  }
  for (const cycle of findEndlessLoops(index)) {
    add("BLOCKED", "endless_loop", `Cheksiz aylanish: ${cycle.nodes.map((id) => `«${id}»`).join(" → ")} — orasida kutish yo'q`, cycle.nodes[0]);
  }

  // P1 / P7 — messaging window for comment flows.
  const windowStates = windowStateAt(index);
  // First send on each path from the trigger (the private reply of a comment flow).
  const firstSends = new Set<string>();
  if (index.trigger) {
    const seen = new Set<string>();
    const stack = (index.out.get(index.trigger.id) ?? []).map((e) => e.to);
    while (stack.length) {
      const id = stack.pop()!;
      if (seen.has(id)) continue;
      seen.add(id);
      const n = node(id);
      if (!n) continue;
      if (isSendNode(n)) {
        firstSends.add(id);
        continue;
      }
      for (const edge of index.out.get(id) ?? []) stack.push(edge.to);
    }
  }
  if (isComment) {
    for (const id of firstSends) {
      const n = node(id)!;
      if (n.type !== "message") {
        add("BLOCKED", "window_first_not_message", `${label(n)} komment oqimining birinchi yuborishi bo'la olmaydi: avval tugmali xabar (private reply) ketadi`, id);
        continue;
      }
      if (!n.button) {
        // Anything that needs an open window after it?
        const after = [...reachableFrom(index, id)].filter((x) => x !== id).map(node).filter((x): x is FlowNode => !!x);
        const needsWindow = after.find((x) => isSendNode(x) || x.type === "button" || x.type === "ai" || x.type === "lead" || x.type === "delay");
        if (needsWindow) {
          add(
            "BLOCKED",
            "window_no_opening_button",
            `${label(n)} xabarida ochuvchi tugma yo'q: tugma bosilmaguncha ${label(needsWindow)} ishlamaydi (24 soatlik oyna yopiq)`,
            id
          );
        }
      }
    }
  }
  for (const [id, state] of windowStates) {
    const n = node(id);
    if (!n || state === "open") continue;
    const needsWindow = n.type === "button" || n.type === "ai" || n.type === "lead" || n.type === "delay";
    const isOpener = n.type === "message" && firstSends.has(id);
    if (needsWindow) {
      add("BLOCKED", "window_closed_send", `${label(n)} bloki oyna ochilmasdan turib ishlamaydi: avval tugmali xabar, keyin tugma bosilishi kerak`, id);
    } else if (!isOpener && isSendNode(n)) {
      add("BLOCKED", "window_closed_send", `${label(n)} oyna yopiq paytda yuborilmaydi: avval tugmali xabar, keyin tugma bosilishi kerak`, id);
    }
  }

  // P2 — limits (also zod; here for drafts) and live-comment extra sends.
  for (const n of graph.nodes) {
    if (n.type === "message" && n.button && n.text.length > FLOW_LIMITS.buttonTemplateTextLength) {
      add("BLOCKED", "message_button_too_long", `${label(n)}: tugmali xabar ${FLOW_LIMITS.buttonTemplateTextLength} belgidan oshmasin (Meta button template)`, n.id);
    }
    if (n.type === "message" && n.button && n.button.label.length > FLOW_LIMITS.buttonLabelLength) {
      add("BLOCKED", "button_label_too_long", `${label(n)}: tugma nomi ${FLOW_LIMITS.buttonLabelLength} belgidan oshmasin`, n.id);
    }
    if (n.type === "button") {
      if (n.buttons.length > FLOW_LIMITS.quickReplies) {
        add("BLOCKED", "too_many_quick_replies", `${label(n)}: ko'pi bilan ${FLOW_LIMITS.quickReplies} ta tugma (Meta quick replies)`, n.id);
      }
      if (n.buttons.some((b) => b.label.length > FLOW_LIMITS.buttonLabelLength)) {
        add("BLOCKED", "button_label_too_long", `${label(n)}: tugma nomi ${FLOW_LIMITS.buttonLabelLength} belgidan oshmasin`, n.id);
      }
    }
    const text = sendText(n);
    if (text && text.length > FLOW_LIMITS.messageLength) {
      add("BLOCKED", "message_too_long", `${label(n)}: xabar ${FLOW_LIMITS.messageLength} belgidan oshmasin`, n.id);
    }
  }
  if (triggerType === "LIVE_COMMENT" && index.trigger) {
    const sends = [...reachable].map(node).filter((n): n is FlowNode => !!n && isSendNode(n));
    if (sends.length > 1) {
      add("WARNING", "live_comment_extra_send", "Live komment oqimida birinchi javobdan keyingi xabarlar faqat efir davom etsa yetib boradi", sends[1].id);
    }
  }

  // P3 — sends after delays.
  const delays = maxDelaySinceInputAt(index);
  for (const [id, minutes] of delays) {
    const n = node(id);
    if (!n || !isSendNode(n)) continue;
    if (!Number.isFinite(minutes)) continue; // comment flow before the tap: reported by the window rule
    if (minutes > FLOW_LIMITS.windowMinutes) {
      add("WARNING", "send_after_long_delay", `${label(n)}: 24 soatdan uzoq kutishdan keyin xabar faqat mijoz yozsa ketadi (oyna yopiladi)`, id);
    }
  }
  for (const n of graph.nodes) {
    if (n.type === "delay" && n.minutes >= FLOW_LIMITS.delayMaxMinutes) {
      add("BLOCKED", "delay_too_long", `${label(n)}: kutish 7 kundan kam bo'lishi kerak (run muddati)`, n.id);
    }
  }
  // A send right after a delay with the window structurally closed (comment flow before the tap).
  for (const n of graph.nodes) {
    if (n.type !== "delay" || windowStates.get(n.id) === "open" || !windowStates.has(n.id)) continue;
    const next = index.edgeOf(n.id, "next");
    const target = next ? node(next.to) : null;
    if (target && isSendNode(target)) {
      add("BLOCKED", "send_after_delay", `${label(target)}: kutishdan keyin yuboriladi, lekin mijoz hali tugma bosmagan / yozmagan`, target.id);
    }
  }

  // P4 — consecutive sends.
  const chain = consecutiveSendsMax(index);
  if (chain.max > SPAM_BLOCKED_SENDS) {
    add("BLOCKED", "consecutive_sends", `Ketma-ket ${chain.max} ta xabar mijoz javobisiz — spam (chegara ${SPAM_BLOCKED_SENDS})`, chain.atNodeId ?? undefined);
  } else if (chain.max > SPAM_WARNING_SENDS) {
    add("WARNING", "consecutive_sends", `Ketma-ket ${chain.max} ta xabar mijoz javobisiz — orasiga tugma yoki savol qo'ying (tavsiya ${SPAM_WARNING_SENDS} tagacha)`, chain.atNodeId ?? undefined);
  }

  // P5 — identical text twice on one path.
  const dupSeen = new Set<string>();
  for (const path of pathsFromTrigger(index)) {
    const texts = new Map<string, string>();
    for (const id of path) {
      const n = node(id);
      const text = n ? sendText(n) : null;
      if (!n || !text) continue;
      const key = text.trim().toLowerCase();
      const first = texts.get(key);
      if (first && first !== id && !dupSeen.has(id)) {
        dupSeen.add(id);
        add("WARNING", "duplicate_text", `${label(n)} matni «${first}» bilan bir xil — mijoz bir xil xabarni ikki marta oladi`, id);
      }
      if (!first) texts.set(key, id);
    }
  }

  // P6 / P10 — ai and lead nodes.
  for (const n of graph.nodes) {
    if (!reachable.has(n.id)) continue;
    if (n.type === "ai") {
      const hasFallback = !!index.edgeOf(n.id, "fallback");
      if (n.mode === "takeover" && ctx.javobAiMode !== undefined && ctx.javobAiMode !== "LIVE" && !hasFallback) {
        add("WARNING", "ai_not_live", `${label(n)}: JavobAI bu akkauntda LIVE emas (${ctx.javobAiMode}) — "fallback" chiqishi yo'q, run operatorga o'tadi`, n.id);
      }
      if (n.mode === "ask" && !hasHandoffFrom(index, n.id, ctx.javobAiMode)) {
        add("WARNING", "ai_no_handoff", `${label(n)}: savoldan keyin operatorga yo'l yo'q (operator / lead / Telegram xabari qo'ying)`, n.id);
      }
      if (n.mode === "takeover" && (ctx.javobAiMode === "OFF" || ctx.javobAiMode === "SHADOW") && !hasFallback) {
        add("WARNING", "ai_no_handoff", `${label(n)}: operatorga yo'l yo'q — JavobAI LIVE bo'lmaganda "fallback" chiqishini operator blokiga ulang`, n.id);
      }
    }
    if (n.type === "lead") {
      const key = varsKey(n.phoneFrom);
      if (key) {
        const sources = phoneSources(graph).get(key) ?? [];
        const upstream = new Set<string>();
        for (const id of sources) if (reachableFrom(index, id).has(n.id)) upstream.add(id);
        if (upstream.size === 0) {
          add("BLOCKED", "lead_no_phone_source", `${label(n)}: telefon olinmaydi — oldin telefon tugmasi (kind: phone) yoki JavobAI "phone" savoli vars.${key} ga saqlashi kerak`, n.id);
        }
      } else if (n.phoneFrom !== "contact.phone") {
        add("BLOCKED", "lead_no_phone_source", `${label(n)}: "${n.phoneFrom}" telefon manbai emas (vars.<nom> yoki contact.phone)`, n.id);
      }
    }
  }

  // P7 — webhooks.
  for (const n of graph.nodes) {
    if (n.type !== "webhook") continue;
    const problem = webhookUrlProblem(n.url);
    if (problem === "not_https" || problem === "invalid") {
      add("BLOCKED", "webhook_not_https", `${label(n)}: webhook faqat https:// manzilga yuboriladi`, n.id);
    } else if (problem === "private_host") {
      add("BLOCKED", "webhook_private_host", `${label(n)}: ichki / xususiy tarmoq manziliga webhook yuborib bo'lmaydi`, n.id);
    } else if (!hostAllowed(n.url, ctx.webhookAllowedHosts)) {
      add("WARNING", "webhook_host_not_allowed", `${label(n)}: host ruxsat etilganlar ro'yxatida yo'q`, n.id);
    }
  }

  // P8 — price under NEVER.
  if (ctx.pricePolicy === "NEVER") {
    for (const n of graph.nodes) {
      const text = sendText(n);
      if (text && mentionsPrice(text)) {
        add("WARNING", "price_under_never", `${label(n)}: narx yozilgan, lekin profil siyosati "narx aytilmaydi"`, n.id);
      }
      // A template fallback can carry a price too ("{{vars.price|250 000 so'm}}").
      if (text && parseTemplateRefs(text).some((ref) => ref.fallback && mentionsPrice(ref.fallback))) {
        add("WARNING", "price_under_never", `${label(n)}: zaxira matnda narx bor, profil siyosati "narx aytilmaydi"`, n.id);
      }
    }
  }

  const verdict: PolicyVerdict = items.some((i) => i.severity === "BLOCKED")
    ? "BLOCKED"
    : items.some((i) => i.severity === "WARNING")
      ? "WARNING"
      : "PASS";
  return { verdict, items };
}
