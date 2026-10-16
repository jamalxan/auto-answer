/**
 * Pure graph editing helpers of the Flow Builder UI (both the stacked Simple
 * editor and the Advanced canvas edit the SAME graph through these):
 * node factory, ids, edge set / prune, insert / remove / move, variable
 * sync, auto layout, outlines and a phone-preview walk.
 *
 * Client-safe: only lib/flows pure modules (schema, variables).
 */

import { FLOW_LIMITS, type FlowEdge, type FlowGraph, type FlowNode, type FlowNodeType, handlesFor, NODE_LABELS } from "@/lib/flows/schema";
import { TEMPLATE_SHORTHANDS } from "@/lib/flows/variables";
import type { FlowsMeta } from "./shared";

export const ADDABLE_TYPES: FlowNodeType[] = ["message", "button", "condition", "delay", "tag", "lead", "ai", "crm", "operator", "webhook", "action", "end"];

export const NODE_HINTS: Record<FlowNodeType, string> = {
  trigger: "Oqim nima bilan boshlanadi",
  message: "Matnli xabar (ixtiyoriy bitta tugma bilan)",
  button: "Tugmalar: mijoz bosadi yoki yozadi",
  ai: "JavobAI ga topshirish yoki savol berib javobni olish",
  condition: "Shart bo'yicha tarmoqlanish",
  delay: "Kutish, so'ng davom etish",
  tag: "Mijozga teg qo'shish / olib tashlash",
  lead: "Telefon bo'yicha lead yaratish",
  webhook: "Tashqi manzilga POST so'rov",
  crm: "CRM: bosqich, bitim, biriktirish",
  operator: "Operatorga topshirish",
  action: "O'zgaruvchi, Telegram xabar, to'xtatish",
  end: "Oqim tugaydi",
};

const ID_PREFIX: Record<FlowNodeType, string> = {
  trigger: "t",
  message: "m",
  button: "b",
  ai: "ai",
  condition: "c",
  delay: "d",
  tag: "tag",
  lead: "lead",
  webhook: "wh",
  crm: "crm",
  operator: "op",
  action: "act",
  end: "end",
};

export function newNodeId(graph: FlowGraph, type: FlowNodeType): string {
  const taken = new Set(graph.nodes.map((n) => n.id));
  const prefix = ID_PREFIX[type];
  if (!taken.has(prefix) && (type === "end" || type === "trigger")) return prefix;
  for (let i = 1; i < 1000; i++) {
    const id = `${prefix}${i}`;
    if (!taken.has(id)) return id;
  }
  return `${prefix}${Date.now().toString(36)}`;
}

export function shortId(prefix = "x"): string {
  return `${prefix}${Math.random().toString(36).slice(2, 6)}`;
}

export function defaultNode(type: FlowNodeType, id: string, meta: FlowsMeta | null): FlowNode {
  switch (type) {
    case "message":
      return { id, type, text: "Yangi xabar", typingDelayMs: 0 };
    case "button":
      return { id, type, text: "Tanlang:", buttons: [{ id: shortId("b"), label: "Ha", kind: "text" }], onText: "other_edge" };
    case "ai":
      return { id, type, mode: "takeover", retries: 1 };
    case "condition":
      return { id, type, branches: [{ id: shortId("c"), label: "Shart 1", when: { v: 1, all: [] } }] };
    case "delay":
      return { id, type, minutes: 60, ifWindowClosed: "end", cancelOnReply: false };
    case "tag":
      return { id, type, action: "add", tagSlugs: [meta?.tags[0]?.slug ?? "yangi"] };
    case "lead":
      return { id, type, phoneFrom: "vars.phone" };
    case "webhook":
      return { id, type, url: "https://example.com/hook", method: "POST", body: {}, timeoutMs: 5000 };
    case "crm": {
      const stage = meta?.pipelines.flatMap((p) => p.stages)[0];
      return { id, type, action: "move_stage", stageId: stage?.id };
    }
    case "operator":
      return { id, type, reason: "flow_rule" };
    case "action":
      return { id, type, action: "notify_telegram", text: "Yangi mijoz" };
    case "end":
      return { id, type };
    default:
      throw new Error(`Bu blokni qo'shib bo'lmaydi: ${type}`);
  }
}

