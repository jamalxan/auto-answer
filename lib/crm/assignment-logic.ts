/**
 * ETAP 5.3 — operator assignment rules (TZ 31, 53).
 *
 * A rule fires on a trigger (HOT, new lead, handoff, stage, manual) and picks
 * an operator by strategy:
 *   ROUND_ROBIN — next active member after the rule's cursor
 *   TEAM        — round robin inside the rule's member list
 *   SPECIALIST  — only when one of the rule's product keywords matches the
 *                 extracted product, the lead product or a tag
 *                 (normalizeForMatch, whole words); then round robin among
 *                 the specialists. No match → null, the caller falls through
 *                 to the next rule.
 *
 * The cursor is the rule's `cursor` column; the caller persists `nextCursor`
 * atomically (updateMany where cursor = old). Pure: no database.
 */

import { containsWords, normalizeForMatch } from "@/lib/triggers/keywords";
import type { CrmAssignmentRuleRow, CrmAssignmentTrigger } from "./types";

export interface AssignmentCandidate {
  memberId: string;
  /** Inactive (on leave, removed from the team, VIEWER) members are skipped. */
  active: boolean;
}

export interface AssignmentContext {
  /** Product JavobAI extracted from the conversation. */
  product?: string | null;
  /** Lead.productInterest. */
  leadProduct?: string | null;
  /** Tag names / slugs on the contact. */
  tags: string[];
}

export type AssignmentRule = Pick<CrmAssignmentRuleRow, "strategy" | "memberIds" | "productKeywords">;

export interface ChooseAssigneeInput {
  rule: AssignmentRule;
  /** Workspace operators in a stable order (createdAt asc); TEAM / SPECIALIST narrow it to rule.memberIds. */
  candidates: AssignmentCandidate[];
  cursor: number;
  context: AssignmentContext;
}

export interface AssignmentChoice {
  memberId: string;
  nextCursor: number;
  /** SPECIALIST: the keyword that matched, as written in the rule. */
  matchedKeyword?: string;
}

/** Members the rule rotates over, in rule order when it names them. */
export function assignmentPool(rule: AssignmentRule, candidates: AssignmentCandidate[]): AssignmentCandidate[] {
  if (rule.memberIds.length === 0) return candidates;
  const byId = new Map(candidates.map((c) => [c.memberId, c]));
  return rule.memberIds.map((id) => byId.get(id)).filter((c): c is AssignmentCandidate => Boolean(c));
}

/** Next active member at or after `cursor`, wrapping around; null when nobody is active. */
export function roundRobin(pool: AssignmentCandidate[], cursor: number): { memberId: string; nextCursor: number } | null {
  const n = pool.length;
  if (n === 0) return null;
  const start = ((Math.trunc(cursor) % n) + n) % n;
  for (let i = 0; i < n; i++) {
    const index = (start + i) % n;
    if (pool[index].active) return { memberId: pool[index].memberId, nextCursor: (index + 1) % n };
  }
  return null;
}

/** First rule keyword that appears as whole word(s) in the product, lead product or a tag. */
export function matchSpecialistKeyword(productKeywords: string[], context: AssignmentContext): string | null {
  const haystacks = [context.product, context.leadProduct, ...context.tags]
    .map((text) => normalizeForMatch(text ?? ""))
    .filter(Boolean);
  if (haystacks.length === 0) return null;
  for (const keyword of productKeywords) {
    const normalized = normalizeForMatch(keyword);
    if (!normalized) continue;
    if (haystacks.some((text) => containsWords(text, normalized))) return keyword;
  }
  return null;
}

export function chooseAssignee(input: ChooseAssigneeInput): AssignmentChoice | null {
  const { rule, cursor, context } = input;
  const pool = assignmentPool(rule, input.candidates);
  if (rule.strategy === "SPECIALIST") {
    const matchedKeyword = matchSpecialistKeyword(rule.productKeywords, context);
    if (!matchedKeyword) return null;
    const pick = roundRobin(pool, cursor);
    return pick ? { ...pick, matchedKeyword } : null;
  }
  // ROUND_ROBIN and TEAM share the path; TEAM differs only by the pool.
  return roundRobin(pool, cursor);
}

// ─── Rule selection ───────────────────────────────────────────────────────────

export type PickableRule = Pick<CrmAssignmentRuleRow, "id" | "active" | "trigger" | "stageId" | "priority" | "createdAt">;

/** Higher priority first, then the older rule (same convention as trigger campaigns). */
export function sortRules<R extends Pick<CrmAssignmentRuleRow, "priority" | "createdAt">>(rules: R[]): R[] {
  return [...rules].sort((a, b) => {
    const priority = (b.priority ?? 0) - (a.priority ?? 0);
    if (priority !== 0) return priority;
    return a.createdAt.getTime() - b.createdAt.getTime();
  });
}

/** Active rules for the trigger, best first (ON_STAGE rules must name the stage). */
export function rulesFor<R extends PickableRule>(rules: R[], trigger: CrmAssignmentTrigger, stageId?: string | null): R[] {
  return sortRules(
    rules.filter((rule) => {
      if (!rule.active || rule.trigger !== trigger) return false;
      if (trigger === "ON_STAGE") return Boolean(stageId) && rule.stageId === stageId;
      return true;
    })
  );
}

/** The rule to try first for this trigger; the caller falls through `rulesFor` when it yields null. */
export function pickRule<R extends PickableRule>(rules: R[], trigger: CrmAssignmentTrigger, stageId?: string | null): R | null {
  return rulesFor(rules, trigger, stageId)[0] ?? null;
}
