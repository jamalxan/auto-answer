/**
 * ETAP 6 — Flow Builder graph schema (TZ 34–40; analysis §1.1).
 *
 * A flow is one immutable JSON graph on `FlowVersion`:
 *
 *   { v: 1, nodes: FlowNode[], edges: FlowEdge[], variables: [], layout? }
 *
 * Node types: trigger, message, button, ai, condition, delay, tag, lead,
 * webhook, crm, operator, action, end. Edges leave a node through a named
 * *handle* (`next`, `tap`, `tap:<buttonId>`, `other`, `timeout`,
 * `branch:<id>`, `else`, `missing`, `error`, `window_closed`, `fallback`);
 * which handles a node must / may have is declared by `handlesFor` (the
 * HANDLE_RULES table) and enforced here.
 *
 * Two schemas:
 *   - `flowGraphDraftSchema` — shape only (what a draft save accepts while
 *     the merchant is still editing; the auditor reports what is missing).
 *   - `flowGraphSchema` — shape + structural checks (what a publishable
 *     version, a template and an AI-generated graph must pass): exactly one
 *     trigger, unique ids, edges reference existing nodes and known handles,
 *     one edge per handle, every required handle present, a message with a
 *     button has no `next`, and the 24h-window rule for comment triggers (the
 *     first send is a message, nothing else is sent until its button is
 *     tapped; button / ai / lead / delay only after the window is open).
 *
 * Pure: no database, no Prisma import (the Flow tables do not exist yet).
 * User-facing messages are Uzbek Latin.
 */

import { z } from "zod";
import { COMMENT_LIMITS } from "@/lib/triggers/comment-limits";
import { flowFilterSchema } from "./conditions";

// ─── Vocabulary ───────────────────────────────────────────────────────────────

export const FLOW_SCHEMA_VERSION = 1 as const;

/** Decision 2 (2026-10-17): Story Reply V1 stays as it is; STORY_REPLY joins flows in ETAP 11. */
export const FLOW_TRIGGER_TYPES = ["COMMENT", "LIVE_COMMENT", "DIRECT_MESSAGE", "STORY_MENTION"] as const;
export type FlowTriggerType = (typeof FLOW_TRIGGER_TYPES)[number];

/** Triggers that arrive as a comment: the 24h window opens only when the opening button is tapped. */
export const COMMENT_TRIGGER_TYPES: ReadonlySet<FlowTriggerType> = new Set(["COMMENT", "LIVE_COMMENT"]);

export const FLOW_NODE_TYPES = [
  "trigger",
  "message",
  "button",
  "ai",
  "condition",
  "delay",
  "tag",
  "lead",
  "webhook",
  "crm",
  "operator",
  "action",
  "end",
] as const;
export type FlowNodeType = (typeof FLOW_NODE_TYPES)[number];

export const NODE_LABELS: Record<FlowNodeType, string> = {
  trigger: "Trigger",
  message: "Xabar",
  button: "Tugmalar",
  ai: "JavobAI",
  condition: "Shart",
  delay: "Kutish",
  tag: "Teg",
  lead: "Lead",
  webhook: "Webhook",
  crm: "CRM",
  operator: "Operator",
  action: "Amal",
  end: "Tugash",
};

export const TRIGGER_TYPE_LABELS: Record<FlowTriggerType, string> = {
  COMMENT: "Komment",
  LIVE_COMMENT: "Live komment",
  DIRECT_MESSAGE: "Direct xabar",
  STORY_MENTION: "Story'da belgilash",
};

export const FLOW_LIMITS = {
  nodeIdPattern: /^[a-z][a-z0-9_]{0,31}$/,
  nodes: 120,
  edges: 300,
  variables: 50,
  // Meta: DM text max 1000 characters.
  messageLength: COMMENT_LIMITS.messageLength,
  // Meta: a button template's text max 640 characters.
  buttonTemplateTextLength: COMMENT_LIMITS.buttonTemplateTextLength,
  // Meta: button / quick-reply title max 20 characters, max 13 quick replies.
  buttonLabelLength: COMMENT_LIMITS.buttonLabelLength,
  quickReplies: COMMENT_LIMITS.quickReplies,
  publicReplyLength: COMMENT_LIMITS.publicReplyLength,
  branches: 8,
  // 7 days: the longest a run may wait (max run age).
  delayMaxMinutes: 7 * 24 * 60,
  // Meta's 24h window minus the 5-minute margin used by lib/triggers/followups.
  windowMinutes: 24 * 60 - 5,
} as const;

