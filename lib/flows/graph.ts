/**
 * ETAP 6 — pure graph helpers over a FlowGraph: adjacency index,
 * reachability, dead-ends, cycles (Tarjan SCC), consecutive-send chains,
 * simple paths from the trigger and the structural 24h-window analysis the
 * policy engine and the auditor share.
 *
 * All helpers accept a draft graph (shape-valid, possibly incomplete) and
 * never throw on missing nodes / edges — they report them instead.
 */

import {
  COMMENT_TRIGGER_TYPES,
  FLOW_LIMITS,
  type FlowEdge,
  type FlowGraph,
  type FlowNode,
  type TriggerNode,
  handlesFor,
  isSendNode,
  isUserInputHandle,
  isUserWaitNode,
} from "./schema";

// ─── Index ────────────────────────────────────────────────────────────────────

export interface FlowIndex {
  graph: FlowGraph;
  nodes: Map<string, FlowNode>;
  /** Outgoing edges per node id (graph order). */
  out: Map<string, FlowEdge[]>;
  /** Incoming edges per node id. */
  inc: Map<string, FlowEdge[]>;
  trigger: TriggerNode | null;
  /** Edge leaving `nodeId` through `handle`, or null. */
  edgeOf(nodeId: string, handle: string): FlowEdge | null;
}

export function buildIndex(graph: FlowGraph): FlowIndex {
  const nodes = new Map<string, FlowNode>();
  const out = new Map<string, FlowEdge[]>();
  const inc = new Map<string, FlowEdge[]>();
  for (const node of graph.nodes) {
    if (!nodes.has(node.id)) nodes.set(node.id, node);
    out.set(node.id, []);
    inc.set(node.id, []);
  }
  for (const edge of graph.edges) {
    if (!nodes.has(edge.from) || !nodes.has(edge.to)) continue;
    out.get(edge.from)!.push(edge);
    inc.get(edge.to)!.push(edge);
  }
  const trigger = graph.nodes.find((n): n is TriggerNode => n.type === "trigger") ?? null;
  return {
    graph,
    nodes,
    out,
    inc,
    trigger,
    edgeOf(nodeId, handle) {
      return out.get(nodeId)?.find((e) => e.handle === handle) ?? null;
    },
  };
}

function indexOf(graph: FlowGraph | FlowIndex): FlowIndex {
  return "nodes" in graph && graph.nodes instanceof Map ? (graph as FlowIndex) : buildIndex(graph as FlowGraph);
}

// ─── Reachability ─────────────────────────────────────────────────────────────

/** Node ids reachable from `startId` (inclusive) following outgoing edges. */
export function reachableFrom(graph: FlowGraph | FlowIndex, startId: string): Set<string> {
  const index = indexOf(graph);
  const seen = new Set<string>();
  const stack = [startId];
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id) || !index.nodes.has(id)) continue;
    seen.add(id);
    for (const edge of index.out.get(id) ?? []) stack.push(edge.to);
  }
  return seen;
}

/** Node ids from which `nodeId` can be reached (exclusive of itself unless it sits on a cycle). */
export function ancestorsOf(graph: FlowGraph | FlowIndex, nodeId: string): Set<string> {
  const index = indexOf(graph);
  const seen = new Set<string>();
  const stack = (index.inc.get(nodeId) ?? []).map((e) => e.from);
  while (stack.length) {
    const id = stack.pop()!;
    if (seen.has(id)) continue;
    seen.add(id);
    for (const edge of index.inc.get(id) ?? []) stack.push(edge.from);
  }
  return seen;
}

/** Nodes the trigger never reaches (every node when there is no trigger). */
export function findUnreachable(graph: FlowGraph | FlowIndex): string[] {
  const index = indexOf(graph);
  if (!index.trigger) return index.graph.nodes.map((n) => n.id);
  const reachable = reachableFrom(index, index.trigger.id);
  return index.graph.nodes.filter((n) => !reachable.has(n.id)).map((n) => n.id);
}

export interface DeadEnd {
  nodeId: string;
  /** The required handle that has no edge. */
  handle: string;
}

