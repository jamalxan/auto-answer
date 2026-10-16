/**
 * Flow editor logic that must stay context-aware: the "message needs a button" note belongs to the first
 * message of a comment flow only; the live count of unconnected outputs mirrors the audit's dead-end errors.
 */

import { describe, expect, it } from "vitest";
import { countUnconnected } from "../components/developer/flows/graph-edit";
import { messageButtonHint } from "../components/developer/flows/node-inspector";
import { auditGraph } from "../lib/flows/audit";
import { flowGraphDraftSchema, type FlowGraphInput } from "../lib/flows/schema";

const graphOf = (triggerType: "COMMENT" | "DIRECT_MESSAGE", withEdges = true) => {
  const input: FlowGraphInput = {
    v: 1,
    variables: [],
    nodes: [
      { id: "t", type: "trigger", triggerType, matchingMode: "EVERY" },
      { id: "m1", type: "message", text: "Salom" },
      { id: "m2", type: "message", text: "Yana salom" },
      { id: "end", type: "end" },
    ],
    edges: withEdges
      ? [
          { from: "t", to: "m1", handle: "next" },
          { from: "m1", to: "m2", handle: "next" },
          { from: "m2", to: "end", handle: "next" },
        ]
      : [{ from: "t", to: "m1", handle: "next" }],
  };
  return flowGraphDraftSchema.parse(input);
};

describe("messageButtonHint", () => {
  it("only the first message of a comment flow is said to need a button", () => {
    expect(messageButtonHint(graphOf("COMMENT"), "m1")).toContain("birinchi xabar tugmali bo'lishi shart");
    expect(messageButtonHint(graphOf("COMMENT"), "m2")).not.toContain("shart");
  });

  it("a Direct flow never gets the comment-only rule", () => {
    expect(messageButtonHint(graphOf("DIRECT_MESSAGE"), "m1")).not.toContain("shart");
  });
});

describe("countUnconnected", () => {
  it("matches the audit's dead-end errors for the same graph", () => {
    const open = graphOf("DIRECT_MESSAGE", false);
    const audit = auditGraph(open, {});
    expect(countUnconnected(open)).toBeGreaterThan(0);
    expect(audit.errors.some((e) => e.code === "dead_end")).toBe(true);
    const full = graphOf("DIRECT_MESSAGE");
    expect(countUnconnected(full)).toBe(0);
    expect(auditGraph(full, {}).errors.filter((e) => e.code === "dead_end")).toEqual([]);
  });
});