// ─── Node schemas (analysis §1.1) ─────────────────────────────────────────────

const nodeId = z.string().regex(FLOW_LIMITS.nodeIdPattern, "Blok identifikatori: kichik lotin harf, raqam va _");
const varKey = z.string().regex(FLOW_LIMITS.nodeIdPattern, "O'zgaruvchi nomi: kichik lotin harf, raqam va _");
const text = (max: number) => z.string().min(1).max(max);
/** `{{var}}` allowed; keys are validated by the auditor (lib/flows/variables). */
const templateText = (max: number) => text(max);
const shortId = z.string().min(1).max(16);

export const triggerNodeSchema = z.object({
  id: nodeId,
  type: z.literal("trigger"),
  triggerType: z.enum(FLOW_TRIGGER_TYPES),
  // Exactly the TriggerCampaign matching fields, so the proxy row is a 1:1 copy.
  matchingMode: z.enum(["EVERY", "CONTAINS", "EXACT"]).default("CONTAINS"),
  keywords: z.array(z.string().max(COMMENT_LIMITS.keywordLength)).max(COMMENT_LIMITS.keywords).default([]),
  /** BUILT_IN_INTENTS keys. */
  intents: z.array(z.string()).default([]),
  mediaScope: z.enum(["ANY", "SPECIFIC"]).default("ANY"),
  mediaIds: z.array(z.string()).max(COMMENT_LIMITS.mediaIds).default([]),
  storyScope: z.enum(["ALL", "SPECIFIC"]).default("ALL"),
  storyIds: z.array(z.string()).default([]),
  audience: z.enum(["ANY", "NEW_CONTACT", "RETURNING_CONTACT", "REOPENED"]).default("ANY"),
  reopenAfterHours: z.number().int().min(1).max(720).default(72),
  cooldownHours: z.number().int().min(0).max(720).default(24),
  sourceFilter: z.enum(["ANY", "ADS", "LINK"]).default("ANY"),
  adIds: z.array(z.string()).default([]),
  refs: z.array(z.string()).default([]),
  priority: z.number().int().min(-100).max(100).default(0),
  /** COMMENT only: the public reply under the comment. */
  publicReply: templateText(FLOW_LIMITS.publicReplyLength).optional(),
});

export const messageNodeSchema = z.object({
  id: nodeId,
  type: z.literal("message"),
  text: templateText(FLOW_LIMITS.messageLength),
  // One postback button (button template, text ≤ 640). After a COMMENT
  // trigger this is the only way to open the 24h window; elsewhere optional.
  button: z.object({ label: text(FLOW_LIMITS.buttonLabelLength), id: shortId }).optional(),
  typingDelayMs: z.number().int().min(0).max(5000).default(0),
});

export const buttonNodeSchema = z.object({
  id: nodeId,
  type: z.literal("button"),
  text: templateText(FLOW_LIMITS.messageLength),
  buttons: z
    .array(
      z.object({
        id: shortId,
        label: text(FLOW_LIMITS.buttonLabelLength),
        /** phone → content_type user_phone_number → saves the shared number into vars.<saveAs>. */
        kind: z.enum(["text", "phone", "email"]).default("text"),
        /** vars.<key> = label (or the shared phone / email). */
        saveAs: varKey.optional(),
      })
    )
    .min(1)
    .max(FLOW_LIMITS.quickReplies),
  /** What a plain typed reply (not a tap) does. */
  onText: z.enum(["other_edge", "keep_waiting"]).default("other_edge"),
  /** Optional "no tap" edge after N minutes (the 24h window is still checked). */
  timeoutMinutes: z.number().int().min(1).max(FLOW_LIMITS.delayMaxMinutes).optional(),
});

export const aiNodeSchema = z.object({
  id: nodeId,
  type: z.literal("ai"),
  mode: z.enum(["takeover", "ask"]),
  /** takeover: JavobAI owns the thread from here; the run ends. */
  intro: templateText(FLOW_LIMITS.messageLength).optional(),
  /** ask: send `question`, wait for the answer, extract into vars.<saveAs>. */
  question: templateText(FLOW_LIMITS.messageLength).optional(),
  saveAs: varKey.optional(),
  extract: z.enum(["phone", "email", "name", "city", "product", "free_text", "yes_no", "number"]).optional(),
  retries: z.number().int().min(0).max(2).default(1),
  retryText: templateText(FLOW_LIMITS.messageLength).optional(),
});

