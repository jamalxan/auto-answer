/**
 * ETAP 6 — the sandbox / test console (analysis §2.5). A dry run of a graph
 * through the REAL step loop (runner.ts `advance`) with the in-memory effects
 * port: no database write, no Instagram send, no model call, no HTTP call.
 *
 *   input  contact / inbound texts / button taps (ids, in order) / window / vars
 *   output steps (what ran, why it was skipped), sends (the transcript with
 *          buttons), where it ended, final variables, the policy verdict and
 *          warnings (policy findings + what the run itself skipped)
 *
 * Deterministic: a fixed start time and a fake clock that only moves when the
 * driver moves it — a Delay jumps the clock to its wake-up time (so a wait
 * past 24 h shows the window closing), every tap / answer adds a minute. The
 * `webhook` node is stubbed unless its URL already fails the static policy
 * (then it fails like the real one); `ai` ask uses the given inbound text;
 * takeover is recorded. A hard cap on driver turns and the engine's own step
 * limits make a looping graph terminate.
 *
 * Pure with respect to storage: imports no Prisma.
 */

import { createMemoryEffects, type MemoryContact, type RecordedSend, type RecordedStep } from "./effects-memory";
import { buildIndex } from "./graph";
import { evaluatePolicy, type PolicyVerdict } from "./policy";
import { advance, planSignal, type FlowRunState, type RunSignal, type RunStatusName } from "./runner";
import { COMMENT_TRIGGER_TYPES, triggerOf, type FlowGraph, type FlowNode } from "./schema";

export interface SandboxInput {
  contact?: MemoryContact;
  /** Typed customer messages, in order. */
  inbound?: Array<{ text: string }>;
  /** Button ids tapped, in order (a message button or a chip of a Button node). */
  taps?: string[];
  /** Window state when a DM-side run starts (default open). A comment's private reply needs none. */
  window?: "open" | "closed";
  /** Initial run variables (vars.<key>). */
  vars?: Record<string, unknown>;
  /** Comment / message text that started the flow (trigger.text). */
  triggerText?: string;
}

export interface SandboxStep {
  nodeId: string;
  nodeType: string;
  status: "DONE" | "SKIPPED" | "FAILED" | "WAITING";
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  reason?: string;
}

export interface SandboxSend {
  nodeId: string;
  text: string;
  buttons?: Array<{ id: string; label: string }>;
}

export interface SandboxResult {
  steps: SandboxStep[];
  sends: SandboxSend[];
  /** The node the run finished at; null while it still waits for input the script did not provide. */
  endedAt: string | null;
  status: RunStatusName;
  endReason: string | null;
  variables: Record<string, unknown>;
  policyVerdict: PolicyVerdict;
  warnings: string[];
  /** Tags added, leads, notifications... that WOULD have happened. */
  effects: Array<{ kind: string; detail: Record<string, unknown> }>;
  tags: string[];
}

/** Fixed start: 2026-01-05 (Monday) 09:00 UTC = 14:00 in Tashkent. */
export const SANDBOX_START = new Date("2026-01-05T09:00:00.000Z");
const MAX_DRIVER_TURNS = 60;
const TURN_MS = 60_000;

function windowAnchors(open: boolean, comment: boolean, start: Date) {
  if (comment) return { openedAt: null, lastInboundAt: null };
  const at = open ? start : new Date(start.getTime() - 48 * 3600_000);
  return { openedAt: at, lastInboundAt: at };
}

function toSteps(steps: RecordedStep[]): SandboxStep[] {
  return steps.map(({ nodeId, nodeType, status, input, output, reason }) => ({
    nodeId,
    nodeType,
    status,
    ...(input ? { input } : {}),
    ...(output ? { output } : {}),
    ...(reason ? { reason } : {}),
  }));
}

function toSends(sends: RecordedSend[]): SandboxSend[] {
  return sends.map((send) => ({
    nodeId: send.nodeId,
    text: send.text,
    ...(send.buttons ? { buttons: send.buttons.map((b) => ({ id: b.id, label: b.label })) } : {}),
  }));
}

/** Which input can the waiting node take next? */
function nextSignal(node: FlowNode | undefined, run: FlowRunState, queue: { taps: string[]; inbound: string[] }, at: Date, n: number): RunSignal | null {
  if (!node) return null;
  const tapOk = (id: string | undefined) =>
    id !== undefined &&
    ((node.type === "message" && node.button?.id === id) || (node.type === "button" && node.buttons.some((b) => b.id === id)));
  if (run.status === "WAITING_TAP" && tapOk(queue.taps[0])) {
    const buttonId = queue.taps.shift()!;
    // A phone chip needs the shared number: take it from the next typed answer, else a placeholder number.
    const phoneChip = node.type === "button" && node.buttons.find((b) => b.id === buttonId && b.kind === "phone");
    const text = phoneChip ? (queue.inbound.shift() ?? "+998901234567") : "";
    return { kind: "tap", nodeId: node.id, buttonId, eventId: `sandbox.tap.${n}`, at, text };
  }
  const canType =
    run.status === "WAITING_INBOUND" ||
    (run.status === "WAITING_TAP" && node.type === "button" && (run.waitKind === "choice" || run.waitKind === "phone"));
  if (canType && queue.inbound.length > 0) {
    return { kind: "inbound", text: queue.inbound.shift()!, eventId: `sandbox.in.${n}`, at };
  }
  return null;
}