// ─── Handles ──────────────────────────────────────────────────────────────────

export interface HandleInfo {
  handle: string;
  required: boolean;
  label: string;
}

export function handleLabel(node: FlowNode, handle: string): string {
  if (handle === "next") return node.type === "trigger" ? "Boshlanganda" : "Keyin";
  if (handle === "tap") return node.type === "message" && node.button ? `«${node.button.label}» bosilsa` : "Tugma bosilsa";
  if (handle.startsWith("tap:")) {
    const id = handle.slice(4);
    const button = node.type === "button" ? node.buttons.find((b) => b.id === id) : null;
    return `«${button?.label ?? id}» bosilsa`;
  }
  if (handle.startsWith("branch:")) {
    const id = handle.slice(7);
    const branch = node.type === "condition" ? node.branches.find((b) => b.id === id) : null;
    return `Shart: ${branch?.label || id}`;
  }
  switch (handle) {
    case "other":
      return "Boshqa narsa yozsa";
    case "timeout":
      return "Javob bo'lmasa (vaqt tugadi)";
    case "else":
      return "Hech biri mos kelmasa";
    case "missing":
      return node.type === "lead" ? "Telefon topilmasa" : "Javob olinmasa";
    case "error":
      return "Xato bo'lsa";
    case "window_closed":
      return "24 soatlik oyna yopilgan bo'lsa";
    case "fallback":
      return "JavobAI yoqilmagan bo'lsa";
    default:
      return handle;
  }
}

/** Required + optional handles of a node, in display order. */
export function handlesOf(node: FlowNode): HandleInfo[] {
  const rule = handlesFor(node);
  const out: HandleInfo[] = [];
  for (const handle of rule.required) out.push({ handle, required: true, label: handleLabel(node, handle) });
  for (const handle of rule.optional) out.push({ handle, required: false, label: handleLabel(node, handle) });
  return out;
}

export function edgeTarget(graph: FlowGraph, from: string, handle: string): string | null {
  return graph.edges.find((e) => e.from === from && e.handle === handle)?.to ?? null;
}

/** One edge per (from, handle): sets, replaces or (to = null) removes it. */
export function setEdge(graph: FlowGraph, from: string, handle: string, to: string | null): FlowGraph {
  const rest = graph.edges.filter((e) => !(e.from === from && e.handle === handle));
  return { ...graph, edges: to ? [...rest, { from, to, handle }] : rest };
}

export function removeEdge(graph: FlowGraph, edge: FlowEdge): FlowGraph {
  return { ...graph, edges: graph.edges.filter((e) => !(e.from === edge.from && e.to === edge.to && e.handle === edge.handle)) };
}

/** Drops edges whose source / target is gone or whose handle the source node no longer has. */
export function pruneEdges(graph: FlowGraph): FlowGraph {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const edges = graph.edges.filter((e) => {
    const from = nodes.get(e.from);
    if (!from || !nodes.has(e.to)) return false;
    const rule = handlesFor(from);
    return rule.required.includes(e.handle) || rule.optional.includes(e.handle);
  });
  return edges.length === graph.edges.length ? graph : { ...graph, edges };
}

/** Every key a node writes (button saveAs, ai ask, webhook, set_variable) is declared in graph.variables. */
export function syncVariables(graph: FlowGraph): FlowGraph {
  const declared = new Set(graph.variables.map((v) => v.key));
  const add: FlowGraph["variables"] = [];
  const want = (key: string | undefined, kind: "string" | "number" | "phone" | "email" = "string") => {
    if (!key || declared.has(key) || !/^[a-z][a-z0-9_]{0,31}$/.test(key) || graph.variables.length + add.length >= FLOW_LIMITS.variables) return;
    declared.add(key);
    add.push({ key, label: key, kind });
  };
  for (const node of graph.nodes) {
    if (node.type === "button") for (const b of node.buttons) want(b.saveAs, b.kind === "phone" ? "phone" : b.kind === "email" ? "email" : "string");
    else if (node.type === "ai") want(node.saveAs, node.extract === "phone" ? "phone" : node.extract === "email" ? "email" : node.extract === "number" ? "number" : "string");
    else if (node.type === "webhook") want(node.saveAs);
    else if (node.type === "action") want(node.key, node.action === "increment" ? "number" : "string");
  }
  return add.length ? { ...graph, variables: [...graph.variables, ...add] } : graph;
}