/** Required handles without an edge (the run would stop there with reason "dead_end"). */
export function findDeadEnds(graph: FlowGraph | FlowIndex): DeadEnd[] {
  const index = indexOf(graph);
  const out: DeadEnd[] = [];
  for (const node of index.graph.nodes) {
    const handles = new Set((index.out.get(node.id) ?? []).map((e) => e.handle));
    for (const handle of handlesFor(node).required) {
      if (!handles.has(handle)) out.push({ nodeId: node.id, handle });
    }
  }
  return out;
}

/** Edges whose endpoints or handle do not exist (draft graphs). */
export function findBrokenEdges(graph: FlowGraph): Array<{ edgeIndex: number; reason: "from" | "to" | "handle" }> {
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: Array<{ edgeIndex: number; reason: "from" | "to" | "handle" }> = [];
  graph.edges.forEach((edge, edgeIndex) => {
    const from = byId.get(edge.from);
    if (!from) return void out.push({ edgeIndex, reason: "from" });
    if (!byId.has(edge.to)) return void out.push({ edgeIndex, reason: "to" });
    const rule = handlesFor(from);
    if (!rule.required.includes(edge.handle) && !rule.optional.includes(edge.handle)) out.push({ edgeIndex, reason: "handle" });
  });
  return out;
}

// ─── Cycles (Tarjan) ──────────────────────────────────────────────────────────

export interface FlowCycle {
  nodes: string[];
  /** True when the cycle contains a node that waits for the customer or a delay (not endless by itself). */
  hasWait: boolean;
}

/** Strongly connected components with ≥ 2 nodes or a self-loop. */
export function findCycles(graph: FlowGraph | FlowIndex): FlowCycle[] {
  const index = indexOf(graph);
  const ids = [...index.nodes.keys()];
  const order = new Map<string, number>();
  const low = new Map<string, number>();
  const onStack = new Set<string>();
  const stack: string[] = [];
  const result: FlowCycle[] = [];
  let counter = 0;

  const isWait = (id: string) => {
    const node = index.nodes.get(id);
    return !!node && (isUserWaitNode(node) || node.type === "delay");
  };

  // Iterative Tarjan: frames of (node, next edge position).
  const visit = (root: string) => {
    const frames: Array<{ id: string; pos: number }> = [{ id: root, pos: 0 }];
    order.set(root, counter);
    low.set(root, counter);
    counter += 1;
    stack.push(root);
    onStack.add(root);
    while (frames.length) {
      const frame = frames[frames.length - 1];
      const edges = index.out.get(frame.id) ?? [];
      if (frame.pos < edges.length) {
        const next = edges[frame.pos].to;
        frame.pos += 1;
        if (!order.has(next)) {
          order.set(next, counter);
          low.set(next, counter);
          counter += 1;
          stack.push(next);
          onStack.add(next);
          frames.push({ id: next, pos: 0 });
        } else if (onStack.has(next)) {
          low.set(frame.id, Math.min(low.get(frame.id)!, order.get(next)!));
        }
        continue;
      }
      frames.pop();
      if (frames.length) {
        const parent = frames[frames.length - 1].id;
        low.set(parent, Math.min(low.get(parent)!, low.get(frame.id)!));
      }
      if (low.get(frame.id) === order.get(frame.id)) {
        const component: string[] = [];
        let id: string;
        do {
          id = stack.pop()!;
          onStack.delete(id);
          component.push(id);
        } while (id !== frame.id);
        const selfLoop = component.length === 1 && edges.some((e) => e.to === frame.id);
        if (component.length > 1 || selfLoop) {
          component.reverse();
          result.push({ nodes: component, hasWait: component.some(isWait) });
        }
      }
    }
  };

  for (const id of ids) if (!order.has(id)) visit(id);
  return result;
}

/** Cycles with no wait inside: the engine would spin until the visit cap. */
export function findEndlessLoops(graph: FlowGraph | FlowIndex): FlowCycle[] {
  return findCycles(graph).filter((cycle) => !cycle.hasWait);
}

