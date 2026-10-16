/**
 * ETAP 6 — canonical form, hash and node-level diff of a flow graph.
 *
 * The hash decides "did the graph change?": it must not move when the UI
 * re-orders nodes / edges, when object keys come back in another order, or
 * when the merchant only drags a node (`layout` is UI-only and excluded).
 * Order that carries meaning (buttons, condition branches, message order of
 * a path) is kept; set-like string lists (keywords, tag slugs …) are sorted.
 *
 * Pure: node:crypto only.
 */

import { createHash } from "node:crypto";
import type { FlowEdge, FlowGraph, FlowNode } from "./schema";

/** String lists whose order means nothing. */
const SET_LIKE_FIELDS = new Set(["keywords", "intents", "mediaIds", "storyIds", "adIds", "refs", "tagSlugs"]);

function sortKeysDeep(value: unknown, parentKey?: string): unknown {
  if (Array.isArray(value)) {
    const mapped = value.map((item) => sortKeysDeep(item));
    if (parentKey && SET_LIKE_FIELDS.has(parentKey) && mapped.every((item) => typeof item === "string")) {
      return [...(mapped as string[])].sort();
    }
    return mapped;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      out[key] = sortKeysDeep(child, key);
    }
    return out;
  }
  return value;
}

const edgeKey = (edge: FlowEdge) => `${edge.from}\u0000${edge.handle}\u0000${edge.to}`;

/** The graph in canonical order, without `layout`. */
export function canonicalGraph(graph: FlowGraph): Record<string, unknown> {
  return {
    v: graph.v,
    nodes: [...graph.nodes].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)).map((node) => sortKeysDeep(node)),
    edges: [...graph.edges].sort((a, b) => (edgeKey(a) < edgeKey(b) ? -1 : edgeKey(a) > edgeKey(b) ? 1 : 0)).map((edge) => sortKeysDeep(edge)),
    variables: [...(graph.variables ?? [])].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map((v) => sortKeysDeep(v)),
  };
}

export function canonicalJson(graph: FlowGraph): string {
  return JSON.stringify(canonicalGraph(graph));
}

/** sha256 hex of the canonical JSON. */
export function hashGraph(graph: FlowGraph): string {
  return createHash("sha256").update(canonicalJson(graph)).digest("hex");
}

// ─── Diff ─────────────────────────────────────────────────────────────────────

export interface FieldChange {
  field: string;
  before: unknown;
  after: unknown;
}

export interface NodeChange {
  id: string;
  type: FlowNode["type"];
  fields: FieldChange[];
}

export interface GraphDiff {
  added: Array<{ id: string; type: FlowNode["type"] }>;
  removed: Array<{ id: string; type: FlowNode["type"] }>;
  changed: NodeChange[];
  edgesAdded: FlowEdge[];
  edgesRemoved: FlowEdge[];
  variablesAdded: string[];
  variablesRemoved: string[];
  /** True when nothing but layout differs. */
  identical: boolean;
}

const json = (value: unknown, field?: string) => JSON.stringify(sortKeysDeep(value, field));

function changedFields(a: FlowNode, b: FlowNode): FieldChange[] {
  const left = a as unknown as Record<string, unknown>;
  const right = b as unknown as Record<string, unknown>;
  const fields = new Set([...Object.keys(left), ...Object.keys(right)]);
  const changes: FieldChange[] = [];
  for (const field of [...fields].sort()) {
    if (field === "id") continue;
    const before = left[field];
    const after = right[field];
    if (json(before, field) !== json(after, field)) changes.push({ field, before: before ?? null, after: after ?? null });
  }
  return changes;
}

/** Node-level diff of `a` (older) → `b` (newer). Layout is ignored. */
export function diffGraphs(a: FlowGraph, b: FlowGraph): GraphDiff {
  const before = new Map(a.nodes.map((n) => [n.id, n]));
  const after = new Map(b.nodes.map((n) => [n.id, n]));
  const added = b.nodes.filter((n) => !before.has(n.id)).map((n) => ({ id: n.id, type: n.type }));
  const removed = a.nodes.filter((n) => !after.has(n.id)).map((n) => ({ id: n.id, type: n.type }));
  const changed: NodeChange[] = [];
  for (const node of b.nodes) {
    const old = before.get(node.id);
    if (!old) continue;
    if (old.type !== node.type) {
      changed.push({ id: node.id, type: node.type, fields: [{ field: "type", before: old.type, after: node.type }] });
      continue;
    }
    const fields = changedFields(old, node);
    if (fields.length > 0) changed.push({ id: node.id, type: node.type, fields });
  }
  const oldEdges = new Map(a.edges.map((e) => [edgeKey(e), e]));
  const newEdges = new Map(b.edges.map((e) => [edgeKey(e), e]));
  const edgesAdded = b.edges.filter((e) => !oldEdges.has(edgeKey(e)));
  const edgesRemoved = a.edges.filter((e) => !newEdges.has(edgeKey(e)));
  const oldVars = new Set((a.variables ?? []).map((v) => v.key));
  const newVars = new Set((b.variables ?? []).map((v) => v.key));
  const variablesAdded = [...newVars].filter((k) => !oldVars.has(k));
  const variablesRemoved = [...oldVars].filter((k) => !newVars.has(k));
  return {
    added,
    removed,
    changed,
    edgesAdded,
    edgesRemoved,
    variablesAdded,
    variablesRemoved,
    identical:
      added.length === 0 &&
      removed.length === 0 &&
      changed.length === 0 &&
      edgesAdded.length === 0 &&
      edgesRemoved.length === 0 &&
      variablesAdded.length === 0 &&
      variablesRemoved.length === 0,
  };
}
