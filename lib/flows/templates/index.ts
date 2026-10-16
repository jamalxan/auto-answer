/**
 * ETAP 6.2 — the five Uzbek starter templates (analysis §5), parsed once
 * with the strict schema. A template that stops validating fails at import
 * (and in __tests__/flows-templates.test.ts), never at copy time.
 */

import { flowGraphSchema } from "../schema";
import { T1_COMMENT_PRICE_LEAD } from "./t1-comment-price-lead";
import { T2_STORY_MENTION } from "./t2-story-mention";
import { T3_AD_QUALIFICATION } from "./t3-ad-qualification";
import { T4_FAQ_JAVOBAI } from "./t4-faq-javobai";
import { T5_GIVEAWAY } from "./t5-giveaway";
import type { FlowStarterTemplate, FlowStarterTemplateInput } from "./types";

export type { FlowStarterTemplate, FlowStarterTemplateInput, FlowTemplateCategory } from "./types";

export const FLOW_STARTER_TEMPLATE_INPUTS: FlowStarterTemplateInput[] = [
  T1_COMMENT_PRICE_LEAD,
  T2_STORY_MENTION,
  T3_AD_QUALIFICATION,
  T4_FAQ_JAVOBAI,
  T5_GIVEAWAY,
];

export const FLOW_STARTER_TEMPLATES: FlowStarterTemplate[] = FLOW_STARTER_TEMPLATE_INPUTS.map((template) => ({
  ...template,
  graph: flowGraphSchema.parse(template.graph),
}));

export function findStarterTemplate(key: string): FlowStarterTemplate | null {
  return FLOW_STARTER_TEMPLATES.find((t) => t.key === key) ?? null;
}