// ─── Consecutive sends ────────────────────────────────────────────────────────

export interface SendChain {
  /** Longest run of sends with no wait for customer input in between. */
  max: number;
  /** Node where the longest chain ends (null when nothing is sent). */
  atNodeId: string | null;
}

/**
 * Longest chain of sends (message / button / ai question / lead thanks /
 * operator reply) between two points where the customer acts. A button, a
 * message with a button and an ai.ask count as a send and then reset the
 * chain (the run waits there). `delayResets` also resets on a delay node
 * and `countWaits: false` leaves the waiting send itself uncounted (both
 * used by the "missing delay" rule; the spam rule ignores delays because
 * the 24h counter only resets on an inbound message).
 */
export function consecutiveSendsMax(graph: FlowGraph | FlowIndex, opts: { delayResets?: boolean; countWaits?: boolean } = {}): SendChain {
  const index = indexOf(graph);
  if (!index.trigger) return { max: 0, atNodeId: null };
  let max = 0;
  let atNodeId: string | null = null;
  // A cycle without a wait would count forever: cap at the node count (the
  // engine's own cap is the per-node visit limit; the auditor reports the loop).
  const cap = index.nodes.size + 1;
  const seen = new Set<string>();
  const stack: Array<{ id: string; count: number }> = [{ id: index.trigger.id, count: 0 }];
  while (stack.length) {
    const { id, count } = stack.pop()!;
    const key = `${id}:${count}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = index.nodes.get(id);
    if (!node) continue;
    let next = count;
    if (isSendNode(node) && (opts.countWaits !== false || !isUserWaitNode(node))) {
      next = Math.min(cap, count + 1);
      if (next > max) {
        max = next;
        atNodeId = id;
      }
    }
    if (opts.delayResets && node.type === "delay") next = 0;
    for (const edge of index.out.get(id) ?? []) {
      stack.push({ id: edge.to, count: isUserInputHandle(node, edge.handle) ? 0 : next });
    }
  }
  return { max, atNodeId };
}

// ─── Paths ────────────────────────────────────────────────────────────────────

export interface PathOptions {
  maxPaths?: number;
  maxLength?: number;
}

/**
 * Simple paths (no node repeated) from the trigger, as id arrays. A path ends
 * at a node with no outgoing edge or when it would revisit a node. Capped to
 * keep the auditor linear on branching graphs.
 */
export function pathsFromTrigger(graph: FlowGraph | FlowIndex, opts: PathOptions = {}): string[][] {
  const index = indexOf(graph);
  const maxPaths = opts.maxPaths ?? 200;
  const maxLength = opts.maxLength ?? FLOW_LIMITS.nodes;
  const paths: string[][] = [];
  if (!index.trigger) return paths;
  const walk = (path: string[]) => {
    if (paths.length >= maxPaths) return;
    const last = path[path.length - 1];
    const edges = (index.out.get(last) ?? []).filter((e) => !path.includes(e.to) && index.nodes.has(e.to));
    if (edges.length === 0 || path.length >= maxLength) {
      paths.push(path);
      return;
    }
    for (const edge of edges) walk([...path, edge.to]);
  };
  walk([index.trigger.id]);
  return paths;
}

// ─── 24h window (structural) ──────────────────────────────────────────────────

export type WindowState = "open" | "closed" | "mixed";

/**
 * Whether the 24h messaging window is structurally open when a node is
 * entered. DM-side triggers (DIRECT_MESSAGE, STORY_MENTION) open it with the
 * triggering message; comment triggers open it only when the customer taps
 * the opening button of a message (`tap` edge). "mixed" = reachable both
 * ways. Unreachable nodes are absent from the map.
 */
export function windowStateAt(graph: FlowGraph | FlowIndex): Map<string, WindowState> {
  const index = indexOf(graph);
  const states = new Map<string, WindowState>();
  if (!index.trigger) return states;
  const openFromStart = !COMMENT_TRIGGER_TYPES.has(index.trigger.triggerType);
  const seen = new Set<string>();
  const stack: Array<{ id: string; open: boolean }> = [{ id: index.trigger.id, open: openFromStart }];
  while (stack.length) {
    const { id, open } = stack.pop()!;
    const key = `${id}:${open ? 1 : 0}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = index.nodes.get(id);
    if (!node) continue;
    const current = states.get(id);
    const mine: WindowState = open ? "open" : "closed";
    states.set(id, current === undefined || current === mine ? mine : "mixed");
    for (const edge of index.out.get(id) ?? []) {
      stack.push({ id: edge.to, open: open || (node.type === "message" && edge.handle === "tap") });
    }
  }
  return states;
}