export const conditionNodeSchema = z.object({
  id: nodeId,
  type: z.literal("condition"),
  branches: z
    .array(z.object({ id: shortId, label: z.string().max(40), when: flowFilterSchema }))
    .min(1)
    .max(FLOW_LIMITS.branches),
});

export const delayNodeSchema = z.object({
  id: nodeId,
  type: z.literal("delay"),
  minutes: z.number().int().min(1).max(FLOW_LIMITS.delayMaxMinutes),
  ifWindowClosed: z.enum(["end", "skip_sends", "wait_for_inbound"]).default("end"),
  /** = follow-up NO_REPLY semantics: a customer reply during the wait skips the sends. */
  cancelOnReply: z.boolean().default(false),
});

export const tagNodeSchema = z.object({
  id: nodeId,
  type: z.literal("tag"),
  action: z.enum(["add", "remove"]),
  tagSlugs: z.array(z.string().min(1).max(60)).min(1).max(10),
});

export const leadNodeSchema = z.object({
  id: nodeId,
  type: z.literal("lead"),
  /** Variable path holding the phone; empty at runtime → `missing` edge. */
  phoneFrom: z.string().min(1).max(40).default("vars.phone"),
  summary: templateText(300).optional(),
  thanks: templateText(FLOW_LIMITS.messageLength).optional(),
});

export const webhookNodeSchema = z.object({
  id: nodeId,
  type: z.literal("webhook"),
  url: z.string().url().max(500),
  method: z.enum(["POST"]).default("POST"),
  /** Values are templates. */
  body: z.record(z.string().max(64), z.string().max(500)).default({}),
  saveAs: varKey.optional(),
  /** JSON path of the response value to store. */
  savePath: z.string().max(100).optional(),
  timeoutMs: z.number().int().min(1000).max(10000).default(5000),
});

export const crmNodeSchema = z.object({
  id: nodeId,
  type: z.literal("crm"),
  action: z.enum(["move_stage", "create_deal", "assign", "set_field"]),
  stageId: z.string().optional(),
  pipelineId: z.string().optional(),
  assignStrategy: z.enum(["rules", "member"]).optional(),
  memberId: z.string().optional(),
  field: z.string().max(32).optional(),
  value: z.string().max(200).optional(),
});

export const operatorNodeSchema = z.object({
  id: nodeId,
  type: z.literal("operator"),
  reply: templateText(FLOW_LIMITS.messageLength).optional(),
  note: templateText(300).optional(),
  reason: z.enum(["wants_human", "complaint", "purchase_ready", "flow_rule"]).default("flow_rule"),
});

export const actionNodeSchema = z.object({
  id: nodeId,
  type: z.literal("action"),
  action: z.enum(["set_variable", "increment", "notify_telegram", "opt_out", "stop_followups", "mark_test"]),
  key: varKey.optional(),
  value: z.string().max(500).optional(),
  text: templateText(FLOW_LIMITS.messageLength).optional(),
});

export const endNodeSchema = z.object({ id: nodeId, type: z.literal("end"), reason: z.string().max(80).optional() });

export const flowNodeSchema = z.discriminatedUnion("type", [
  triggerNodeSchema,
  messageNodeSchema,
  buttonNodeSchema,
  aiNodeSchema,
  conditionNodeSchema,
  delayNodeSchema,
  tagNodeSchema,
  leadNodeSchema,
  webhookNodeSchema,
  crmNodeSchema,
  operatorNodeSchema,
  actionNodeSchema,
  endNodeSchema,
]);

export const flowEdgeSchema = z.object({
  from: nodeId,
  to: nodeId,
  /** Which output of `from`: next | tap | tap:<buttonId> | other | timeout | branch:<id> | else | missing | error | window_closed | fallback. */
  handle: z.string().min(1).max(40).default("next"),
});

export const flowVariableSchema = z.object({
  key: varKey,
  label: z.string().max(40),
  kind: z.enum(["string", "number", "boolean", "phone", "email"]),
});

/** Shape only — what a draft save accepts. The auditor reports structural gaps. */
export const flowGraphDraftSchema = z.object({
  v: z.literal(FLOW_SCHEMA_VERSION),
  nodes: z.array(flowNodeSchema).min(2).max(FLOW_LIMITS.nodes),
  edges: z.array(flowEdgeSchema).max(FLOW_LIMITS.edges),
  variables: z.array(flowVariableSchema).max(FLOW_LIMITS.variables).default([]),
  /** UI only, ignored by the engine. */
  layout: z.record(z.string(), z.object({ x: z.number(), y: z.number() })).optional(),
});

