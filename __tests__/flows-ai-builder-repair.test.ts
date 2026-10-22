/**
 * ETAP 7 — deterministic repair of the model's most common mistake: a comment
 * flow that sends a button / ai / lead block before the opening button is
 * tapped (24h window rule). The repair runs inside parseGraphFromLlm, so a
 * graph that only breaks that rule no longer costs a second model round.
 */

import { describe, expect, it } from "vitest";
import { isFlowParseFailure, parseGraphFromLlm, repairCommentOpening } from "../lib/flows/ai-builder-prompt";

const trigger = { id: "t", type: "trigger", triggerType: "COMMENT", matchingMode: "CONTAINS", keywords: ["narx"] };
const end = { id: "end", type: "end" };

function wrap(graph: Record<string, unknown>) {
  return { name: "Narx", summary: "Narx oqimi", graph: { v: 1, variables: [], ...graph } };
}

describe("repairCommentOpening", () => {
  it("turns a single-button quick-reply block right after a comment trigger into an opening message", () => {
    const result = parseGraphFromLlm(
      wrap({
        nodes: [trigger, { id: "b1", type: "button", text: "Narxni yuboraymi?", buttons: [{ id: "yes", label: "Ha" }] }, { id: "m2", type: "message", text: "Narx 100 000 so'm" }, end],
        edges: [
          { from: "t", to: "b1", handle: "next" },
          { from: "b1", to: "m2", handle: "tap:yes" },
          { from: "b1", to: "m2", handle: "other" },
          { from: "m2", to: "end", handle: "next" },
        ],
      })
    );
    expect(isFlowParseFailure(result)).toBe(false);
    if (isFlowParseFailure(result)) return;
    const opener = result.graph.nodes.find((n) => n.id === "b1");
    expect(opener?.type).toBe("message");
    expect(opener?.type === "message" && opener.button?.label).toBe("Ha");
    expect(result.graph.edges.find((e) => e.from === "b1")?.handle).toBe("tap");
    expect(result.graph.edges.filter((e) => e.from === "b1")).toHaveLength(1);
    expect(result.warnings.some((w) => /avtomatik/.test(w))).toBe(true);
  });

  it("inserts an opening message before a multi-button block", () => {
    const result = parseGraphFromLlm(
      wrap({
        nodes: [
          trigger,
          { id: "b1", type: "button", text: "Qaysi model?", buttons: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
          { id: "m2", type: "message", text: "Rahmat" },
          end,
        ],
        edges: [
          { from: "t", to: "b1", handle: "next" },
          { from: "b1", to: "m2", handle: "tap:a" },
          { from: "b1", to: "m2", handle: "tap:b" },
          { from: "b1", to: "m2", handle: "other" },
          { from: "m2", to: "end", handle: "next" },
        ],
      })
    );
    expect(isFlowParseFailure(result)).toBe(false);
    if (isFlowParseFailure(result)) return;
    const opener = result.graph.nodes.find((n) => n.type === "message" && n.button);
    expect(opener).toBeTruthy();
    expect(result.graph.edges).toContainEqual({ from: "t", to: opener!.id, handle: "next" });
    expect(result.graph.edges).toContainEqual({ from: opener!.id, to: "b1", handle: "tap" });
    expect(result.graph.nodes.find((n) => n.id === "b1")?.type).toBe("button");
  });

  it("adds an opening button to a plain first message that is followed by more sends", () => {
    const result = parseGraphFromLlm(
      wrap({
        nodes: [trigger, { id: "m1", type: "message", text: "Salom!" }, { id: "m2", type: "message", text: "Narx 100 000 so'm" }, end],
        edges: [
          { from: "t", to: "m1", handle: "next" },
          { from: "m1", to: "m2", handle: "next" },
          { from: "m2", to: "end", handle: "next" },
        ],
      })
    );
    expect(isFlowParseFailure(result)).toBe(false);
    if (isFlowParseFailure(result)) return;
    const m1 = result.graph.nodes.find((n) => n.id === "m1");
    expect(m1?.type === "message" && !!m1.button).toBe(true);
    expect(result.graph.edges.find((e) => e.from === "m1")?.handle).toBe("tap");
  });

  it("renames next → tap on an opening message that already has a button", () => {
    const result = parseGraphFromLlm(
      wrap({
        nodes: [trigger, { id: "m1", type: "message", text: "Salom!", button: { id: "go", label: "Narx" } }, { id: "m2", type: "message", text: "100 000" }, end],
        edges: [
          { from: "t", to: "m1", handle: "next" },
          { from: "m1", to: "m2", handle: "next" },
          { from: "m2", to: "end", handle: "next" },
        ],
      })
    );
    expect(isFlowParseFailure(result)).toBe(false);
    if (isFlowParseFailure(result)) return;
    expect(result.graph.edges.find((e) => e.from === "m1")?.handle).toBe("tap");
  });

  it("inserts a generic opener before an ai / lead block that needs the window", () => {
    const result = parseGraphFromLlm(
      wrap({
        nodes: [
          trigger,
          { id: "ask", type: "ai", mode: "ask", question: "Telefon raqamingiz?", saveAs: "phone", extract: "phone", retries: 1 },
          { id: "lead", type: "lead", phoneFrom: "vars.phone" },
          end,
        ],
        edges: [
          { from: "t", to: "ask", handle: "next" },
          { from: "ask", to: "lead", handle: "next" },
          { from: "ask", to: "end", handle: "missing" },
          { from: "lead", to: "end", handle: "next" },
          { from: "lead", to: "end", handle: "missing" },
        ],
      })
    );
    expect(isFlowParseFailure(result)).toBe(false);
    if (isFlowParseFailure(result)) return;
    const opener = result.graph.nodes.find((n) => n.type === "message" && n.button);
    expect(opener).toBeTruthy();
    expect(result.graph.edges).toContainEqual({ from: opener!.id, to: "ask", handle: "tap" });
  });

  it("leaves DM flows and already-valid comment flows untouched", () => {
    const dm = {
      v: 1,
      variables: [],
      nodes: [{ id: "t", type: "trigger", triggerType: "DIRECT_MESSAGE", matchingMode: "EVERY" }, { id: "b1", type: "button", text: "Qaysi?", buttons: [{ id: "a", label: "A" }] }, end],
      edges: [
        { from: "t", to: "b1", handle: "next" },
        { from: "b1", to: "end", handle: "tap:a" },
        { from: "b1", to: "end", handle: "other" },
      ],
    };
    expect(repairCommentOpening(dm).fixes).toEqual([]);
    const ok = {
      v: 1,
      variables: [],
      nodes: [trigger, { id: "m1", type: "message", text: "Salom", button: { id: "go", label: "Narx" } }, { id: "m2", type: "message", text: "100 000" }, end],
      edges: [
        { from: "t", to: "m1", handle: "next" },
        { from: "m1", to: "m2", handle: "tap" },
        { from: "m2", to: "end", handle: "next" },
      ],
    };
    expect(repairCommentOpening(ok).fixes).toEqual([]);
  });
});