/** Replaces one node (by id), then prunes edges that lost their handle and declares new variables. */
export function updateNode(graph: FlowGraph, id: string, next: FlowNode, rename?: Record<string, string>): FlowGraph {
  const nodes = graph.nodes.map((n) => (n.id === id ? next : n));
  // `rename` moves an edge to another handle of the same node (message: next <-> tap).
  const edges = rename ? graph.edges.map((e) => (e.from === id && rename[e.handle] ? { ...e, handle: rename[e.handle] } : e)) : graph.edges;
  return syncVariables(pruneEdges({ ...graph, nodes, edges }));
}

/** The edge a freshly inserted node should continue to: the anchor's single continuing handle target. */
function continuing(node: FlowNode): string | null {
  const rule = handlesFor(node);
  if (rule.required.length === 1) return rule.required[0];
  if (rule.required.length === 0 && rule.optional.includes("next")) return "next";
  return null;
}

/** Inserts a block after `afterId` (list order). A single continuing edge is rewired through the new block. */
export function insertNode(graph: FlowGraph, afterId: string | null, node: FlowNode): FlowGraph {
  const index = afterId ? graph.nodes.findIndex((n) => n.id === afterId) : graph.nodes.length - 1;
  const nodes = [...graph.nodes.slice(0, index + 1), node, ...graph.nodes.slice(index + 1)];
  let next: FlowGraph = { ...graph, nodes };
  const anchor = graph.nodes[index];
  if (anchor) {
    const handle = continuing(anchor);
    const target = handle ? edgeTarget(graph, anchor.id, handle) : null;
    if (handle && target) {
      next = setEdge(next, anchor.id, handle, node.id);
      const main = handlesFor(node).required;
      for (const h of main) next = setEdge(next, node.id, h, target);
    } else if (handle && node.type !== "end") {
      next = setEdge(next, anchor.id, handle, node.id);
    }
  }
  return syncVariables(pruneEdges(next));
}

/** Removes a block; edges that pointed to it are bridged to its own `next`-like target when there is one. */
export function removeNode(graph: FlowGraph, id: string): FlowGraph {
  const node = graph.nodes.find((n) => n.id === id);
  if (!node || node.type === "trigger") return graph;
  const handle = continuing(node);
  const bridge = handle ? edgeTarget(graph, id, handle) : null;
  const edges: FlowEdge[] = [];
  for (const e of graph.edges) {
    if (e.from === id) continue;
    if (e.to === id) {
      if (bridge && bridge !== e.from) edges.push({ ...e, to: bridge });
      continue;
    }
    edges.push(e);
  }
  const layout = graph.layout ? Object.fromEntries(Object.entries(graph.layout).filter(([key]) => key !== id)) : undefined;
  return { ...graph, nodes: graph.nodes.filter((n) => n.id !== id), edges, layout };
}

export function moveNode(graph: FlowGraph, id: string, delta: -1 | 1): FlowGraph {
  const index = graph.nodes.findIndex((n) => n.id === id);
  const target = index + delta;
  // The trigger stays first.
  if (index <= 0 || target < 1 || target >= graph.nodes.length) return graph;
  const nodes = [...graph.nodes];
  [nodes[index], nodes[target]] = [nodes[target], nodes[index]];
  return { ...graph, nodes };
}

// ─── Layout ───────────────────────────────────────────────────────────────────

export const NODE_W = 220;
export const NODE_HEADER = 44;
export const HANDLE_ROW = 24;
export const GAP_X = 90;
export const GAP_Y = 36;

export function nodeHeight(node: FlowNode): number {
  return NODE_HEADER + Math.max(1, handlesOf(node).length) * HANDLE_ROW + 10;
}

