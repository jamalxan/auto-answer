# Instagram Trigger Engine (DEV)

Phase A (shared event engine) + Phase B (Story Reply), built as a separate
vertical slice. Not part of the product yet: it lives in the developer area at
`/developer/triggers` (API `/api/developer/triggers`), behind the developer
login — see `lib/developer/`.

```
Instagram ─▶ /api/webhook ─▶ normalize.ts ─▶ InstagramEvent (row) ─▶ queue "instagram-triggers"
                                                                       │
                       worker.ts ◀─────────────────────────────────────┘
                          │
                     processor.ts: claim ─▶ handler by event type
                                             └ STORY_REPLY: contact ─▶ conversation ─▶ match campaign
                                                            ─▶ TriggerExecution ─▶ DM ─▶ log
```

| File | Role |
|---|---|
| `normalize.ts` | Webhook payload → `STORY_REPLY` / `STORY_MENTION` / `DIRECT_MESSAGE` / `COMMENT` / `LIVE_COMMENT`. Pure. |
| `ingest.ts` | Stores events (unique per account + message id) and queues them. Called from the webhook route in its own try/catch. |
| `matching.ts` | EVERY / CONTAINS / EXACT, case-insensitive; picks the most specific campaign. Pure. |
| `processor.ts` | Claim → handler → status. Handler registry: add the next trigger here. |
| `contacts.ts` | Find-or-create contact and conversation; store messages idempotently. |
| `errors.ts` | Instagram error → admin-readable reason + technical detail + retryable or not. |
| `queue.ts` / `worker.ts` | Own BullMQ queue (5 attempts: 30s, 2m, 10m, 30m) and a sweep for lost jobs. |
| `service.ts` | Campaign CRUD, logs, contacts, manual retry, dry-run simulator. |
| `config.ts` / `access.ts` | Kill switch and the dev-only gate. |

## Isolation

- Own tables (`InstagramEvent`, `TriggerCampaign`, `TriggerExecution`,
  `InstagramContact`, `TriggerConversation`, `TriggerMessage`), own queue, own
  worker. The migration only creates tables; it alters nothing existing.
- Events are stored only for Instagram accounts that have at least one trigger
  campaign — and only dev users can create one. Every other account is skipped
  before anything is written.
- `TRIGGER_ENGINE_DISABLED=1` turns ingestion and the worker off entirely.

## Duplicate protection

1. `InstagramEvent @@unique([instagramAccountId, messageId])` — a redelivered
   webhook is dropped at insert time.
2. Atomic claim (`PENDING|RETRYING → PROCESSING`, 5-minute lease) — two jobs
   for one event cannot both run it.
3. `TriggerExecution @@unique([eventId, campaignId])` — `SENT` ends the job; a
   leftover `SENDING` (process died mid-send) fails instead of re-sending.
   Only a manual "Qayta ishlash" from the logs releases it.

## Known overlap to resolve before promotion

A story reply also arrives as a normal DM, so on a dev account it still goes
through the existing paths: DM-keyword campaigns (`dmTriggerEnabled`) and the
lead assistant (when it handles inbound DMs) can answer it as well. When the
engine is promoted, those paths should skip messages with
`reply_to.story` that a trigger campaign answered, and `TriggerConversation`
should be merged into the assistant's `Conversation` so JavobAI continues the
same thread.

## Next phases

Story Mention, Direct Message and Live Comment are already normalised and
stored (status `IGNORED`, "keyingi bosqich"); each needs only a handler in
`EVENT_HANDLERS`. `STORY_REACTION` is reserved and never produced until its
payload is confirmed against real webhooks.
