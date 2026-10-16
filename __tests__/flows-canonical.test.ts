/**
 * ETAP 6 — canonical JSON, graph hash and node-level diff.
 */

import { describe, expect, it } from "vitest";
import { canonicalJson, diffGraphs, hashGraph } from "../lib/flows/canonical";
import type { FlowGraph } from "../lib/flows/schema";
import { flowGraphDraftSchema } from "../lib/flows/schema";
import { findStarterTemplate } from "../lib/flows/templates";

function base(): FlowGraph {
  return flowGraphDraftSchema.parse({
    v: 1,
    nodes: [
      { id: "t", type: "trigger", triggerType: "DIRECT_MESSAGE", matchingMode: "CONTAINS", keywords: ["narx", "qancha"] },
      { id: "m1", type: "message", text: "Salom {{name}}" },
      { id: "end", type: "end" },
    ],
    edges: [
      { from: "t", to: "m1", handle: "next" },
      { from: "m1", to: "end", handle: "next" },
    ],
    variables: [
      { key: "a", label: "A", kind: "string" },
      { key: "b", label: "B", kind: "string" },
    ],
  });
}

describe("hashGraph", () => {
  it("is a sha256 hex and stable across calls", () => {
    expect(hashGraph(base())).toMatch(/^[0-9a-f]{64}$/);
    expect(hashGraph(base())).toBe(hashGraph(base()));
  });

  it("does not depend on node / edge / variable order, key order or set-like lists", () => {
    const a = base();
    const b = base();
    b.nodes.reverse();
    b.edges.reverse();
    b.variables.reverse();
    const trigger = b.nodes.find((n) => n.type === "trigger");
    if (trigger?.type === "trigger") trigger.keywords = ["qancha", "narx"];
    // Re-create one node with its keys in another order.
    b.nodes[0] = Object.fromEntries(Object.entries(b.nodes[0]).reverse()) as never;
    expect(hashGraph(b)).toBe(hashGraph(a));
    expect(canonicalJson(b)).toBe(canonicalJson(a));
  });

  it("ignores layout (dragging a node must not reset the approval)", () => {
    const a = base();
    const b = { ...base(), layout: { t: { x: 10, y: 20 }, m1: { x: 40, y: 80 } } };
    expect(hashGraph(b)).toBe(hashGraph(a));
  });

  it("moves when content, an edge or button order changes", () => {
    const a = base();
    const text = base();
    (text.nodes[1] as { text: string }).text = "Salom!";
    expect(hashGraph(text)).not.toBe(hashGraph(a));
    const edge = base();
    edge.edges[1] = { from: "m1", to: "m1", handle: "next" };
    expect(hashGraph(edge)).not.toBe(hashGraph(a));

    const twoButtons = (order: string[]): FlowGraph =>
      flowGraphDraftSchema.parse({
        v: 1,
        nodes: [
          { id: "t", type: "trigger", triggerType: "DIRECT_MESSAGE" },
          { id: "b", type: "button", text: "x", buttons: order.map((id) => ({ id, label: id })) },
        ],
        edges: [],
      });
    expect(hashGraph(twoButtons(["p", "q"]))).not.toBe(hashGraph(twoButtons(["q", "p"])));
  });

  it("works on the starter templates", () => {
    const t = findStarterTemplate("comment_price_lead")!;
    expect(hashGraph(t.graph)).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("diffGraphs", () => {
  it("reports nothing for identical graphs (layout ignored)", () => {
    const diff = diffGraphs(base(), { ...base(), layout: { t: { x: 1, y: 1 } } });
    expect(diff.identical).toBe(true);
    expect(diff.added).toEqual([]);
    expect(diff.changed).toEqual([]);
  });

  it("finds added, removed and changed nodes, edges and variables", () => {
    const a = base();
    const b = base();
    (b.nodes[1] as { text: string }).text = "Assalomu alaykum {{name}}";
    b.nodes.push({ id: "tag", type: "tag", action: "add", tagSlugs: ["hot"] } as never);
    b.nodes = b.nodes.filter((n) => n.id !== "end");
    b.edges = [
      { from: "t", to: "m1", handle: "next" },
      { from: "m1", to: "tag", handle: "next" },
    ];
    b.variables = [
      { key: "a", label: "A", kind: "string" },
      { key: "c", label: "C", kind: "number" },
    ];

    const diff = diffGraphs(a, b);
    expect(diff.identical).toBe(false);
    expect(diff.added).toEqual([{ id: "tag", type: "tag" }]);
    expect(diff.removed).toEqual([{ id: "end", type: "end" }]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]).toMatchObject({ id: "m1", type: "message" });
    expect(diff.changed[0].fields).toEqual([{ field: "text", before: "Salom {{name}}", after: "Assalomu alaykum {{name}}" }]);
    expect(diff.edgesAdded).toEqual([{ from: "m1", to: "tag", handle: "next" }]);
    expect(diff.edgesRemoved).toEqual([{ from: "m1", to: "end", handle: "next" }]);
    expect(diff.variablesAdded).toEqual(["c"]);
    expect(diff.variablesRemoved).toEqual(["b"]);
  });

  it("a set-like list reordered is not a change; an added keyword is", () => {
    const a = base();
    const same = base();
    (same.nodes[0] as { keywords: string[] }).keywords = ["qancha", "narx"];
    expect(diffGraphs(a, same).changed).toEqual([]);
    const more = base();
    (more.nodes[0] as { keywords: string[] }).keywords = ["narx", "qancha", "price"];
    const diff = diffGraphs(a, more);
    expect(diff.changed[0].fields[0]).toMatchObject({ field: "keywords" });
  });

  it("a node whose type changed is reported as changed", () => {
    const a = base();
    const b = base();
    b.nodes[2] = { id: "end", type: "operator", reason: "flow_rule" } as never;
    const diff = diffGraphs(a, b);
    expect(diff.changed[0]).toMatchObject({ id: "end", type: "operator" });
    expect(diff.changed[0].fields[0]).toMatchObject({ field: "type", before: "end", after: "operator" });
  });
});