export type FlowGraph = z.infer<typeof flowGraphDraftSchema>;
export type FlowGraphInput = z.input<typeof flowGraphDraftSchema>;
export type FlowNode = z.infer<typeof flowNodeSchema>;
export type FlowNodeInput = z.input<typeof flowNodeSchema>;
export type FlowEdge = z.infer<typeof flowEdgeSchema>;
export type FlowVariable = z.infer<typeof flowVariableSchema>;
export type FlowNodeOf<T extends FlowNodeType> = Extract<FlowNode, { type: T }>;
export type TriggerNode = FlowNodeOf<"trigger">;
export type MessageNode = FlowNodeOf<"message">;
export type ButtonNode = FlowNodeOf<"button">;
export type AiNode = FlowNodeOf<"ai">;
export type ConditionNode = FlowNodeOf<"condition">;
export type DelayNode = FlowNodeOf<"delay">;

// ─── Handles ──────────────────────────────────────────────────────────────────

export interface HandleRule {
  /** Edges that must exist (dead-end otherwise). */
  required: string[];
  /** Edges that may exist. */
  optional: string[];
  /** Edges that must NOT exist. */
  forbidden: string[];
  /** The run ends here when no optional edge is taken (`end` not required after it). */
  terminal: boolean;
}

/**
 * Static part of the handle table (analysis §1.1). Per-node handles
 * (`tap:<id>`, `branch:<id>`, the message `button`) are added by `handlesFor`.
 */
export const HANDLE_RULES: Record<FlowNodeType, HandleRule> = {
  trigger: { required: ["next"], optional: [], forbidden: [], terminal: false },
  message: { required: ["next"], optional: [], forbidden: [], terminal: false },
  button: { required: ["other"], optional: ["timeout"], forbidden: ["next"], terminal: false },
  condition: { required: ["else"], optional: [], forbidden: ["next"], terminal: false },
  delay: { required: ["next"], optional: ["window_closed"], forbidden: [], terminal: false },
  ai: { required: [], optional: ["fallback"], forbidden: [], terminal: true },
  tag: { required: ["next"], optional: [], forbidden: [], terminal: false },
  lead: { required: ["next", "missing"], optional: [], forbidden: [], terminal: false },
  webhook: { required: ["next"], optional: ["error"], forbidden: [], terminal: false },
  crm: { required: ["next"], optional: ["error"], forbidden: [], terminal: false },
  operator: { required: [], optional: ["next"], forbidden: [], terminal: true },
  action: { required: ["next"], optional: [], forbidden: [], terminal: false },
  end: { required: [], optional: [], forbidden: ["next"], terminal: true },
};

/** The concrete handle rule of a node (button ids, branch ids, message button, ai mode applied). */
export function handlesFor(node: FlowNode): HandleRule {
  const base = HANDLE_RULES[node.type];
  switch (node.type) {
    case "message":
      return node.button
        ? { required: ["tap"], optional: [], forbidden: ["next"], terminal: false }
        : { ...base, forbidden: ["tap"] };
    case "button":
      return {
        required: [...node.buttons.map((b) => `tap:${b.id}`), ...base.required],
        optional: node.timeoutMinutes ? ["timeout"] : [],
        forbidden: node.timeoutMinutes ? base.forbidden : [...base.forbidden, "timeout"],
        terminal: false,
      };
    case "condition":
      return { ...base, required: [...node.branches.map((b) => `branch:${b.id}`), ...base.required] };
    case "ai":
      return node.mode === "ask"
        ? { required: ["next", "missing"], optional: [], forbidden: ["fallback"], terminal: false }
        : base;
    default:
      return base;
  }
}

export function isKnownHandle(node: FlowNode, handle: string): boolean {
  const rule = handlesFor(node);
  return rule.required.includes(handle) || rule.optional.includes(handle);
}

/** Handles whose traversal means the customer acted (tap / typed) — the 24h window is (re)opened. */
export function isUserInputHandle(node: FlowNode, handle: string): boolean {
  if (node.type === "message") return handle === "tap";
  if (node.type === "button") return handle === "other" || handle.startsWith("tap:");
  if (node.type === "ai" && node.mode === "ask") return handle === "next" || handle === "missing";
  return false;
}

/** Nodes at which the run parks and waits for the customer (tap or typed answer). */
export function isUserWaitNode(node: FlowNode): boolean {
  return node.type === "button" || (node.type === "ai" && node.mode === "ask") || (node.type === "message" && !!node.button);
}

