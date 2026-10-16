# ETAP 6 + 7 — Flow Builder, AI Flow Builder, AI Auditor (developer area)

Master TZ: sections 34–40, 55 and 63 (ETAP 6/7). Full architecture analysis:
`docs/developer/analysis/etap-6-7-flow-builder-analysis.md`. Built at
`/developer/flows` on top of the trigger engine, JavobAI and the CRM.

## Decisions (owner, 2026-10-17)

1. **Approval before publish is required only for AI-generated versions**
   (TZ §39). Manually built flows publish directly; audit + policy run for
   both and a BLOCKED verdict stops any publish.
2. **Story Reply V1 stays as it is** — flows cover COMMENT, LIVE_COMMENT,
   DIRECT_MESSAGE (incl. ads / ig.me links) and STORY_MENTION. Story Reply
   joins flows later with the ETAP 11 migration step.

Technical decisions (from the analysis, accepted): flows **coexist** with
Comment 2.0 / Direct campaigns through a *proxy* `TriggerCampaign` row
(`kind = FLOW`) so the webhook's single claim/ownership decision stays the
only one; proxy rows are hidden from `/developer/comments` and
`/developer/triggers` lists. AI node = JavobAI only (`takeover`) plus a
small budget-gated `ask` extraction (allowed even when JavobAI is OFF).
Webhook node: https + SSRF guard always, host allowlist = Warning only until
ETAP 8. Lead node on every account (`isTest` from JavobAI config, default
true in dev). Unpublish/archive with waiting runs → cancelled on the next
sweep. Delay with the window closed → `end` by default. Spam: 3 consecutive
sends = Warning, 6 = Blocked; max run age 7 days; per-node visit cap 20.
Model for builder/audit: `JAVOBAI_MODEL_SMART` (fallback default).

## Data model (new tables only)

`Flow` (workspace, account, name, status DRAFT / REVIEW / PUBLISHED /
ARCHIVED, mode SIMPLE / ADVANCED, currentVersionId, publishedVersionId,
proxyCampaignId), `FlowVersion` (immutable graph JSON, schemaVersion,
source MANUAL / AI / TEMPLATE, approvedAt / approvedBy, publishedAt,
auditJson, policyJson, testPassedAt), `FlowRun` (per contact: versionId,
status RUNNING / WAITING_TAP / WAITING_INBOUND / WAITING_DELAY / DONE /
CANCELLED / FAILED, currentNodeId, vars JSON, anchors for the 24h window,
sends counter, waitUntil, eventId / executionId links), `FlowRunStep`
(log: node, handle taken, outcome, error, at), `FlowTemplate` (seeded
starters + user-saved). `TriggerCampaign` gets `kind` (CAMPAIGN | FLOW) and
`flowId` (additive). Quick-reply / button payloads use the prefix
`fl:<runId>:<nodeId>:<buttonId>`.

## Graph

`lib/flows/schema.ts` — zod discriminated union of node types trigger,
message, button, ai, condition, delay, tag, lead, webhook, crm, operator,
action, end, edges with handles (`next`, `tap`, `tap:<id>`, `other`,
`timeout`, `branch:<id>`, `else`, `missing`, `error`, `window_closed`),
variables, optional layout. Structural checks: exactly one trigger, unique
ids, edges reference existing nodes, required handles present, a message
with a button after a COMMENT trigger has no `next` (nothing can be sent
before the tap).

`lib/flows/variables.ts` — `{{name}}`, `{{vars.x|fallback}}`, vocabulary
(contact.*, vars.*, trigger.*, last_message.*, tags, score, temperature,
audience, window.open, time.*); unknown key = audit error; empty value at
runtime = fallback or "".

`lib/flows/conditions.ts` — same DSL as CRM segments, compiled to an
in-memory predicate; `keyword` / `intent` operators reuse the campaign
normaliser.

## Engine

Published flow → proxy campaign → the existing claim decides the owner →
`FlowRun` created on the event → step loop: each node runs with
idempotency per (run, seq) using the `pending:` marker technique of the
trigger engine; sends go through `sendGuarded`; Button/AI-ask/Delay nodes
park the run (WAITING_*) and the webhook resumes it on `fl:` taps / inbound
messages (claimed like lead-phone messages); Delay = BullMQ delayed job +
sweep, window checked before any send after a wait. A waiting run owns the
thread: JavobAI and Direct triggers stay silent (`findActiveConversations`
extended). Per-contact lock, max steps / loop guard, run age limit.

## Simple Mode, AI builder, policy, auditor

Simple Mode = vertical stacked blocks (no canvas). AI builder: Uzbek prompt
+ node schema + few-shot templates → JSON graph (zod) → repair round →
preview → audit → sandbox test (dry run, effects stubbed) → approve →
publish as a new version (waiting runs continue on their version).
Policy at publish (PASS / WARNING / BLOCKED): COMMENT flow without an
opening button → BLOCKED; send after Delay with no prior tap/inbound →
BLOCKED; >3 consecutive sends → WARNING, >6 → BLOCKED; price text under
NEVER policy → WARNING; AI node without a handoff path → WARNING; webhook
to a private host → BLOCKED; endless loop / unreachable / dead-end → ERROR.
Auditor (TZ §40): graph analysis + content heuristics, LLM suggestions
shown separately and never change verdicts.

## Starter templates (Uzbek market)

T1 comment → price → catalog → phone → lead → Telegram; T2 story mention →
DM; T3 ad message → qualification → CRM; T4 FAQ with JavobAI takeover;
T5 giveaway announcement → participation confirm + tag.

## Sub-phases

| Phase | Scope | Done when |
|---|---|---|
| 6.0 Core | schema, engine, proxy publish, nodes trigger / message / button / condition / delay / end | Scenario A end to end; retries never double-send; Delay past 24h never sends; `FLOWS_DISABLED=1` leaves everything as before |
| 6.1 Nodes | tag / lead / operator / webhook / crm / action / ai | Lead node creates a real Lead delivered to Telegram; webhook to a private host refused; AI takeover hands to JavobAI on LIVE |
| 6.2 Simple Mode + templates | list, stacked editor, inspector, templates, runs tab, versions | each template copies, audits with 0 errors, runs in the sandbox |
| 6.3 Advanced canvas | canvas, auto-layout, diff, publish/unpublish | a branch flow built on the canvas publishes; v2 keeps v1 runs on v1 |
| 7.0 AI builder + auditor + policy | ai-builder, audit, policy, test console, publish dialog | TZ §39 prompt produces a valid graph; auditor flags dead-end + unknown variable; policy blocks a COMMENT flow without a button; AI versions need test + approve |
