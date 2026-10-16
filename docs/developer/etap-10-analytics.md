# ETAP 10 — Analytics + Observability (developer area)

Master TZ: sections 47–49 (analytics, funnel, date filters) and 65
(observability). Built at `/developer/analytics`.

## Decisions (owner)

1. **The content scheduler is deferred** until the Meta publishing
   permission exists. ETAP 10 is analytics and observability only; the module
   registry entry is "Analitika" and has no scheduler item.
2. **"Sale" = a `CrmDeal` that reached a WON stage.** Contacts hand-marked
   CUSTOMER without a deal are reported separately (`sales.customer_marked`)
   and never added to sales.
3. **"Resolved by AI" is strict in v1:** an `AiLeadInsight` (lead collected)
   whose conversation has never had an `AiHandoff` up to the end of that day.
4. **Funnel "Comments" = what SocialAuto saw:** `InstagramEvent` COMMENT rows
   plus `DmLog` rows of the day. Comments Meta never delivered cannot be counted.
5. "Delivered" equals "sent" in v1 (label "Qabul qilindi (Meta)"): Meta gives
   no per-message delivery receipt for these sends.

## Architecture

```
sources (DmLog, TriggerExecution, Lead, CrmDeal, AiLeadInsight, LlmUsage, ...)
        |  computeDayMetrics(workspaceId, dayKey)      lib/analytics/compute.ts  <- the ONLY metric definitions
        v
 AnalyticsDaily  (rollup.ts: delete (workspace, day) + createMany in one transaction)
        |
        v  read.ts (ranges, zero-filled series, compare, derived rates, labels)
 GET /api/developer/analytics  ->  components/developer/analytics
```

* Rows are sums and counts only; rates (CTR, conversion, success, averages)
  are derived at read time from summed parts (`catalog.ts`).
* `instagramAccountId ""` is the workspace-wide row; every event is added to
  the workspace row and to its account's row. `dimKind/dimId` slice a metric
  (automation, trigger_campaign, broadcast, reason, kind, pipeline, member);
  the `""` dim row is always the total.
* Days are Asia/Tashkent. The helpers are the ones in `lib/javobai/usage.ts`
  (re-exported by `lib/analytics/time.ts`; no third copy).
* Aggregation uses `findMany` + in-memory sums (not `groupBy _sum`), like
  `usage.ts`, so it runs on the in-memory test db.
* Test leads (`Lead.isTest`, `AiLeadInsight.isTest`) are excluded; every
  query is scoped by `workspaceId`.

## When rollups run

| What | When | Where |
|---|---|---|
| Yesterday + today, every active workspace | every 10 minutes (self-throttled) | worker maintenance tick (`lib/analytics/worker.ts`) |
| Trailing 3 days | nightly 00:15 Asia/Tashkent (19:15 UTC) | `GET /api/cron/analytics-rollup` (vercel.json + scripts/cron.sh) |
| Last N days (default 90, max 366) | on demand | `POST /api/developer/analytics/backfill?days=` -> "analytics" queue (202) |
| Up to 7 days inline | on demand | `POST /api/developer/analytics/recompute?from&to` |

Recomputing a day REPLACES its rows (idempotent). Kill switch:
`ANALYTICS_DISABLED=1` stops the worker, the maintenance tick, the cron and the
enqueue routes; stored rollups stay readable.

## Metric catalog

Campaign: `campaign.sent` (DmLog SENT by `dmSentAt ?? createdAt`; TriggerExecution
SENT by `sentAt`; CrmBroadcastRecipient SENT by `sentAt`), `.followup_sent`,
`.delivered`, `.failed`, `.skipped` (reason sub-dim), `.replies`
(legacy: Conversation with a campaign; trigger: `firstInboundAt`, else
`openedAt`; broadcast: `repliedAt`), `.clicks`, `.leads` (Lead with campaignId;
trigger `leadCapturedAt` — trigger lead capture writes no Lead row, so no
double count), `.conversions` (won deal of a campaign lead; broadcast `convertedAt`).

AI: `ai.conversations` (AiConversationState created; SHADOW is stateless and
creates none), `assistant.conversations`, `ai.resolved`, `ai.handoff`
(+reason), `ai.handoff_accepted`, `ai.handoff_wait_ms_sum/_count`,
`ai.qualified` (WARM/HOT insight), `ai.hot` (CRM TEMPERATURE_CHANGED -> HOT,
one per contact per day; falls back to HOT insights when the CRM wrote
none), LLM `ai.calls/failed_calls/cost_usd/latency_ms_sum/tokens_in/out`
(+kind), `ai.shadow_turns`, `ai.blocked_replies/fallbacks/llm_errors`
(AssistantEvent), `msg.customer/ai/operator`.

Sales: `sales.leads`, `sales.qualified` (STAGE_CHANGED out of the entry stage,
once per deal per day), `sales.won/lost` (+pipeline, +member), score and
cycle sums, `sales.customer_marked`.

Funnel: `funnel.comments`, `funnel.dms` (campaign.sent without follow-ups and
broadcasts). Cohort funnel is live from `CrmContact` (first interaction in range -> source
COMMENT -> DM sent -> replied -> deal -> hot -> won, each stage a subset of
the previous). AI vs human uses the nightly `cohort.ai_only.*` /
`cohort.handed_off.*` rows (conversations AI started that day, with or without a handoff).

`TriggerExecution.firstInboundAt` is set once, in `touchInbound`
(`lib/triggers/direct-handler.ts`) and the DM-trigger opening
(`lib/triggers/dm-trigger-handler.ts`); older rows fall back to `openedAt`.

## Observability (TZ 65)

`GET /api/developer/analytics/kpi` reads live tables over short windows:
connections, active campaigns, messages/min (+ 10-point sparkline), DM queue,
queue depths (platform-wide: dm-processing, lead-assistant, instagram-triggers,
javobai, crm, analytics), errors 1h/24h, Meta error rate, AI latency / cost today,
message success, webhook delay (createdAt - timestamp), today's rollup counters,
worker health. Each loader is isolated: a failure is `null` + a `failed` entry.

Alerts (`lib/analytics/alerts.ts`), per workspace, cooldown 6 h per rule in
`AnalyticsAlertState`, delivered through `alertWorkspace`: worker stale > 2 min;
Meta error rate > 20% with >= 10 attempts / 15 min; DM queue ETA > 60 min; webhook
delay max > 5 min; LLM failure rate > 30% with >= 5 calls / 15 min. They are evaluated
in the worker tick (every 5 min) and, because a dead worker cannot report itself,
also by `scripts/cron.sh` calling `analytics-rollup?task=alerts` from the web process.

## Permissions

Reads: `view_analytics` (every role). Recompute and backfill:
`manage_campaigns` and not VIEWER (`lib/developer/analytics-guard.ts`).

## Not done

* Content scheduler (deferred, see decision 1).
* Flows / Integrations queue depths (their queues belong to other modules; add a row to
  `loadQueueDepths` in `lib/analytics/kpi.ts` when they settle).