/** Nodes that send a DM to the customer (the first send of a comment flow is the private reply). */
export function isSendNode(node: FlowNode): boolean {
  switch (node.type) {
    case "message":
    case "button":
      return true;
    case "ai":
      return node.mode === "ask" ? !!node.question : !!node.intro;
    case "lead":
      return !!node.thanks;
    case "operator":
      return !!node.reply;
    default:
      return false;
  }
}

/** The outgoing text of a send node, or null. */
export function sendText(node: FlowNode): string | null {
  switch (node.type) {
    case "message":
    case "button":
      return node.text;
    case "ai":
      return (node.mode === "ask" ? node.question : node.intro) ?? null;
    case "lead":
      return node.thanks ?? null;
    case "operator":
      return node.reply ?? null;
    default:
      return null;
  }
}

/** Every template text a node carries, with a field name for messages. */
export function templateFields(node: FlowNode): Array<{ field: string; text: string }> {
  const out: Array<{ field: string; text: string }> = [];
  const push = (field: string, value: string | undefined) => {
    if (value) out.push({ field, text: value });
  };
  switch (node.type) {
    case "trigger":
      push("publicReply", node.publicReply);
      break;
    case "message":
    case "button":
      push("text", node.text);
      break;
    case "ai":
      push("intro", node.intro);
      push("question", node.question);
      push("retryText", node.retryText);
      break;
    case "lead":
      push("summary", node.summary);
      push("thanks", node.thanks);
      break;
    case "webhook":
      for (const [key, value] of Object.entries(node.body)) push(`body.${key}`, value);
      break;
    case "operator":
      push("reply", node.reply);
      push("note", node.note);
      break;
    case "action":
      push("text", node.text);
      if (node.action === "set_variable") push("value", node.value);
      break;
    case "crm":
      push("value", node.value);
      break;
    default:
      break;
  }
  return out;
}

// ─── Structural checks ────────────────────────────────────────────────────────

type Issue = { path: (string | number)[]; message: string };

export const WINDOW_RULE_MESSAGE =
  "Komment oqimida avval tugmali xabar yuboriladi; tugma bosilmaguncha boshqa hech narsa yuborilmaydi (24 soatlik oyna yopiq)";

/**
 * The checks `flowGraphSchema` adds on top of the shape. Exported so the
 * auditor can list them for a draft (same messages) without throwing.
 */
export function structuralIssues(graph: FlowGraph): Issue[] {
  const issues: Issue[] = [];
  const byId = new Map<string, FlowNode>();
  const seen = new Set<string>();
  graph.nodes.forEach((node, index) => {
    if (seen.has(node.id)) {
      issues.push({ path: ["nodes", index, "id"], message: `Blok identifikatori takrorlangan: ${node.id}` });
    }
    seen.add(node.id);
    byId.set(node.id, node);
  });

  const triggers = graph.nodes.filter((n) => n.type === "trigger");
  if (triggers.length !== 1) {
    issues.push({ path: ["nodes"], message: "Oqimda aynan bitta trigger bloki bo'lishi kerak" });
  }

  const varKeys = new Set<string>();
  graph.variables.forEach((variable, index) => {
    if (varKeys.has(variable.key)) {
      issues.push({ path: ["variables", index, "key"], message: `O'zgaruvchi takrorlangan: ${variable.key}` });
    }
    varKeys.add(variable.key);
  });

  const edgesByFrom = new Map<string, Map<string, FlowEdge>>();
  graph.edges.forEach((edge, index) => {
    const from = byId.get(edge.from);
    const to = byId.get(edge.to);
    if (!from) issues.push({ path: ["edges", index, "from"], message: `Bog'lanish mavjud bo'lmagan blokdan chiqadi: ${edge.from}` });
    if (!to) issues.push({ path: ["edges", index, "to"], message: `Bog'lanish mavjud bo'lmagan blokka kiradi: ${edge.to}` });
    if (to?.type === "trigger") issues.push({ path: ["edges", index, "to"], message: "Trigger blokiga bog'lanish kiritib bo'lmaydi" });
    if (!from) return;
    const rule = handlesFor(from);
    if (rule.forbidden.includes(edge.handle)) {
      const why =
        from.type === "message" && edge.handle === "next"
          ? ` (tugmali xabardan keyin faqat "tap" — mijoz tugmani bosguncha davom etilmaydi)`
          : "";
      issues.push({ path: ["edges", index, "handle"], message: `«${from.id}» blokida "${edge.handle}" chiqishi taqiqlangan${why}` });
    } else if (!isKnownHandle(from, edge.handle)) {
      issues.push({ path: ["edges", index, "handle"], message: `«${from.id}» (${NODE_LABELS[from.type]}) blokida "${edge.handle}" chiqishi yo'q` });
    }
    let handles = edgesByFrom.get(edge.from);
    if (!handles) edgesByFrom.set(edge.from, (handles = new Map()));
    if (handles.has(edge.handle)) {
      issues.push({ path: ["edges", index], message: `«${from.id}» blokining "${edge.handle}" chiqishi ikki marta bog'langan` });
    }
    handles.set(edge.handle, edge);
  });

  graph.nodes.forEach((node, index) => {
    const handles = edgesByFrom.get(node.id);
    for (const handle of handlesFor(node).required) {
      if (!handles?.has(handle)) {
        issues.push({ path: ["nodes", index], message: `«${node.id}» (${NODE_LABELS[node.type]}) blokining "${handle}" chiqishi bog'lanmagan` });
      }
    }
  });

  // 24h-window rule for comment triggers (structural model: the window opens
  // when the opening button of a message is tapped).
  const trigger = triggers[0];
  if (triggers.length === 1 && COMMENT_TRIGGER_TYPES.has(trigger.triggerType)) {
    for (const violation of preWindowViolations(graph, byId, edgesByFrom)) {
      issues.push({ path: ["nodes", graph.nodes.findIndex((n) => n.id === violation.nodeId)], message: violation.message });
    }
  }
  return issues;
}

