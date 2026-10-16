/**
 * Starter template shape (analysis §5). Graphs are written as schema input
 * (defaults omitted) and parsed once at load by templates/index.ts.
 */

import type { FlowGraph, FlowGraphInput, FlowTriggerType } from "../schema";

export type FlowTemplateCategory = "sales" | "story" | "ads" | "faq" | "giveaway";

export interface FlowStarterTemplateInput {
  key: string;
  name: string;
  description: string;
  triggerType: FlowTriggerType;
  category: FlowTemplateCategory;
  /** Tag slugs the template expects (shown as "will be created" on copy). */
  tags: string[];
  graph: FlowGraphInput;
}

export interface FlowStarterTemplate extends Omit<FlowStarterTemplateInput, "graph"> {
  /** Parsed and structurally valid. */
  graph: FlowGraph;
}