/** Layered layout: depth from the trigger (longest path over the DAG, back edges ignored), columns left to right. */
export function autoLayout(graph: FlowGraph): NonNullable<FlowGraph["layout"]> {
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  const out = new Map<string, string[]>();
  for (const e of graph.edges) out.set(e.from, [...(out.get(e.from) ?? []), e.to]);
  const depth = new Map<string, number>();
  if (trigger) {
    // DFS: edges into a node that is still on the stack are back edges (loops) and do not count.
    const onStack = new Set<string>();
    const visit = (id: string, d: number) => {
      if ((depth.get(id) ?? -1) >= d) return;
      depth.set(id, d);
      onStack.add(id);
      for (const to of out.get(id) ?? []) if (!onStack.has(to)) visit(to, d + 1);
      onStack.delete(id);
    };
    visit(trigger.id, 0);
  }
  const maxDepth = Math.max(0, ...depth.values());
  const columns = new Map<number, FlowNode[]>();
  for (const node of graph.nodes) {
    const d = depth.get(node.id) ?? maxDepth + 1;
    columns.set(d, [...(columns.get(d) ?? []), node]);
  }
  const layout: NonNullable<FlowGraph["layout"]> = {};
  for (const [d, nodes] of columns) {
    let y = 0;
    for (const node of nodes) {
      layout[node.id] = { x: d * (NODE_W + GAP_X), y };
      y += nodeHeight(node) + GAP_Y;
    }
  }
  return layout;
}

/** Positions for every node; nodes without a stored position get the auto-layout one. */
export function withLayout(graph: FlowGraph): NonNullable<FlowGraph["layout"]> {
  const auto = autoLayout(graph);
  const layout: NonNullable<FlowGraph["layout"]> = {};
  for (const node of graph.nodes) layout[node.id] = graph.layout?.[node.id] ?? auto[node.id];
  return layout;
}

// ─── Text ─────────────────────────────────────────────────────────────────────

function clip(text: string, max = 70): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/** One line shown on a collapsed block / canvas card. */
export function describeNode(node: FlowNode, meta?: FlowsMeta | null): string {
  switch (node.type) {
    case "trigger": {
      const kw = node.keywords.length ? `«${node.keywords.slice(0, 3).join("», «")}»${node.keywords.length > 3 ? "…" : ""}` : node.intents.length ? `niyat: ${node.intents.join(", ")}` : "har bir";
      return `${meta?.triggerLabels[node.triggerType] ?? node.triggerType} · ${kw}`;
    }
    case "message":
      return clip(node.text) + (node.button ? `  [${node.button.label}]` : "");
    case "button":
      return `${clip(node.text, 40)}  [${node.buttons.map((b) => b.label).join(" | ")}]`;
    case "ai":
      return node.mode === "takeover" ? "JavobAI suhbatni oladi" : `Savol: ${clip(node.question ?? "—", 50)}`;
    case "condition":
      return node.branches.map((b) => b.label || b.id).join(" / ") || "—";
    case "delay":
      return node.minutes >= 1440 ? `${Math.round((node.minutes / 1440) * 10) / 10} kun` : node.minutes >= 60 ? `${Math.round((node.minutes / 60) * 10) / 10} soat` : `${node.minutes} daqiqa`;
    case "tag":
      return `${node.action === "add" ? "+" : "−"} ${node.tagSlugs.join(", ")}`;
    case "lead":
      return `Telefon: ${node.phoneFrom}`;
    case "webhook":
      return clip(node.url, 50);
    case "crm":
      return { move_stage: "Bosqichga o'tkazish", create_deal: "Bitim yaratish", assign: "Operator biriktirish", set_field: `Maydon: ${node.field ?? "—"}` }[node.action];
    case "operator":
      return node.reply ? clip(node.reply, 50) : "Operatorga topshirish";
    case "action":
      return { set_variable: `${node.key ?? "?"} = ${clip(node.value ?? "", 30)}`, increment: `${node.key ?? "?"} + 1`, notify_telegram: "Telegram'ga xabar", opt_out: "Obunadan chiqarish", stop_followups: "Follow-up'larni to'xtatish", mark_test: "Test deb belgilash" }[node.action];
    case "end":
      return node.reason ?? "Oqim tugaydi";
  }
}