export function windowOpenAt(graph: FlowGraph | FlowIndex, nodeId: string): boolean {
  return windowStateAt(graph).get(nodeId) === "open";
}

/**
 * Worst-case minutes of `delay` (and button timeouts) accumulated since the
 * last point where the customer acted (trigger message for DM-side flows, a
 * tap / typed answer otherwise), when a node is entered. Capped just above
 * the window so cycles terminate. A comment trigger starts "already closed"
 * (Infinity) until the opening button is tapped.
 */
export function maxDelaySinceInputAt(graph: FlowGraph | FlowIndex): Map<string, number> {
  const index = indexOf(graph);
  const result = new Map<string, number>();
  if (!index.trigger) return result;
  const cap = FLOW_LIMITS.windowMinutes + 1;
  const start = COMMENT_TRIGGER_TYPES.has(index.trigger.triggerType) ? Number.POSITIVE_INFINITY : 0;
  const seen = new Set<string>();
  const stack: Array<{ id: string; minutes: number }> = [{ id: index.trigger.id, minutes: start }];
  while (stack.length) {
    const { id, minutes } = stack.pop()!;
    const key = `${id}:${minutes}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const node = index.nodes.get(id);
    if (!node) continue;
    result.set(id, Math.max(result.get(id) ?? 0, minutes));
    let leaving = minutes;
    if (node.type === "delay") leaving = Math.min(cap, minutes + node.minutes);
    for (const edge of index.out.get(id) ?? []) {
      let next = leaving;
      if (isUserInputHandle(node, edge.handle)) next = 0;
      else if (node.type === "button" && edge.handle === "timeout") next = Math.min(cap, leaving + (node.timeoutMinutes ?? 0));
      stack.push({ id: edge.to, minutes: next });
    }
  }
  return result;
}

// ─── Variables set by nodes ───────────────────────────────────────────────────

/** `vars.<key>` → ids of the nodes that assign it. */
export function variableSetters(graph: FlowGraph): Map<string, string[]> {
  const setters = new Map<string, string[]>();
  const add = (key: string | undefined, nodeId: string) => {
    if (!key) return;
    const ids = setters.get(key) ?? [];
    if (!ids.includes(nodeId)) ids.push(nodeId);
    setters.set(key, ids);
  };
  for (const node of graph.nodes) {
    switch (node.type) {
      case "button":
        for (const button of node.buttons) add(button.saveAs, node.id);
        break;
      case "ai":
        if (node.mode === "ask") add(node.saveAs, node.id);
        break;
      case "webhook":
        add(node.saveAs, node.id);
        break;
      case "action":
        if (node.action === "set_variable" || node.action === "increment") add(node.key, node.id);
        break;
      default:
        break;
    }
  }
  return setters;
}

/** Nodes whose button / ai.ask collects a phone number into `vars.<key>`. */
export function phoneSources(graph: FlowGraph): Map<string, string[]> {
  const sources = new Map<string, string[]>();
  for (const node of graph.nodes) {
    const keys: string[] = [];
    if (node.type === "button") keys.push(...node.buttons.filter((b) => b.kind === "phone" && b.saveAs).map((b) => b.saveAs!));
    if (node.type === "ai" && node.mode === "ask" && node.extract === "phone" && node.saveAs) keys.push(node.saveAs);
    for (const key of keys) sources.set(key, [...(sources.get(key) ?? []), node.id]);
  }
  return sources;
}
