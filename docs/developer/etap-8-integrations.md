# ETAP 8 — Integrations 2.0 (developer area)

Master TZ: sections 41–42 and 63 (ETAP 8). Built at `/developer/integrations`
as an outbound **event bus** next to the existing lead-delivery pipeline.

## What exists and stays

Telegram lead card, amoCRM and Bitrix24 lead push, `Integration` with
encrypted credentials, `LeadDelivery` with the 30s / 2m / 10m / 1h / 6h retry
schedule, lease-claim + sweep + redeliver, connection checks, the dashboard
page. None of that is rewritten: `LeadDelivery` keeps serving TELEGRAM /
AMOCRM / BITRIX24. One production guard ships with the new types:
`enqueueLeadDeliveries` uses a positive type list, so a WEBHOOK / SHEETS /
MAKE / ZAPIER row never gets a `LeadDelivery`.

## Bus (`lib/integrations2`)

Events (string type + zod payload v1, snake_case for Make / Zapier mapping):
`lead.created`, `lead.hot`, `lead.updated`, `contact.tagged`,
`deal.stage_changed`, `handoff.opened`, `broadcast.completed`. Each has a
`dedupeKey` (unique per workspace) so retries and redeliveries never emit
twice. `emitOutbound` is fire-and-forget (like `crmTouch`); lead events
materialise 3 s later (the score insight is written after the lead), then
the worker freezes the payload, matches `IntegrationSubscription` filters
(temperatures, min score, accounts, channels, tags, stages, include_test,
include_transcript) and creates `OutboundDelivery` rows.

Payload: `{ id, type, version, occurred_at, is_test, workspace, account,
lead, score {value, temperature, band, signals}, source {kind, channel,
campaign, ad_id, ref}, contact {status, tags, assigned_member}, deal
{pipeline, stage, from_stage}, extra {email, budget, location}, handoff,
broadcast, transcript? }`.

Delivery engine mirrors `lib/leads/delivery.ts`: lease-claim, retries on
the same schedule, DEAD after 6 attempts, auth errors mark the integration
BROKEN, manual redeliver per delivery / per event, "redeliver all DEAD",
retention 30 days, Telegram alert on DEAD (throttled per integration per
hour), per-integration rate limit (default 60/min) + per-second slot.
Kill switch `INTEGRATIONS_BUS_DISABLED=1`.

## Connectors

- **Webhook** (+ **Make**, **Zapier** presets as their own types with the
  same code): POST JSON, no redirects, 10 s timeout, headers
  `X-SocialAuto-Event`, `-Event-Id`, `-Delivery-Id`, `-Timestamp`,
  `-Signature: v1=<hmac-sha256(secret, ts + "." + body)>`. 2xx → SENT;
  408 / 425 / 429 / 5xx / network → retry (honour `Retry-After` ≤ 6h);
  other 4xx → DEAD; 410 → DEAD + subscription disabled. URL policy at save
  **and** before every send: https, no userinfo, internal hostnames and
  DNS-resolved private addresses refused (reuses `lib/integrations/net.ts`).
  Secret `whsec_…` generated server-side, shown once, rotatable with a 24h
  overlap (two signatures).
- **Google Sheets**: tenant service account (client_email + private_key
  encrypted like tokens), RS256 JWT signed with `node:crypto` → OAuth token
  (cached ~50 min in Redis) → `values:append`; headers auto-created, missing
  tab added; 403 → "share the sheet with <client_email>"; one sheet per
  workspace, append-only. No new dependency.
- **amoCRM / Bitrix24 enrichment** (opt-in per integration): score note,
  `hot` / `warm` tags, score custom field, CrmStage → status map on
  `deal.stage_changed`. Waits for the lead push of the same lead to be SENT.
- **Telegram HOT channel**: subscription on the Telegram integration with a
  temperature filter and the TZ 41.1 card (name / phone / product / score /
  source).

## Decisions

Technical (from the analysis, accepted): full E.164 phone in payloads; one
sheet per workspace, append-only; non-retryable 4xx → DEAD, auto-disable
after 5 consecutive DEAD; Make / Zapier as distinct `IntegrationType`
values; test events go to the real tenant endpoints flagged `is_test`
(same as ETAP 4); 30-day retention; enrichment one-way; Zapier REST hooks /
app deferred. Owner decision pending: whether the HOT card goes to the same
workspace chat or a dedicated sales chat (default: same chat, enriched).

Click / Payme: needs a merchant contract and current API docs first, and a
decision on *whose* payments (SocialAuto billing vs a tenant's customers).
Nothing in ETAP 8 depends on it.

## Data model (new tables only)

`IntegrationType` + WEBHOOK, GOOGLE_SHEETS, MAKE, ZAPIER (own migration);
`OutboundEvent` (workspace, type, subject, payload, dedupeKey, materializedAt),
`OutboundDelivery` (event × integration, status PENDING / SENT / FAILED /
DEAD / SKIPPED, attempts, nextAttemptAt, responseCode, responseSnippet
≤300 chars with phones masked, signature, externalId), `IntegrationSubscription`
(integration × eventType, filter JSON, active).

## Sub-phases

| Phase | Scope | Done when |
|---|---|---|
| 8.0 Bus + Webhook | tables, queue/worker, emit / materialise / deliver / retry / DEAD / redeliver, url policy, signing, production guard, Connectors + Deliveries tabs | test lead → receiver shows a valid signature; private host refused; 500 → retried → DEAD → redeliver works; bus disabled leaves tests green |
| 8.1 Telegram HOT | optional Score / Source lines, HOT subscription | TZ 41.1 card for a JavobAI HOT lead; production card unchanged |
| 8.2 Google Sheets | JWT + append spike, connector, headers, test append | lead row in the tenant sheet; unshared sheet → share hint |
| 8.3 Events + Make/Zapier | remaining events, presets, Events + Docs tabs, payload preview | each event reaches a Make scenario and a Zapier Catch Hook once |
| 8.4 CRM enrichment | amo / Bitrix enrichment + config UI | score note + tag + field in amo; stage map works |
| 8.5 Hardening | rate limits, rotation, alert throttling, retention, TESTING.md I-scenarios | scenarios pass on a real workspace |
