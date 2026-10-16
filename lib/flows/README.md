# lib/flows — Flow Builder (ETAP 6/7)

Decisions: `docs/developer/etap-6-7-flow-builder.md`. Full analysis:
`docs/developer/analysis/etap-6-7-flow-builder-analysis.md`. The modules in
the first table (schema, variables, conditions, graph, policy, audit,
templates, ai-builder-prompt) are pure and DB-free; the execution engine
(`runner`, `effects`, `engine`, `bridge`, `queue`, `worker`, `publish`,
`sandbox`, `runs`) is described in "Execution engine" below.

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

## Execution engine (ETAP 6.0 / 6.1)

Only `schema` .. `ai-builder-prompt` above are DB-free. The engine is:

| Module | Role |
|---|---|
| `runner.ts` | **Pure step loop.** `advance(run, index, fx, signal?)`, `planSignal`, `consumesPlainText`, `extractByCode`. Node logic is written once here. No Prisma, no Redis, no Meta. |
| `effects.ts` | `FlowEffects` **port**. `createRealEffects(input)`: Prisma + `delivery.sendGuarded` + Meta + CRM + JavobAI + Telegram + SSRF-guarded webhook. |
| `effects-memory.ts` | Same port, in memory (sandbox, tests): records sends / tags / leads, fake clock, no I/O. |
| `engine.ts` | DB entry points: `startFlowRun`, `resumeFlowRun`, `continueFlowRun`, `runDueFlowRuns`, `sweepFlowRuns`. |
| `bridge.ts` | The seam with `lib/triggers`: `startFlowFromCampaign`, `handleFlowTap`, `handleFlowInbound`, `findConsumingRun`, `flowOwnsThread`, `parseFlowPayload`. Light; the engine is imported lazily. |
| `config.ts` | `isFlowsEnabled()` (`FLOWS_DISABLED=1` kill switch), `flowKindFilter()`, `isFlowPayload()`. |
| `queue.ts` / `worker.ts` | BullMQ queue `flows` (`flow-resume`, `flow-run-step`), concurrency 3, `runFlowsMaintenance()` every 60s. |
| `publish.ts` | `publishFlowVersion`, `unpublishFlow`, `archiveFlow`: the proxy campaign transaction + gating. |
| `sandbox.ts` | `runFlowSandbox(workspaceId, graph, input)`: dry run through the real loop, no writes. |
| `runs.ts` | `listRuns`, `getRun`, `cancelRun`, `flowStats` (Runs tab). |

### How a flow gets a seat in the trigger engine

Publishing creates one hidden `TriggerCampaign` (`kind = FLOW`, `Flow.proxyCampaignId`),
a 1:1 copy of the Trigger node's matching fields. The webhook's single claim
(`decideDmTrigger`, `isCommentClaimedByCommentEngine`, the account gate, cooldown,
priority) therefore needs no second code path. When a handler selects a FLOW
campaign it calls `startFlowFromCampaign` instead of sending the campaign's own
message (`comment-handler`, `live-handler`, `dm-trigger-handler`: one line each).
Proxy rows are hidden from the `/developer/comments` and `/developer/triggers` lists
(`kind: "CAMPAIGN"` filters). With `FLOWS_DISABLED=1` the loaders filter FLOW rows out
(`flowKindFilter`), the gate ignores them, `fl:` payloads are not ours: production and the
ordinary campaigns behave as before flows existed.

### Run lifecycle

```
start    handler → TriggerExecution (unique per event+campaign) → FlowRun (unique per executionId)
         one live run per (account, person); advisory lock like the DM claim
advance  take the run (CAS WAITING_* → ACTIVE) → loop: execute node → commit step
         (CAS on seq + status ACTIVE; FlowRunStep unique per (run, seq)) → follow the edge
park     message with button / button node / ai.ask / delay / window closed / retry → WAITING_*
signal   tap (fl:<run>:<node>:<button>) · typed answer · timer → planSignal → acquire → advance
end      end node, dead end, takeover, operator, guards → DONE / FAILED / CANCELLED
```