/**
 * Nodes reachable from a comment trigger before any `tap` of a message
 * button, that the window rule forbids there: a second send, or a node that
 * needs an open window (button / ai / lead / delay).
 */
function preWindowViolations(
  graph: FlowGraph,
  byId: Map<string, FlowNode>,
  edgesByFrom: Map<string, Map<string, FlowEdge>>
): Array<{ nodeId: string; message: string }> {
  const trigger = graph.nodes.find((n) => n.type === "trigger");
  if (!trigger) return [];
  const out = new Map<string, string>();
  const visited = new Set<string>();
  const stack: Array<{ id: string; sent: boolean }> = [{ id: trigger.id, sent: false }];
  while (stack.length) {
    const { id, sent } = stack.pop()!;
    const key = `${id}:${sent ? 1 : 0}`;
    if (visited.has(key)) continue;
    visited.add(key);
    const node = byId.get(id);
    if (!node) continue;
    let sentHere = sent;
    if (node.type === "button" || node.type === "ai" || node.type === "lead" || node.type === "delay") {
      out.set(id, `«${id}» (${NODE_LABELS[node.type]}) bloki oyna ochilmasdan turib ishlamaydi. ${WINDOW_RULE_MESSAGE}`);
      continue;
    }
    if (isSendNode(node)) {
      if (sent) {
        out.set(id, `«${id}» ikkinchi xabar sifatida yuborilmaydi: ${WINDOW_RULE_MESSAGE}`);
        continue;
      }
      sentHere = true;
    }
    for (const [handle, edge] of edgesByFrom.get(id) ?? []) {
      // A tap on the opening button opens the window: everything behind it is fine.
      if (node.type === "message" && handle === "tap") continue;
      stack.push({ id: edge.to, sent: sentHere });
    }
  }
  return [...out].map(([nodeId, message]) => ({ nodeId, message }));
}

/** Shape + structural checks: what a template, an AI graph and a publishable version must pass. */
export const flowGraphSchema = flowGraphDraftSchema.superRefine((graph, ctx) => {
  for (const issue of structuralIssues(graph)) {
    ctx.addIssue({ code: "custom", path: issue.path, message: issue.message });
  }
});

/** Parses untrusted JSON into a structurally valid graph; null when invalid. */
export function parseFlowGraph(input: unknown): FlowGraph | null {
  const parsed = flowGraphSchema.safeParse(input);
  return parsed.success ? parsed.data : null;
}

/** The single trigger node of a graph (null for a draft without one). */
export function triggerOf(graph: FlowGraph): TriggerNode | null {
  return graph.nodes.find((n): n is TriggerNode => n.type === "trigger") ?? null;
}

/** Zod issues → one Uzbek line each ("nodes.3: ..."). */
export function formatIssues(error: z.ZodError): string[] {
  return error.issues.map((issue) => (issue.path.length ? `${issue.path.join(".")}: ${issue.message}` : issue.message));
}
