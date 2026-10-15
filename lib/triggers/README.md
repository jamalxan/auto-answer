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
| `normalize.ts` | Webhook payload → `STORY_REPLY` / `STORY_MENTION` / `DIRECT_MESSAGE` / `COMMENT` / `LIVE_COMMENT`; `c2:` postbacks and quick replies → `DIRECT_MESSAGE` with `payload`. Pure. |
| `ingest.ts` | Stores events (unique per account + message id) and queues them. Called from the webhook route in its own try/catch. |
| `matching.ts` | EVERY / CONTAINS / EXACT, case-insensitive; picks the most specific campaign. Pure. |
| `processor.ts` | Claim → handler → status. Handler registry (STORY_REPLY, COMMENT, DIRECT_MESSAGE): add the next trigger here. |
| `delivery.ts` | Shared send path: token → workspace DM quota → hourly slot → send; execution lifecycle (SENT/SKIPPED end, leftover SENDING fails). |
| `contacts.ts` | Find-or-create contact and conversation; store messages idempotently. |
| `errors.ts` | Instagram error → admin-readable reason + technical detail + retryable or not. |
| `queue.ts` / `worker.ts` | Own BullMQ queue (5 attempts: 30s, 2m, 10m, 30m) and a sweep for lost jobs. |
| `service.ts` | Campaign CRUD, logs, contacts, manual retry, dry-run simulator. |
| `config.ts` / `access.ts` | Kill switch and the dev-only gate. |

## Comment Automation 2.0 (ETAP 2)

Design: `docs/developer/etap-2-comment-automation.md`.

```
comment webhook / backtrack ─▶ COMMENT event ─▶ comment-handler.ts
   selectCommentCampaign (EXACT > CONTAINS > INTENT > EVERY; specific post; priority; oldest)
   ─▶ TriggerExecution (variant chosen once) ─▶ public reply (optional, posted at most once)
                                             └▶ private reply [+ button c2:<execution>:open]
button tap / quick reply (c2:…) / plain DM ─▶ DIRECT_MESSAGE ─▶ direct-handler.ts
   open → main message + quick replies, follow-ups │ qr → MESSAGE / LEAD_CAPTURE / HANDOFF
   plain DM → lastInboundAt, stop on reply
worker maintenance (every minute) ─▶ followups.ts runDueFollowUps ─▶ DM or SKIPPED/CANCELLED
```

| File | Role |
|---|---|
| `keywords.ts` | `normalizeForMatch` (case, o‘/o'/oʻ, Uzbek + Russian Cyrillic → Latin, punctuation) and `BUILT_IN_INTENTS`. Pure. |
| `matching.ts` | `selectCommentCampaign` next to the story matcher. Pure. |
| `variants.ts` | RANDOM / SEQUENTIAL (atomic cursor) / WEIGHTED over approved variants; fallback `responseMessage`. |
| `comment-handler.ts` | `handleComment` (7-day private-reply rule, production overlap) and `simulateComment` (dry run). |
| `direct-handler.ts` | Taps, quick-reply actions, stop on reply; every send checks the 24h window and is sent once per event. |
| `followups.ts` | `scheduleFollowUps`, `cancelFollowUps`, `runDueFollowUps`, pure `decideFollowUp`. |
| `backtrack.ts` | `startBacktrack`: scan ≤ 25 posts back 1–7 days, ≤ 500 queued per run, counters on `TriggerBacktrackRun`. |
| `claim.ts` | `isCommentClaimedByCommentEngine` — production `processComment` steps aside for claimed comments (only "no active COMMENT campaign" is cached, 30s; campaigns themselves are read fresh so a stale "claimed" can never drop a comment). |

Meta rules: a private reply within 7 days, one per comment; anything after it
only inside the 24-hour window the person opened (tap or message) — a closed
window is a SKIPPED with the reason, never a forced send. Quick-reply taps
with a `c2:` payload are kept away from the DM keyword path and the assistant
(`findClaimedC2Messages`, used by the webhook route), and so are phone
numbers from someone with a pending lead whose chip payload did not come back
(`findClaimedLeadPhoneMessages`, rule in `lead-capture.ts`).

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
4. Comment 2.0 DMs inside the window (`direct-handler.ts`): an OUTBOUND
   `TriggerMessage` marker (`pending:<event>:<kind>`) is written before the
   send and swapped for Meta's mid after it; a retry that finds the marker does
   not send again. Follow-up runs use a `SENDING` lease the same way.

Known gap: when a send times out (network) *after* Meta delivered it, the
failure looks like any other send error, so the marker / lease is released and
the retry sends a second copy of that follow-up or in-window DM. Meta gives no
idempotency key to tell the two apart. Private replies are not affected: Meta
accepts only one private reply per comment, so a repeat is rejected.

## Known overlap to resolve before promotion

A story reply also arrives as a normal DM, so on a dev account it still goes
through the existing paths: DM-keyword campaigns (`dmTriggerEnabled`) and the
lead assistant (when it handles inbound DMs) can answer it as well. When the
engine is promoted, those paths should skip messages with
`reply_to.story` that a trigger campaign answered, and `TriggerConversation`
should be merged into the assistant's `Conversation` so JavobAI continues the
same thread.

## Next phases

Story Mention and Live Comment are already normalised and stored (status
`IGNORED`, "keyingi bosqich"); each needs only a handler in `EVENT_HANDLERS`. `STORY_REACTION` is reserved and never produced until its
payload is confirmed against real webhooks.