Waits (`FlowRun.waitKind`): `tap` (message button; typed text is NOT consumed), `choice`
and `phone` (button node; typed text is consumed: `other` edge, `keep_waiting`, or a typed
number satisfies a phone chip), `inbound` (AI ask), `reopen` (window closed + `wait_for_inbound`),
`delay`, `retry` (retryable send failure: 30s, 2m, 10m, 30m, 60m, at most 5 tries).

### Send rules

- the first message of a COMMENT / LIVE_COMMENT run is the private reply (button template
  with payload `fl:<run>:<node>:<button>`); its idempotency is the proxy execution lifecycle
  (PENDING → SENDING → SENT; a leftover SENDING never re-sends);
- every other send checks the 24h window first (anchors on the proxy execution: `openedAt`,
  `lastInboundAt`, minus 5 minutes). Closed → the policy of the last Delay node the run passed:
  `end` (default: run DONE, reason "24 soatlik oyna yopilgan"), `skip_sends` or `wait_for_inbound`;
- idempotency per (run, seq): an OUTBOUND `TriggerMessage` with mid `flow:<run>:<seq>:pending`
  written before the send and renamed to `flow:<run>:<seq>:<Meta mid>`; a retry that finds either
  never sends again;
- `sendsSinceInbound` counts consecutive sends; at the policy cap (6) the run is CANCELLED ("Spam himoyasi");
- all sends go through `sendGuarded` (workspace quota, 750/h slot, token health).

### Guards

200 steps per run, 20 visits per node, 7 days of run age, 100 steps per `advance`. The sweep
(`sweepFlowRuns`) cancels WAITING runs of an unpublished / archived flow and runs older than 7 days,
continues a stuck ACTIVE run once (10 minutes) and then fails it, and deletes finished runs older than
`FLOW_RUN_RETENTION_DAYS` (90).

### Thread ownership (two-sided rules)

| Situation | Webhook claim | Handler |
|---|---|---|
| plain DM, run waits for text (ai.ask, button node, reopen, mid-step) | `findClaimedFlowMessages` keeps it from production / JavobAI | `handleFlowInbound` (`direct-handler.handlePlainMessage`) → `resumeFlowRun` |
| `fl:` tap | `findClaimedC2Messages` | `handleFlowTap` (`routeDirectMessage`), verified against the run's person / account / workspace |
| any live run, new DM | `decideDmTrigger` claims nothing (`FLOW_OWNS_THREAD_REASON`) | — |
| JavobAI | `runtime.ts` stays silent while a run consumes text; the operator node sets `handedOffAt` on the proxy execution (the existing silence rule) | — |

Both sides use `consumesPlainText` / `findConsumingRun`. A published version is pinned by
`FlowRun.versionId`: a new publish never changes a running conversation.

### Known limits

- a send that times out after Meta delivered it looks like a failure (same as the trigger engine);
- the webhook node makes one attempt (no 3-step backoff yet), `X-SocialAuto-Signature` only when `FLOW_WEBHOOK_SECRET` is set;
- `typingDelayMs` is stored but not used yet; Story Reply V1 is not a flow trigger (decision 2).

## Tests

`__tests__/flows-schema.test.ts`, `flows-variables.test.ts`,
`flows-conditions.test.ts`, `flows-audit-policy.test.ts`,
`flows-templates.test.ts` (each template: schema-valid, 0 audit errors,
policy PASS or WARNING).

Engine: `flows-engine.test.ts` (Scenario A end to end, no double sends, Delay past 24h,
conditions, ai.ask, webhook SSRF, operator, foreign taps, claim + handler agreement,
FLOWS_DISABLED, hidden lists, version pinning, CAS race, retry, sweeps),
`flows-bridge.test.ts` (publish gating, `fl:` normalisation, pure wait rules, Runs queries),
`flows-sandbox.test.ts` (no writes, deterministic, guards).
