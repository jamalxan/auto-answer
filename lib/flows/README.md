# lib/flows — Flow Builder (ETAP 6/7), pure modules

Decisions: `docs/developer/etap-6-7-flow-builder.md`. Full analysis:
`docs/developer/analysis/etap-6-7-flow-builder-analysis.md`. Everything in
this folder is DB-free (the `Flow*` Prisma models come with the engine
step); nothing here imports Prisma, Redis or the LLM provider.

## Module map

| Module | Exports | Role |
|---|---|---|
| `schema.ts` | `flowGraphSchema` (shape + structural checks), `flowGraphDraftSchema` (shape only), node schemas, `FlowGraph` / `FlowNode` / `FlowEdge` types, `NODE_LABELS`, `HANDLE_RULES` + `handlesFor(node)`, `isSendNode`, `isUserWaitNode`, `isUserInputHandle`, `sendText`, `templateFields`, `structuralIssues`, `parseFlowGraph`, `FLOW_LIMITS` | The graph contract (analysis §1.1) |
| `variables.ts` | `VARIABLE_SPECS`, `TEMPLATE_SHORTHANDS`, `FlowContext`, `renderTemplate(text, ctx) → { text, missing }`, `extractTemplateKeys`, `validateTemplateKeys(text, declaredVars)`, `parseTemplateRefs`, `resolveVariable`, `varsKey` | `{{key}}`, `{{a.b}}`, `{{key\|fallback}}` templating (§1.2) |
| `conditions.ts` | `flowFilterSchema` (`{ v:1, all, any? }`), `FIELD_SPECS`, `FLOW_OPERATORS`, `compilePredicate(filter)`, `evaluateFilter`, `evaluateBranches(node, ctx) → branchId \| "else"`, `describeCondition(filter)` | Condition DSL mirroring `lib/crm/segments.ts`; `keyword` / `intent` use the campaign normaliser |
| `graph.ts` | `buildIndex`, `reachableFrom`, `ancestorsOf`, `findUnreachable`, `findDeadEnds`, `findBrokenEdges`, `findCycles` / `findEndlessLoops` (Tarjan), `consecutiveSendsMax`, `pathsFromTrigger`, `windowStateAt` / `windowOpenAt`, `maxDelaySinceInputAt`, `variableSetters`, `phoneSources` | Structural helpers shared by audit and policy |
| `policy.ts` | `evaluatePolicy(graph, ctx) → { verdict: PASS \| WARNING \| BLOCKED, items }`, `POLICY_CODES`, `mentionsPrice`, `webhookUrlProblem` | Publish policy (§3.3) |
| `audit.ts` | `auditGraph(graph, ctx) → { errors, warnings, suggestions }` of `Finding { code, nodeId?, edgeIndex?, message, fix?, policyCode? }`, `AUDIT_CODES`, `auditPasses` | AI Flow Auditor, deterministic rules (§4, TZ 40). Policy is computed once and mapped in |
| `templates/` | `FLOW_STARTER_TEMPLATES` (T1–T5, parsed), `FLOW_STARTER_TEMPLATE_INPUTS`, `findStarterTemplate(key)` | Uzbek starters (§5) |
| `ai-builder-prompt.ts` | `buildFlowBuilderPrompt({ request, ... }) → { system, user, jsonSchema, schemaName }`, `FLOW_GRAPH_JSON_SCHEMA`, `parseGraphFromLlm(text)`, `buildRepairPrompt(previous, errors)` | Prompt contract for the AI builder (§3.2); no model call |

## Graph in one paragraph

`{ v: 1, nodes, edges, variables, layout? }`. Exactly one `trigger`
(COMMENT, LIVE_COMMENT, DIRECT_MESSAGE, STORY_MENTION — Story Reply V1 stays
separate, decision 2). Edges leave through handles: `next`, `tap` (message
button), `tap:<id>` / `other` / `timeout` (button), `branch:<id>` / `else`
(condition), `missing` (ai.ask, lead), `error` (webhook, crm), `window_closed`
(delay), `fallback` (ai.takeover when JavobAI is not LIVE). `handlesFor(node)`
is the single source of truth for required / optional / forbidden handles.

The 24h window is modelled structurally: for comment triggers the first send
must be a `message` with a `button` and nothing else runs until its `tap`;
for DM-side triggers the window is open from the trigger. `windowStateAt`
returns `open | closed | mixed` per node; policy blocks any send / button /
ai / lead / delay that is not `open`.

Two schemas: `flowGraphDraftSchema` accepts an incomplete graph (a draft
being edited); `flowGraphSchema` adds the structural checks and is what
templates, AI output and publishable versions must pass. The auditor and the
policy engine run on drafts too and report the same gaps as findings.

## How the engine (later) consumes these

- **Save draft**: `flowGraphDraftSchema.parse(body)` → `FlowVersion.graph`;
  `auditGraph` + `evaluatePolicy` stored as `auditResult` / `policyResult`.
- **Publish**: `flowGraphSchema.safeParse(graph)` must pass, `auditPasses`
  and `policyResult.verdict !== "BLOCKED"`; the Trigger node's fields become
  the proxy `TriggerCampaign` row.
- **Step loop**: `buildIndex(graph)` once per advance; `index.edgeOf(nodeId,
  handle)` picks the next node; `evaluateBranches(conditionNode, ctx)` gives
  the handle of a condition; `renderTemplate(text, ctx)` renders every send
  (`missing` goes to the step log); `isUserWaitNode` decides WAITING_* parking;
  `variableSetters` / `phoneSources` tell the lead node where the phone comes
  from. `FlowContext` is filled lazily by the engine (contact, vars, trigger,
  last_message, tags, score, temperature, audience, window, time, run).
- **AI builder**: `buildFlowBuilderPrompt` → provider (`JAVOBAI_MODEL_SMART`)
  → `parseGraphFromLlm` → on failure one round with `buildRepairPrompt` →
  `auditGraph` / `evaluatePolicy` → preview → sandbox → approve → publish.
- **Sandbox** and **effects port** (§2.4/2.5) sit on the same helpers; the
  node logic is written once in `engine.ts` (not here).

## Tests

`__tests__/flows-schema.test.ts`, `flows-variables.test.ts`,
`flows-conditions.test.ts`, `flows-audit-policy.test.ts`,
`flows-templates.test.ts` (each template: schema-valid, 0 audit errors,
policy PASS or WARNING).
