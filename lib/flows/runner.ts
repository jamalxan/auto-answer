/**
 * ETAP 6 — the flow step loop (analysis §2.2, §2.4). PURE: no database, no
 * Redis, no Meta client. Every side effect goes through the `FlowEffects`
 * port, so the same loop runs in production (effects.ts: Prisma, Meta,
 * JavobAI, CRM), in the sandbox / test console and in the unit tests
 * (effects-memory.ts). Node logic is written once, here.
 *
 *   advance(run, index, fx, signal?)
 *     signal  → apply it to the node the run is waiting at (tap / typed
 *               answer / timer), commit that transition as one step
 *     loop    → execute the current node, commit one step (FlowRunStep) and
 *               follow the edge; a node may park the run (WAITING_*) or end it
 *
 * Concurrency: `fx.commit(prev, next, step)` is a compare-and-swap on the
 * run's `seq` (and status ACTIVE). Losing it means another worker moved the
 * run — the loop stops quietly (`lost`). Idempotency of the sends is the
 * port's: a send is keyed by (run, seq of the step being committed).
 *
 * Guards: total steps per run (200), visits per node (20), run age (7 days),
 * consecutive sends without an answer (policy cap), the 24h window before
 * EVERY send that is not a comment's first private reply.
 */

import { extractPhone, parsePhone } from "@/lib/leads/phone";
import { evaluateBranches } from "./conditions";
import { buildIndex, type FlowIndex } from "./graph";
import { SPAM_BLOCKED_SENDS } from "./policy";
import {
  COMMENT_TRIGGER_TYPES,
  FLOW_LIMITS,
  NODE_LABELS,
  type ButtonNode,
  type DelayNode,
  type FlowGraph,
  type FlowNode,
  type FlowTriggerType,
  type MessageNode,
} from "./schema";
import { renderTemplate, resolveVariable, type FlowContext } from "./variables";

// ─── Limits and reasons ───────────────────────────────────────────────────────

export const MAX_STEPS_PER_RUN = 200;
export const MAX_NODE_VISITS = 20;
export const MAX_RUN_AGE_MS = 7 * 24 * 3600_000;
export const MAX_STEPS_PER_ADVANCE = 100;
/** Retryable failures (Meta limit, network, our own error) wait and try again this many times. */
export const MAX_NODE_RETRIES = 5;
/** Wait before retry n (0-based): 30s, 2m, 10m, 30m, 60m. */
export const RETRY_BACKOFF_MS = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];

/** Meta's 24h window minus the 5-minute margin (same rule as lib/triggers/followups isWindowOpen). */
const WINDOW_MS = FLOW_LIMITS.windowMinutes * 60_000;

export const REASONS = {
  windowClosed: "24 soatlik oyna yopilgan — mijoz yozmaguncha xabar yuborilmaydi.",
  stepLimit: `Qadamlar soni chegaradan oshdi (${MAX_STEPS_PER_RUN}) — oqim to'xtatildi.`,
  visitLimit: (id: string) => `«${id}» bloki ${MAX_NODE_VISITS} martadan ko'p takrorlandi — cheksiz sikl to'xtatildi.`,
  tooOld: "Oqim muddati tugadi (7 kun) — bekor qilindi.",
  spam: "Spam himoyasi: javobsiz ketma-ket xabarlar chegarasiga yetildi — oqim to'xtatildi.",
  deadEnd: "Davomi yo'q — oqim tugadi.",
  noNode: (id: string | null) => `Blok topilmadi: ${id ?? "-"}`,
  emptyText: "Matn bo'sh — yuborilmadi.",
  replied: "Mijoz javob yozdi — keyingi xabarlar bekor qilindi.",
  takeover: "JavobAI'ga o'tkazildi",
  operator: "Operatorga o'tkazildi",
  operatorNoAi: "Operatorga o'tkazildi (JavobAI yoqilmagan)",
  ended: "Oqim tugadi",
  retryExhausted: (reason: string) => `Qayta urinishlar tugadi: ${reason}`,
  internal: (message: string) => `Ichki xatolik: ${message}`.slice(0, 300),
} as const;

// ─── Types ────────────────────────────────────────────────────────────────────

export type RunStatusName = "ACTIVE" | "WAITING_TAP" | "WAITING_INBOUND" | "WAITING_DELAY" | "DONE" | "FAILED" | "CANCELLED";
export const TERMINAL_STATUSES: ReadonlySet<RunStatusName> = new Set(["DONE", "FAILED", "CANCELLED"]);

/**
 * What the run waits for:
 *   tap     the button of a message (plain text is NOT consumed)
 *   choice  the chips of a button node (typed text is consumed: other / keep waiting)
 *   phone   chips that include a phone chip (a typed or shared number is the tap)
 *   inbound an AI ask answer
 *   reopen  window closed → the customer's next message reopens it, the pending send then goes out
 *   delay   Delay node
 *   retry   a retryable failure waits to try the same node again
 */
export type WaitKind = "tap" | "choice" | "phone" | "inbound" | "reopen" | "delay" | "retry";

export interface FlowRunState {
  id: string;
  status: RunStatusName;
  triggerType: FlowTriggerType;
  currentNodeId: string | null;
  /** Monotonic step counter = the optimistic-concurrency token. */
  seq: number;
  /** Customer-visible variables plus internal "__" keys (visits, first send, delay anchors...). */
  vars: Record<string, unknown>;
  waitNodeId: string | null;
  waitKind: WaitKind | null;
  waitUntil: Date | null;
  sendsSinceInbound: number;
  startedAt: Date;
  endReason: string | null;
  lastError: string | null;
  isTest: boolean;
}

export type RunSignal =
  | { kind: "tap"; nodeId: string; buttonId: string; eventId: string; at: Date; text?: string }
  | { kind: "inbound"; text: string; eventId: string; at: Date }
  | { kind: "timer" };

export interface StepRecord {
  nodeId: string;
  nodeType: string;
  status: "DONE" | "SKIPPED" | "FAILED" | "WAITING";
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  reason?: string;
}