export function nodeTitle(node: FlowNode): string {
  return NODE_LABELS[node.type];
}

// ─── Variables vocabulary for chips ───────────────────────────────────────────

export interface VariableChip {
  /** What is inserted between {{ }}. */
  token: string;
  label: string;
}

export function variableChips(graph: FlowGraph, meta: FlowsMeta | null): VariableChip[] {
  const chips: VariableChip[] = [];
  const shorthandLabels = new Map((meta?.variables ?? []).map((v) => [v.key, v.label]));
  for (const [short, full] of Object.entries(TEMPLATE_SHORTHANDS)) {
    chips.push({ token: short, label: shorthandLabels.get(full) ?? short });
  }
  for (const v of graph.variables) chips.push({ token: `vars.${v.key}`, label: v.label || v.key });
  return chips;
}

// ─── Preview ──────────────────────────────────────────────────────────────────

const SAMPLE: Record<string, string> = {
  "contact.name": "Ali",
  "contact.username": "ali_uz",
  "contact.phone": "+998901234567",
  "contact.email": "ali@mail.uz",
  "trigger.text": "narxi qancha?",
  "trigger.keyword": "narx",
  "trigger.intent": "price",
};

export function sampleRender(text: string): string {
  return text.replace(/\{\{\s*([^{}|]+?)\s*(?:\|([^{}]*))?\}\}/g, (_m, key: string, fallback?: string) => {
    const full = TEMPLATE_SHORTHANDS[key] ?? key;
    return SAMPLE[full] ?? (fallback !== undefined ? fallback.trim() : `⟨${key}⟩`);
  });
}

export interface PreviewBubble {
  nodeId: string;
  kind: "bot" | "note";
  text: string;
  buttons: string[];
}

/** Walks the main path (first edge of each node) and returns the bot bubbles in order. */
export function previewWalk(graph: FlowGraph, limit = 25): PreviewBubble[] {
  const nodes = new Map(graph.nodes.map((n) => [n.id, n]));
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  const bubbles: PreviewBubble[] = [];
  const seen = new Set<string>();
  let current = trigger?.id ?? null;
  while (current && !seen.has(current) && bubbles.length < limit) {
    seen.add(current);
    const node = nodes.get(current);
    if (!node) break;
    if (node.type === "message") bubbles.push({ nodeId: node.id, kind: "bot", text: sampleRender(node.text), buttons: node.button ? [node.button.label] : [] });
    else if (node.type === "button") bubbles.push({ nodeId: node.id, kind: "bot", text: sampleRender(node.text), buttons: node.buttons.map((b) => b.label) });
    else if (node.type === "ai" && node.mode === "ask") bubbles.push({ nodeId: node.id, kind: "bot", text: sampleRender(node.question ?? ""), buttons: [] });
    else if (node.type === "ai") bubbles.push({ nodeId: node.id, kind: "note", text: node.intro ? sampleRender(node.intro) : "JavobAI suhbatni oladi", buttons: [] });
    else if (node.type === "lead" && node.thanks) bubbles.push({ nodeId: node.id, kind: "bot", text: sampleRender(node.thanks), buttons: [] });
    else if (node.type === "operator") bubbles.push({ nodeId: node.id, kind: node.reply ? "bot" : "note", text: node.reply ? sampleRender(node.reply) : "Operatorga topshirildi", buttons: [] });
    else if (node.type === "delay") bubbles.push({ nodeId: node.id, kind: "note", text: `⏱ ${describeNode(node)} kutiladi`, buttons: [] });
    else if (node.type === "condition") bubbles.push({ nodeId: node.id, kind: "note", text: `Shart: ${describeNode(node)}`, buttons: [] });
    const rule = handlesFor(node);
    const first = [...rule.required, ...rule.optional].find((h) => edgeTarget(graph, node.id, h));
    current = first ? edgeTarget(graph, node.id, first) : null;
  }
  return bubbles;
}