export async function runFlowSandbox(workspaceId: string, graph: FlowGraph, input: SandboxInput = {}): Promise<SandboxResult> {
  void workspaceId; // sandbox runs are never stored: the id only labels the call
  const index = buildIndex(graph);
  const trigger = triggerOf(graph);
  const policy = evaluatePolicy(graph);
  const warnings: string[] = policy.items.map((item) => `[${item.severity}] ${item.message}`);
  const empty = (status: RunStatusName, reason: string): SandboxResult => ({
    steps: [],
    sends: [],
    endedAt: null,
    status,
    endReason: reason,
    variables: {},
    policyVerdict: policy.verdict,
    warnings: [...warnings, reason],
    effects: [],
    tags: [],
  });
  if (!trigger) return empty("FAILED", "Oqimda trigger bloki yo'q — sinab bo'lmaydi.");

  const comment = COMMENT_TRIGGER_TYPES.has(trigger.triggerType);
  const fx = createMemoryEffects({
    start: SANDBOX_START,
    contact: input.contact,
    windowOpen: input.window !== "closed",
    triggerText: input.triggerText,
  });
  fx.anchors = windowAnchors(input.window !== "closed", comment, SANDBOX_START);

  const run: FlowRunState = {
    id: "sandbox",
    status: "ACTIVE",
    triggerType: trigger.triggerType,
    currentNodeId: trigger.id,
    seq: 0,
    vars: {
      ...(input.vars ?? {}),
      __trigger: { text: input.triggerText ?? "", keyword: null, intent: null, source: "organic", mediaId: null, audience: input.contact?.audience ?? "NEW" },
    },
    waitNodeId: null,
    waitKind: null,
    waitUntil: null,
    sendsSinceInbound: 0,
    startedAt: SANDBOX_START,
    endReason: null,
    lastError: null,
    isTest: true,
  };

  const queue = { taps: [...(input.taps ?? [])], inbound: (input.inbound ?? []).map((m) => m.text) };
  let turns = 0;
  await advance(run, index, fx);

  while (turns++ < MAX_DRIVER_TURNS && run.status !== "DONE" && run.status !== "FAILED" && run.status !== "CANCELLED") {
    const at = new Date(fx.clock.getTime() + TURN_MS);
    let signal: RunSignal | null = null;
    if (run.status === "WAITING_DELAY") {
      // A Delay (or a retry wait): the clock jumps to its wake-up time.
      if (run.waitUntil) fx.setNow(run.waitUntil);
      signal = { kind: "timer" };
    } else if (run.status === "WAITING_TAP" || run.status === "WAITING_INBOUND") {
      const node = run.waitNodeId ? index.nodes.get(run.waitNodeId) : undefined;
      signal = nextSignal(node, run, queue, at, turns);
      if (signal && signal.kind !== "timer") fx.setNow(signal.at);
    }
    if (!signal) break;
    const plan = planSignal(run, index, signal, fx.now());
    if (plan.kind === "ignore") {
      warnings.push(`Kirish e'tiborsiz qoldi: ${plan.reason}`);
      // Make progress anyway: the unusable input is dropped, the loop ends when none is left.
      if (signal.kind === "timer") break;
      continue;
    }
    run.status = "ACTIVE";
    await advance(run, index, fx, signal);
  }

  for (const step of fx.steps) {
    if (step.status === "FAILED" && step.reason) warnings.push(`«${step.nodeId}»: ${step.reason}`);
    else if (step.status === "SKIPPED" && step.reason) warnings.push(`«${step.nodeId}» o'tkazib yuborildi: ${step.reason}`);
  }
  if (run.status === "WAITING_TAP" || run.status === "WAITING_INBOUND") {
    warnings.push(`Test kiritmasi tugadi: oqim «${run.waitNodeId}» blokida mijoz javobini kutmoqda.`);
  }
  if (turns > MAX_DRIVER_TURNS) warnings.push("Test qadamlari chegarasiga yetildi.");

  const finished = run.status === "DONE" || run.status === "FAILED" || run.status === "CANCELLED";
  const variables: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(run.vars)) if (!key.startsWith("__")) variables[key] = value;

  return {
    steps: toSteps(fx.steps),
    sends: toSends(fx.sends),
    endedAt: finished ? run.currentNodeId : null,
    status: run.status,
    endReason: run.endReason,
    variables,
    policyVerdict: policy.verdict,
    warnings: [...new Set(warnings)],
    effects: fx.effects.map(({ kind, detail }) => ({ kind, detail })),
    tags: [...fx.tags],
  };
}