export interface SendRef {
  nodeId: string;
  /** The seq the step being executed will be committed with: the idempotency key of the send. */
  seq: number;
  /** The first send of a comment run: a private reply to the comment, no window needed. */
  first: boolean;
}

export type SendOutcome =
  | { ok: true; mid?: string | null; interrupted?: boolean }
  | { ok: false; retryable: boolean; reason: string; technical?: string };

export interface Chip {
  id: string;
  label: string;
  kind: "text" | "phone" | "email";
}

export interface EffectResult {
  ok: boolean;
  /** Not done by design (module missing, nothing to do): the step is SKIPPED, the flow goes on. */
  skipped?: boolean;
  reason?: string;
}

export interface WebhookResult {
  ok: boolean;
  status?: number;
  json?: unknown;
  error?: string;
}

export interface WindowAnchors {
  openedAt: Date | null;
  lastInboundAt: Date | null;
}

/** Everything the loop needs from the outside world (analysis §2.4). */
export interface FlowEffects {
  now(): Date;
  /** The customer's last sign of life (24h window anchors). */
  window(run: FlowRunState): Promise<WindowAnchors>;
  /** The customer wrote / tapped at `at`: moves lastInboundAt forward, `open` also sets openedAt. */
  touchInbound(run: FlowRunState, at: Date, info: { open: boolean; text?: string }): Promise<void>;
  /** contact / tags / score / temperature / audience / last_message of the customer. */
  context(run: FlowRunState): Promise<FlowContext>;
  /** Persist one step and the new run state. False = another worker moved the run first (nothing written). */
  commit(prev: FlowRunState, next: FlowRunState, step: StepRecord): Promise<boolean>;

  publicReply(run: FlowRunState, text: string): Promise<void>;
  sendText(run: FlowRunState, ref: SendRef, text: string): Promise<SendOutcome>;
  sendButton(run: FlowRunState, ref: SendRef, text: string, button: { id: string; label: string }): Promise<SendOutcome>;
  sendChips(run: FlowRunState, ref: SendRef, text: string, chips: Chip[]): Promise<SendOutcome>;

  tag(run: FlowRunState, action: "add" | "remove", slugs: string[]): Promise<EffectResult>;
  lead(run: FlowRunState, input: { phoneE164: string; phoneRaw: string; summary: string | null }): Promise<EffectResult>;
  crm(run: FlowRunState, node: Extract<FlowNode, { type: "crm" }>, ctx: FlowContext): Promise<EffectResult>;
  operator(run: FlowRunState, input: { note: string | null; reason: string }): Promise<EffectResult>;
  notify(run: FlowRunState, text: string): Promise<EffectResult>;
  webhook(run: FlowRunState, node: Extract<FlowNode, { type: "webhook" }>, body: Record<string, unknown>): Promise<WebhookResult>;
  /** JavobAI takes the thread (LIVE accounts only); `not_live` otherwise. */
  aiTakeover(run: FlowRunState, node: Extract<FlowNode, { type: "ai" }>, text: string | null): Promise<{ ok: true } | { ok: false; reason: "not_live" | string }>;
  /** name / city / product from a free answer (small LLM call); null = nothing usable. */
  aiExtract(run: FlowRunState, node: Extract<FlowNode, { type: "ai" }>, text: string): Promise<string | null>;
  optOut(run: FlowRunState): Promise<EffectResult>;
  stopFollowups(run: FlowRunState): Promise<EffectResult>;
  /** Final failure worth an operational log line. */
  reportFailure(run: FlowRunState, reason: string): Promise<void>;
}

export interface AdvanceResult {
  status: RunStatusName;
  steps: number;
  sends: number;
  /** Another worker moved the run: this call did nothing more. */
  lost: boolean;
}

// ─── Small helpers ────────────────────────────────────────────────────────────

/** Variables the customer-facing vocabulary sees (internal "__" keys hidden). */
export function publicVars(vars: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(vars)) if (!key.startsWith("__")) out[key] = value;
  return out;
}

function obj(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

export function isWindowOpenAt(anchors: WindowAnchors, now: Date): boolean {
  const times = [anchors.openedAt, anchors.lastInboundAt].filter((d): d is Date => d instanceof Date).map((d) => d.getTime());
  if (times.length === 0) return false;
  return now.getTime() - Math.max(...times) < WINDOW_MS;
}

/** Asia/Tashkent (UTC+5, no DST): hour 0–23 and ISO weekday (1 = Monday). */
function tashkentTime(now: Date): { hour: number; weekday: number } {
  const local = new Date(now.getTime() + 5 * 3600_000);
  const day = local.getUTCDay();
  return { hour: local.getUTCHours(), weekday: day === 0 ? 7 : day };
}

function clip(text: string, max = 300): string {
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** Dotted path into a parsed JSON response ("data.price", "items.0.name"). */
export function valueAtPath(json: unknown, path: string): unknown {
  let current: unknown = json;
  for (const part of path.split(".").filter(Boolean)) {
    if (current === null || current === undefined || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

// ─── Answer extraction (code first, LLM only for free-form fields) ─────────────

const EMAIL = /[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i;
const YES = /^(ha|xa|ha[, ]|albatta|bor|da|yes|y|ok|okey|oke|mayli|xo['‘’`ʻ]?p|да|ага|конечно|угу)(\b|$)/i;
const NO = /^(yo['‘’`ʻ]?q|yoq|kerak\s?emas|kerakmas|no|n|net|нет|не)(\b|$)/i;

/** Extraction that needs no model; undefined = this extract kind needs the LLM (or free text). */
export function extractByCode(extract: string | undefined, text: string): string | null | undefined {
  const clean = text.trim();
  switch (extract) {
    case "phone":
      return extractPhone(clean)?.e164 ?? null;
    case "email":
      return clean.match(EMAIL)?.[0]?.toLowerCase() ?? null;
    case "number": {
      const match = clean.match(/-?\d[\d\s]*(?:[.,]\d+)?/);
      if (!match) return null;
      const value = Number(match[0].replace(/\s+/g, "").replace(",", "."));
      return Number.isFinite(value) ? String(value) : null;
    }
    case "yes_no":
      if (YES.test(clean)) return "ha";
      if (NO.test(clean)) return "yo'q";
      return null;
    case "name":
    case "city":
    case "product":
      return undefined;
    default:
      // free_text / unspecified: the answer itself
      return clean ? clean.slice(0, 300) : null;
  }
}

// ─── Node results ─────────────────────────────────────────────────────────────

interface NodeResult {
  step: StepRecord;
  /** Edge handle to follow. */
  handle?: string;
  /** Go to this node instead of following an edge (re-execute after a wait). */
  goto?: string;
  wait?: { status: "WAITING_TAP" | "WAITING_INBOUND" | "WAITING_DELAY"; kind: WaitKind; until?: Date | null };
  end?: { status: "DONE" | "FAILED" | "CANCELLED"; reason: string };
  /** Merged into run.vars. */
  vars?: Record<string, unknown>;
  /** Messages sent by this step. */
  sent?: number;
  /** The customer acted: the consecutive-sends counter restarts. */
  resetSends?: boolean;
  isTest?: boolean;
}

interface Env {
  run: FlowRunState;
  index: FlowIndex;
  fx: FlowEffects;
  now: Date;
  ctx(): Promise<FlowContext>;
  invalidate(): void;
}

function makeEnv(run: FlowRunState, index: FlowIndex, fx: FlowEffects): Env {
  let cached: FlowContext | null = null;
  const env: Env = {
    run,
    index,
    fx,
    now: fx.now(),
    async ctx() {
      if (cached) return cached;
      const base = await fx.context(run);
      const anchors = await fx.window(run);
      const trigger = obj(run.vars.__trigger);
      const last = obj(run.vars.__last);
      const time = tashkentTime(fx.now());
      cached = {
        ...base,
        vars: publicVars(run.vars),
        trigger: { ...base.trigger, ...(trigger as FlowContext["trigger"]) },
        audience: (trigger.audience as string | undefined) ?? base.audience ?? null,
        last_message: Object.keys(last).length ? (last as FlowContext["last_message"]) : base.last_message,
        window: { open: isWindowOpenAt(anchors, fx.now()) },
        time,
        run: { sends: Number(run.vars.__sends) || 0 },
      };
      return cached;
    },
    invalidate() {
      cached = null;
    },
  };
  return env;
}

const step = (node: FlowNode, status: StepRecord["status"], extra: Partial<StepRecord> = {}): StepRecord => ({
  nodeId: node.id,
  nodeType: node.type,
  status,
  ...extra,
});

function endResult(node: FlowNode, status: "DONE" | "FAILED" | "CANCELLED", reason: string, stepStatus: StepRecord["status"] = "DONE", extra: Partial<NodeResult> = {}): NodeResult {
  return { step: step(node, stepStatus, { reason }), end: { status, reason }, ...extra };
}

function hasEdge(e: Env, nodeId: string, handle: string): boolean {
  return e.index.edgeOf(nodeId, handle) !== null;
}

/** First of the handles that is connected, else the last one (the caller's default). */
function pickHandle(e: Env, nodeId: string, ...handles: string[]): string {
  return handles.find((h) => hasEdge(e, nodeId, h)) ?? handles[handles.length - 1];
}

function isFirstCommentSend(run: FlowRunState, node: FlowNode): boolean {
  return node.type === "message" && COMMENT_TRIGGER_TYPES.has(run.triggerType) && run.vars.__firstSent !== true;
}

// ─── Sending ──────────────────────────────────────────────────────────────────

type PreSend = { block: NodeResult } | { skip: string } | null;

/** Spam counter and 24h window, before every send (a comment's first private reply needs no window). */
async function preSend(e: Env, node: FlowNode): Promise<PreSend> {
  const { run } = e;
  if (run.sendsSinceInbound >= SPAM_BLOCKED_SENDS) {
    return { block: endResult(node, "CANCELLED", REASONS.spam, "SKIPPED") };
  }
  if (isFirstCommentSend(run, node)) return null;

  if (isWindowOpenAt(await e.fx.window(run), e.now)) return null;

  // The window is closed: the policy of the Delay node the run last passed.
  const delayId = typeof run.vars.__lastDelay === "string" ? run.vars.__lastDelay : null;
  const delay = delayId ? e.index.nodes.get(delayId) : null;
  const policy = delay?.type === "delay" ? delay.ifWindowClosed : "end";
  if (policy === "skip_sends") return { skip: REASONS.windowClosed };
  if (policy === "wait_for_inbound") {
    return {
      block: {
        step: step(node, "WAITING", { reason: REASONS.windowClosed }),
        wait: { status: "WAITING_INBOUND", kind: "reopen" },
      },
    };
  }
  return { block: endResult(node, "DONE", REASONS.windowClosed, "SKIPPED") };
}

function retryDelayMs(attempt: number): number {
  return RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)];
}

/** A failed send / effect: wait and retry the same node, or give up for good. */
async function failureResult(e: Env, node: FlowNode, reason: string, retryable: boolean, technical?: string): Promise<NodeResult> {
  const retries = obj(e.run.vars.__retries);
  const attempt = Number(retries[node.id]) || 0;
  if (retryable && attempt < MAX_NODE_RETRIES) {
    return {
      step: step(node, "WAITING", { reason: `Qayta urinish ${attempt + 1}/${MAX_NODE_RETRIES}: ${reason}` }),
      wait: { status: "WAITING_DELAY", kind: "retry", until: new Date(e.now.getTime() + retryDelayMs(attempt)) },
      vars: { __retries: { ...retries, [node.id]: attempt + 1 } },
    };
  }
  const final = retryable ? REASONS.retryExhausted(reason) : reason;
  await e.fx.reportFailure(e.run, technical ? `${final} (${technical})` : final).catch(() => {});
  return endResult(node, "FAILED", final, "FAILED");
}

async function sendOf(
  e: Env,
  node: FlowNode,
  kind: "text" | "button" | "chips",
  text: string,
  extra?: { button?: { id: string; label: string }; chips?: Chip[] }
): Promise<{ ok: true; first: boolean } | { ok: false; result: NodeResult }> {
  const ref: SendRef = { nodeId: node.id, seq: e.run.seq + 1, first: isFirstCommentSend(e.run, node) };
  const out =
    kind === "button"
      ? await e.fx.sendButton(e.run, ref, text, extra!.button!)
      : kind === "chips"
        ? await e.fx.sendChips(e.run, ref, text, extra!.chips!)
        : await e.fx.sendText(e.run, ref, text);
  if (!out.ok) return { ok: false, result: await failureResult(e, node, out.reason, out.retryable, out.technical) };
  return { ok: true, first: ref.first };
}

// ─── Node executors ───────────────────────────────────────────────────────────

async function execMessage(e: Env, node: MessageNode): Promise<NodeResult> {
  const ctx = await e.ctx();
  const rendered = renderTemplate(node.text, ctx);
  if (!rendered.text) {
    // A message that waits for its button cannot go on without text.
    if (node.button) return endResult(node, "DONE", REASONS.emptyText, "SKIPPED");
    return { step: step(node, "SKIPPED", { reason: REASONS.emptyText }), handle: "next" };
  }

  const pre = await preSend(e, node);
  if (pre && "block" in pre) return pre.block;
  if (pre && "skip" in pre) {
    // Nothing was sent: a message that waits for its button cannot go on.
    if (node.button) return endResult(node, "DONE", pre.skip, "SKIPPED");
    return { step: step(node, "SKIPPED", { input: { text: clip(rendered.text) }, reason: pre.skip }), handle: "next" };
  }

  const sent = node.button
    ? await sendOf(e, node, "button", rendered.text, { button: { id: node.button.id, label: node.button.label } })
    : await sendOf(e, node, "text", rendered.text);
  if (!sent.ok) return sent.result;

  const base: Partial<NodeResult> = {
    sent: 1,
    vars: { __firstSent: true, __sends: (Number(e.run.vars.__sends) || 0) + 1 },
  };
  const input = { text: clip(rendered.text), ...(rendered.missing.length ? { missing: rendered.missing } : {}), ...(sent.first ? { privateReply: true } : {}) };
  if (node.button) {
    return { ...base, step: step(node, "WAITING", { input: { ...input, button: node.button.id } }), wait: { status: "WAITING_TAP", kind: "tap" } };
  }
  return { ...base, step: step(node, "DONE", { input }), handle: "next" };
}

async function execButton(e: Env, node: ButtonNode): Promise<NodeResult> {
  const ctx = await e.ctx();
  const rendered = renderTemplate(node.text, ctx);
  if (!rendered.text) return endResult(node, "DONE", REASONS.emptyText, "SKIPPED");

  const pre = await preSend(e, node);
  if (pre && "block" in pre) return pre.block;
  if (pre && "skip" in pre) return endResult(node, "DONE", pre.skip, "SKIPPED");

  const chips: Chip[] = node.buttons.map((b) => ({ id: b.id, label: b.label, kind: b.kind }));
  const sent = await sendOf(e, node, "chips", rendered.text, { chips });
  if (!sent.ok) return sent.result;

  const kind: WaitKind = node.buttons.some((b) => b.kind === "phone") ? "phone" : "choice";
  const until = node.timeoutMinutes ? new Date(e.now.getTime() + node.timeoutMinutes * 60_000) : null;
  return {
    step: step(node, "WAITING", { input: { text: clip(rendered.text), buttons: node.buttons.map((b) => b.id) } }),
    wait: { status: "WAITING_TAP", kind, until },
    sent: 1,
    vars: { __sends: (Number(e.run.vars.__sends) || 0) + 1 },
  };
}

async function execDelay(e: Env, node: DelayNode): Promise<NodeResult> {
  const until = new Date(e.now.getTime() + node.minutes * 60_000);
  return {
    step: step(node, "WAITING", { output: { until: until.toISOString() } }),
    wait: { status: "WAITING_DELAY", kind: "delay", until },
    vars: { __waitStart: e.now.toISOString(), __lastDelay: node.id },
  };
}

async function execAi(e: Env, node: Extract<FlowNode, { type: "ai" }>): Promise<NodeResult> {
  const ctx = await e.ctx();
  if (node.mode === "takeover") {
    const intro = node.intro ? renderTemplate(node.intro, ctx).text : "";
    let sent = 0;
    let sendVars: Record<string, unknown> | undefined;
    if (intro) {
      const pre = await preSend(e, node);
      if (pre && "block" in pre) return pre.block;
      if (!pre) {
        const out = await sendOf(e, node, "text", intro);
        if (!out.ok) return out.result;
        sent = 1;
        sendVars = { __sends: (Number(e.run.vars.__sends) || 0) + 1 };
      }
    }
    const result = await e.fx.aiTakeover(e.run, node, intro || null);
    if (result.ok) {
      return endResult(node, "DONE", REASONS.takeover, "DONE", { sent, vars: sendVars });
    }
    if (hasEdge(e, node.id, "fallback")) {
      return { step: step(node, "SKIPPED", { reason: "JavobAI yoqilmagan — zaxira yo'li" }), handle: "fallback", sent, vars: sendVars };
    }
    const handoff = await e.fx.operator(e.run, { note: "JavobAI yoqilmagan, oqim operatorga o'tkazdi", reason: "flow_rule" });
    return endResult(node, "DONE", handoff.ok ? REASONS.operatorNoAi : REASONS.operator, "SKIPPED", { sent, vars: sendVars });
  }

  // ask
  const question = node.question ? renderTemplate(node.question, ctx).text : "";
  if (!question) return { step: step(node, "SKIPPED", { reason: REASONS.emptyText }), handle: "missing" };
  const pre = await preSend(e, node);
  if (pre && "block" in pre) return pre.block;
  if (pre && "skip" in pre) return { step: step(node, "SKIPPED", { reason: pre.skip }), handle: "missing" };
  const out = await sendOf(e, node, "text", question);
  if (!out.ok) return out.result;
  const asks = obj(e.run.vars.__asks);
  return {
    step: step(node, "WAITING", { input: { question: clip(question), extract: node.extract ?? "free_text" } }),
    wait: { status: "WAITING_INBOUND", kind: "inbound" },
    sent: 1,
    vars: { __sends: (Number(e.run.vars.__sends) || 0) + 1, __asks: { ...asks, [node.id]: 1 } },
  };
}

/** Sends the optional text of a lead / operator node; nothing is sent when blocked, never fails the node. */
async function sendOptional(e: Env, node: FlowNode, template: string | undefined): Promise<{ sent: number; vars?: Record<string, unknown>; block?: NodeResult; reason?: string }> {
  if (!template) return { sent: 0 };
  const text = renderTemplate(template, await e.ctx()).text;
  if (!text) return { sent: 0 };
  const pre = await preSend(e, node);
  if (pre && "block" in pre) {
    // Spam / window-end must not swallow the node's real work (lead, handoff): skip the text only.
    return { sent: 0, reason: pre.block.step.reason };
  }
  if (pre && "skip" in pre) return { sent: 0, reason: pre.skip };
  const out = await sendOf(e, node, "text", text);
  if (!out.ok) return { sent: 0, reason: out.result.step.reason };
  return { sent: 1, vars: { __sends: (Number(e.run.vars.__sends) || 0) + 1 } };
}

async function execNode(e: Env, node: FlowNode): Promise<NodeResult> {
  const { run, fx } = e;
  switch (node.type) {
    case "trigger": {
      if (node.publicReply && run.triggerType === "COMMENT") {
        const text = renderTemplate(node.publicReply, await e.ctx()).text;
        if (text) await fx.publicReply(run, text);
      }
      return { step: step(node, "DONE"), handle: "next" };
    }
    case "message":
      return execMessage(e, node);
    case "button":
      return execButton(e, node);
    case "condition": {
      const ctx = await e.ctx();
      const branch = evaluateBranches(node, ctx);
      const handle = branch === "else" ? "else" : `branch:${branch}`;
      return { step: step(node, "DONE", { output: { branch, handle } }), handle };
    }
    case "delay":
      return execDelay(e, node);
    case "tag": {
      const result = await fx.tag(run, node.action, node.tagSlugs);
      e.invalidate();
      if (result.skipped) return { step: step(node, "SKIPPED", { reason: result.reason }), handle: "next" };
      if (!result.ok) return { step: step(node, "FAILED", { reason: result.reason ?? "Teg qo'yilmadi" }), handle: "next" };
      return { step: step(node, "DONE", { output: { action: node.action, tags: node.tagSlugs } }), handle: "next" };
    }
    case "lead": {
      const ctx = await e.ctx();
      const raw = resolveVariable(node.phoneFrom, ctx);
      const phone = typeof raw === "string" || typeof raw === "number" ? parsePhone(String(raw)) : null;
      if (!phone) return { step: step(node, "SKIPPED", { reason: "Telefon raqami yo'q — lead yaratilmadi" }), handle: "missing" };
      const summary = node.summary ? renderTemplate(node.summary, ctx).text : null;
      const result = await fx.lead(run, { phoneE164: phone.e164, phoneRaw: phone.raw, summary });
      e.invalidate();
      if (!result.ok) return failureResult(e, node, result.reason ?? "Lead yaratilmadi", true);
      const thanks = await sendOptional(e, node, node.thanks);
      return {
        step: step(node, "DONE", { output: { phone: phone.e164, ...(thanks.reason ? { thanksSkipped: thanks.reason } : {}) } }),
        handle: "next",
        sent: thanks.sent,
        vars: { phone: phone.e164, ...(thanks.vars ?? {}) },
      };
    }
    case "webhook": {
      const ctx = await e.ctx();
      const body: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(node.body)) body[key] = renderTemplate(value, ctx).text;
      const result = await fx.webhook(run, node, body);
      if (result.ok) {
        const vars: Record<string, unknown> = {};
        if (node.saveAs && node.savePath) {
          const value = valueAtPath(result.json, node.savePath);
          if (value !== undefined && value !== null) vars[node.saveAs] = typeof value === "object" ? JSON.stringify(value) : value;
        }
        e.invalidate();
        return { step: step(node, "DONE", { output: { status: result.status, saved: Object.keys(vars) } }), handle: "next", vars };
      }
      const handle = pickHandle(e, node.id, "error", "next");
      return { step: step(node, "FAILED", { output: { status: result.status ?? null }, reason: result.error ?? "Webhook javob bermadi" }), handle };
    }
    case "crm": {
      const result = await fx.crm(run, node, await e.ctx());
      e.invalidate();
      if (result.skipped) return { step: step(node, "SKIPPED", { reason: result.reason }), handle: "next" };
      if (!result.ok) return { step: step(node, "FAILED", { reason: result.reason ?? "CRM amali bajarilmadi" }), handle: pickHandle(e, node.id, "error", "next") };
      return { step: step(node, "DONE", { output: { action: node.action } }), handle: "next" };
    }
    case "operator": {
      const ctx = await e.ctx();
      const note = node.note ? renderTemplate(node.note, ctx).text : null;
      const reply = await sendOptional(e, node, node.reply);
      const result = await fx.operator(run, { note, reason: node.reason });
      const out: Partial<NodeResult> = { sent: reply.sent, vars: reply.vars };
      const detail = { ...(reply.reason ? { replySkipped: reply.reason } : {}), reason: node.reason };
      if (hasEdge(e, node.id, "next")) {
        return { ...out, step: step(node, result.ok ? "DONE" : "FAILED", { output: detail, reason: result.reason }), handle: "next" };
      }
      return { ...out, step: step(node, result.ok ? "DONE" : "FAILED", { output: detail, reason: REASONS.operator }), end: { status: "DONE", reason: REASONS.operator } };
    }
    case "action":
      return execAction(e, node);
    case "ai":
      return execAi(e, node);
    case "end":
      return endResult(node, "DONE", node.reason ?? REASONS.ended);
  }
}

async function execAction(e: Env, node: Extract<FlowNode, { type: "action" }>): Promise<NodeResult> {
  const { run, fx } = e;
  const ctx = await e.ctx();
  const done = (extra: Partial<NodeResult> = {}, output?: Record<string, unknown>): NodeResult => ({ step: step(node, "DONE", { output }), handle: "next", ...extra });
  switch (node.action) {
    case "set_variable": {
      if (!node.key) return { step: step(node, "SKIPPED", { reason: "O'zgaruvchi nomi ko'rsatilmagan" }), handle: "next" };
      const value = renderTemplate(node.value ?? "", ctx).text;
      e.invalidate();
      return done({ vars: { [node.key]: value } }, { key: node.key, value: clip(value, 100) });
    }
    case "increment": {
      if (!node.key) return { step: step(node, "SKIPPED", { reason: "O'zgaruvchi nomi ko'rsatilmagan" }), handle: "next" };
      const by = Number(renderTemplate(node.value ?? "1", ctx).text) || 1;
      const next = (Number(run.vars[node.key]) || 0) + by;
      e.invalidate();
      return done({ vars: { [node.key]: next } }, { key: node.key, value: next });
    }
    case "notify_telegram": {
      const text = renderTemplate(node.text ?? "", ctx).text;
      if (!text) return { step: step(node, "SKIPPED", { reason: REASONS.emptyText }), handle: "next" };
      const result = await fx.notify(run, text);
      if (!result.ok) return { step: step(node, "FAILED", { reason: result.reason ?? "Telegramga yuborilmadi" }), handle: "next" };
      return done({}, { text: clip(text, 100) });
    }
    case "opt_out": {
      const result = await fx.optOut(run);
      return result.ok ? done() : { step: step(node, "FAILED", { reason: result.reason }), handle: "next" };
    }
    case "stop_followups": {
      const result = await fx.stopFollowups(run);
      return result.ok ? done() : { step: step(node, "FAILED", { reason: result.reason }), handle: "next" };
    }
    case "mark_test":
      return done({ isTest: true, vars: { __test: true } });
  }
}

async function executeSafely(e: Env, node: FlowNode): Promise<NodeResult> {
  try {
    return await execNode(e, node);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[Flows] ${e.run.id} node ${node.id} (${NODE_LABELS[node.type]}) failed:`, message);
    return failureResult(e, node, REASONS.internal(message), true, message);
  }
}

// ─── Signals ──────────────────────────────────────────────────────────────────

export type SignalPlan = { kind: "apply" } | { kind: "ignore"; reason: string; touch?: boolean };

/**
 * Pure: should this signal move the run? `ignore` leaves the run untouched
 * (the caller may still keep the 24h window open with `touch`).
 */
export function planSignal(run: FlowRunState, index: FlowIndex, signal: RunSignal, now: Date): SignalPlan {
  if (TERMINAL_STATUSES.has(run.status)) return { kind: "ignore", reason: "Oqim allaqachon tugagan" };
  const node = run.waitNodeId ? index.nodes.get(run.waitNodeId) : undefined;

  if (signal.kind === "timer") {
    if (!run.waitNodeId || !node) return { kind: "ignore", reason: "Kutilayotgan blok yo'q" };
    if (run.waitKind === "delay" || run.waitKind === "retry" || ((run.waitKind === "choice" || run.waitKind === "phone") && run.waitUntil)) {
      if (!run.waitUntil || run.waitUntil.getTime() > now.getTime()) return { kind: "ignore", reason: "Kutish vaqti hali tugamagan" };
      return { kind: "apply" };
    }
    return { kind: "ignore", reason: "Bu kutish vaqt bilan tugamaydi" };
  }

  if (run.status === "ACTIVE") return { kind: "ignore", reason: "Oqim hozir bajarilmoqda" };
  if (!node) return { kind: "ignore", reason: "Kutilayotgan blok yo'q" };

  if (signal.kind === "tap") {
    if (run.status !== "WAITING_TAP" || signal.nodeId !== run.waitNodeId) {
      return { kind: "ignore", reason: "Eski yoki boshqa blokning tugmasi", touch: true };
    }
    if (node.type === "message") {
      return node.button?.id === signal.buttonId ? { kind: "apply" } : { kind: "ignore", reason: "Noma'lum tugma", touch: true };
    }
    if (node.type === "button") {
      const button = node.buttons.find((b) => b.id === signal.buttonId);
      if (!button) return { kind: "ignore", reason: "Noma'lum tugma", touch: true };
      if (button.kind === "phone" && !extractPhone(signal.text ?? "")) {
        return { kind: "ignore", reason: "Telefon raqami o'qilmadi — qaytadan yuboring", touch: true };
      }
      return { kind: "apply" };
    }
    return { kind: "ignore", reason: "Bu blok tugma kutmaydi", touch: true };
  }

  // inbound (typed answer)
  if (run.status === "WAITING_INBOUND") return { kind: "apply" };
  if (run.status === "WAITING_TAP" && node.type === "button" && (run.waitKind === "choice" || run.waitKind === "phone")) {
    const phoneChip = node.buttons.some((b) => b.kind === "phone");
    if (phoneChip && extractPhone(signal.text)) return { kind: "apply" };
    if (node.onText === "other_edge") return { kind: "apply" };
    return { kind: "ignore", reason: "Tugmalardan birini tanlash kutilmoqda", touch: true };
  }
  return { kind: "ignore", reason: "Oqim bu xabarni kutmayapti", touch: true };
}

/** Does a plain text DM belong to this run (the webhook claim and the handler agree on this)? */
export function consumesPlainText(run: Pick<FlowRunState, "status" | "waitKind">): boolean {
  if (run.status === "ACTIVE" || run.status === "WAITING_INBOUND") return true;
  return run.status === "WAITING_TAP" && (run.waitKind === "choice" || run.waitKind === "phone");
}

/** Any live run owns the thread against other DM triggers (one conversation, one bot). */
export function isLiveRun(run: Pick<FlowRunState, "status">): boolean {
  return !TERMINAL_STATUSES.has(run.status);
}

/** The run's transition for a signal, as a normal node result (committed as its own step). */
async function applyInput(e: Env, signal: RunSignal): Promise<NodeResult> {
  const { run, index, fx } = e;
  const node = run.waitNodeId ? index.nodes.get(run.waitNodeId) : undefined;
  if (!node) return { step: { nodeId: run.waitNodeId ?? "-", nodeType: "unknown", status: "FAILED", reason: REASONS.noNode(run.waitNodeId) }, end: { status: "FAILED", reason: REASONS.noNode(run.waitNodeId) } };

  // ── timer
  if (signal.kind === "timer") {
    if (run.waitKind === "retry") {
      return { step: step(node, "DONE", { output: { retry: true } }), goto: node.id };
    }
    if (node.type === "button") {
      return { step: step(node, "DONE", { output: { handle: "timeout" } }), handle: "timeout" };
    }
    if (node.type === "delay") return completeDelay(e, node);
    return { step: step(node, "SKIPPED", { reason: "Taymer bu blok uchun ma'noga ega emas" }), handle: "next" };
  }

  // ── the customer acted: the window is (re)opened, the spam counter restarts
  const at = signal.at;
  const text = signal.kind === "tap" ? (signal.text ?? "") : signal.text;
  await fx.touchInbound(run, at, { open: true, text });
  const last = { text: clip(text, 500), at: at.toISOString() };
  const common = { resetSends: true, vars: { __last: last } as Record<string, unknown> };

  if (signal.kind === "tap") {
    if (node.type === "message") {
      return { ...common, step: step(node, "DONE", { output: { handle: "tap", buttonId: signal.buttonId } }), handle: "tap" };
    }
    if (node.type === "button") {
      const button = node.buttons.find((b) => b.id === signal.buttonId)!;
      const vars: Record<string, unknown> = { ...common.vars };
      const phone = button.kind === "phone" ? extractPhone(signal.text ?? "")?.e164 : null;
      const email = button.kind === "email" ? (signal.text ?? "").match(EMAIL)?.[0]?.toLowerCase() : null;
      const key = button.saveAs ?? (button.kind === "phone" ? "phone" : button.kind === "email" ? "email" : null);
      if (key) vars[key] = phone ?? email ?? button.label;
      return { ...common, vars, step: step(node, "DONE", { output: { handle: `tap:${button.id}`, label: button.label } }), handle: `tap:${button.id}` };
    }
  }

  // inbound
  if (node.type === "button") {
    const phoneChip = node.buttons.find((b) => b.kind === "phone");
    const phone = phoneChip ? extractPhone(text) : null;
    if (phoneChip && phone) {
      const vars: Record<string, unknown> = { ...common.vars, [phoneChip.saveAs ?? "phone"]: phone.e164 };
      return { ...common, vars, step: step(node, "DONE", { output: { handle: `tap:${phoneChip.id}`, viaText: true } }), handle: `tap:${phoneChip.id}` };
    }
    return { ...common, step: step(node, "DONE", { output: { handle: "other" }, input: { text: clip(text, 100) } }), handle: "other" };
  }
  if (run.waitKind === "reopen") {
    return { ...common, step: step(node, "DONE", { output: { reopened: true } }), goto: node.id };
  }
  if (node.type === "ai" && node.mode === "ask") return completeAsk(e, node, text, common);

  return { ...common, step: step(node, "SKIPPED", { reason: "Xabar bu blok uchun ma'noga ega emas" }), handle: "next" };
}

async function completeDelay(e: Env, node: DelayNode): Promise<NodeResult> {
  const { run, fx } = e;
  const anchors = await fx.window(run);
  const waitStart = typeof run.vars.__waitStart === "string" ? new Date(run.vars.__waitStart) : null;
  if (node.cancelOnReply && waitStart && anchors.lastInboundAt && anchors.lastInboundAt.getTime() > waitStart.getTime()) {
    return endResult(node, "DONE", REASONS.replied, "SKIPPED");
  }
  if (!isWindowOpenAt(anchors, e.now) && hasEdge(e, node.id, "window_closed")) {
    return { step: step(node, "DONE", { output: { handle: "window_closed" } }), handle: "window_closed" };
  }
  return { step: step(node, "DONE", { output: { handle: "next" } }), handle: "next" };
}

async function completeAsk(
  e: Env,
  node: Extract<FlowNode, { type: "ai" }>,
  text: string,
  common: { resetSends: boolean; vars: Record<string, unknown> }
): Promise<NodeResult> {
  const { run, fx } = e;
  let value = extractByCode(node.extract, text);
  if (value === undefined) value = (await fx.aiExtract(run, node, text))?.trim().slice(0, 300) || null;

  const key = node.saveAs ?? node.extract ?? "answer";
  if (value) {
    const vars: Record<string, unknown> = { ...common.vars, [key]: value };
    if (node.extract === "phone") vars.phone = value;
    e.invalidate();
    return { ...common, vars, step: step(node, "DONE", { output: { saved: key, value: clip(String(value), 100) } }), handle: "next" };
  }

  const asks = obj(run.vars.__asks);
  const attempts = Number(asks[node.id]) || 1;
  if (attempts <= node.retries) {
    const ctx = await e.ctx();
    const again = renderTemplate(node.retryText ?? node.question ?? "", ctx).text;
    if (again) {
      const pre = await preSend(e, node);
      if (!pre) {
        const out = await sendOf(e, node, "text", again);
        if (!out.ok) return out.result;
        return {
          ...common,
          step: step(node, "WAITING", { reason: "Javob tushunilmadi — savol qayta berildi", input: { question: clip(again), attempt: attempts + 1 } }),
          wait: { status: "WAITING_INBOUND", kind: "inbound" },
          sent: 1,
          vars: { ...common.vars, __sends: (Number(run.vars.__sends) || 0) + 1, __asks: { ...asks, [node.id]: attempts + 1 } },
        };
      }
    }
  }
  return { ...common, step: step(node, "SKIPPED", { reason: "Javobdan qiymat ajratib bo'lmadi" }), handle: "missing" };
}

// ─── Commit ───────────────────────────────────────────────────────────────────

/** Builds the next state from a node result and commits it. False = another worker moved the run. */
async function commitResult(e: Env, from: FlowNode | null, r: NodeResult): Promise<boolean> {
  const prev = e.run;
  const next: FlowRunState = {
    ...prev,
    vars: { ...prev.vars, ...(r.vars ?? {}) },
    sendsSinceInbound: r.resetSends ? (r.sent ?? 0) : prev.sendsSinceInbound + (r.sent ?? 0),
    isTest: prev.isTest || r.isTest === true,
  };
  let stepRecord = r.step;

  const endRun = (status: "DONE" | "FAILED" | "CANCELLED", reason: string) => {
    next.status = status;
    next.endReason = reason;
    next.lastError = status === "FAILED" ? reason : prev.lastError;
    next.waitNodeId = null;
    next.waitKind = null;
    next.waitUntil = null;
  };

  if (r.end) {
    endRun(r.end.status, r.end.reason);
  } else if (r.wait) {
    next.status = r.wait.status;
    next.currentNodeId = from?.id ?? prev.currentNodeId;
    next.waitNodeId = from?.id ?? prev.currentNodeId;
    next.waitKind = r.wait.kind;
    next.waitUntil = r.wait.until ?? null;
  } else {
    const target = r.goto ?? (from && r.handle ? e.index.edgeOf(from.id, r.handle)?.to : undefined);
    if (target) {
      next.status = "ACTIVE";
      next.currentNodeId = target;
      next.waitNodeId = null;
      next.waitKind = null;
      next.waitUntil = null;
    } else {
      // No edge for the chosen handle: the flow ends here (the auditor flags this before publish).
      endRun("DONE", REASONS.deadEnd);
      stepRecord = { ...stepRecord, reason: stepRecord.reason ?? REASONS.deadEnd };
    }
  }

  const ok = await e.fx.commit(prev, next, stepRecord);
  if (!ok) return false;
  Object.assign(prev, next, { seq: prev.seq + 1 });
  e.invalidate();
  return true;
}

// ─── The loop ─────────────────────────────────────────────────────────────────

/**
 * Runs the flow until it parks (WAITING_*) or ends. The run must be ACTIVE
 * (the caller acquired it); `signal` is the input that woke it, already
 * accepted by `planSignal`. Mutates `run` in place after every committed step.
 */
export async function advance(run: FlowRunState, graphOrIndex: FlowGraph | FlowIndex, fx: FlowEffects, signal?: RunSignal): Promise<AdvanceResult> {
  const index = "nodes" in graphOrIndex && graphOrIndex.nodes instanceof Map ? (graphOrIndex as FlowIndex) : buildIndex(graphOrIndex as FlowGraph);
  const e = makeEnv(run, index, fx);
  let steps = 0;
  let sends = 0;
  const result = (lost = false): AdvanceResult => ({ status: run.status, steps, sends, lost });

  if (signal) {
    const r = await applyInput(e, signal);
    const from = run.waitNodeId ? (index.nodes.get(run.waitNodeId) ?? null) : null;
    sends += r.sent ?? 0;
    if (!(await commitResult(e, from, r))) return result(true);
    steps++;
  }

  while (run.status === "ACTIVE") {
    if (steps >= MAX_STEPS_PER_ADVANCE) {
      const node = run.currentNodeId ? index.nodes.get(run.currentNodeId) : null;
      const r = node ? endResult(node, "FAILED", REASONS.stepLimit, "FAILED") : { step: { nodeId: "-", nodeType: "unknown", status: "FAILED" as const, reason: REASONS.stepLimit }, end: { status: "FAILED" as const, reason: REASONS.stepLimit } };
      if (!(await commitResult(e, node ?? null, r))) return result(true);
      break;
    }
    const node = run.currentNodeId ? index.nodes.get(run.currentNodeId) : undefined;
    if (!node) {
      const r: NodeResult = { step: { nodeId: run.currentNodeId ?? "-", nodeType: "unknown", status: "FAILED", reason: REASONS.noNode(run.currentNodeId) }, end: { status: "FAILED", reason: REASONS.noNode(run.currentNodeId) } };
      if (!(await commitResult(e, null, r))) return result(true);
      break;
    }

    // Guards: age, total steps, visits per node.
    let guard: NodeResult | null = null;
    const visits = obj(run.vars.__visits);
    const count = (Number(visits[node.id]) || 0) + 1;
    if (e.now.getTime() - run.startedAt.getTime() > MAX_RUN_AGE_MS) guard = endResult(node, "CANCELLED", REASONS.tooOld, "SKIPPED");
    else if (run.seq >= MAX_STEPS_PER_RUN) guard = endResult(node, "FAILED", REASONS.stepLimit, "FAILED");
    else if (count > MAX_NODE_VISITS) guard = endResult(node, "FAILED", REASONS.visitLimit(node.id), "FAILED");
    if (guard) {
      if (guard.end?.status === "FAILED") await fx.reportFailure(run, guard.end.reason).catch(() => {});
      if (!(await commitResult(e, node, guard))) return result(true);
      steps++;
      break;
    }

    const r = await executeSafely(e, node);
    r.vars = { ...(r.vars ?? {}), __visits: { ...visits, [node.id]: count } };
    sends += r.sent ?? 0;
    if (!(await commitResult(e, node, r))) return result(true);
    steps++;
  }
  return result();
}
