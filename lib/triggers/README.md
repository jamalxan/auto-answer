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
| `normalize.ts` | Webhook payload → `STORY_REPLY` / `STORY_MENTION` / `DIRECT_MESSAGE` / `COMMENT` / `LIVE_COMMENT` / `MESSAGE_REACTION`; `c2:` postbacks and quick replies → `DIRECT_MESSAGE` with `payload`; referrals → `referralSource` / `adId` / `ref`. Pure. |
| `ingest.ts` | Stores events (unique per account + message id) and queues them; for DM-side events also makes and stores the ETAP 3 claim (`claimedCampaignId`). Called from the webhook route first, in its own try/catch. |
| `matching.ts` | EVERY / CONTAINS / EXACT, case-insensitive; picks the most specific campaign. Pure. |
| `processor.ts` | Claim → handler → status. Handler registry (STORY_REPLY, COMMENT, DIRECT_MESSAGE, STORY_MENTION, LIVE_COMMENT, MESSAGE_REACTION): add the next trigger here. |
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

## Full Instagram Automation (ETAP 3)

Design and Meta rules: `docs/developer/etap-3-instagram-automation.md`.

```
webhook ─▶ ingest.ts claimAndStoreDmEvent (DM / mention / referral message,
     per-person advisory lock): claim.ts decideDmTrigger (comment thread owner?
     keywords / intents, audience, source ADS / LINK, cooldown, priority)
     ─▶ InstagramEvent.claimedCampaignId (+ rawPayload.dmClaim: keyword, reason)
     ─▶ route: claimed events skip the DM-keyword path and the assistant
DM ─▶ DIRECT_MESSAGE ─▶ direct-handler.ts: c2 taps │ lead phone │ bookkeeping on
     ACTIVE executions (comment, live, DM trigger; findActiveConversations:
     lastInboundAt, stop on reply) ─▶ dm-trigger-handler.ts runDmTrigger
story mention ─▶ STORY_MENTION ─▶ runDmTrigger
runDmTrigger: claimed campaign only (still active, same account) ─▶
     TriggerExecution (opened at the person's message) ─▶ variant + quick
     replies ─▶ follow-ups ("direct")
live comment ─▶ LIVE_COMMENT ─▶ live-handler.ts: private reply [+ button], no
     public reply, ≤ 4h old, a refused reply is final (live has ended)
reaction ─▶ MESSAGE_REACTION ─▶ stored, IGNORED (observation mode), never sent
```

| File | Role |
|---|---|
| `dm-trigger-handler.ts` | `DM_TRIGGER_TYPES`, `runDmTrigger` (answers with the claimed campaign only), `handleDirectEvent` / `handleStoryMention`, `simulateDmTrigger` (dry run, same `selectDmCampaign` rule). |
| `live-handler.ts` | `handleLiveComment`; Meta errors are final (`classifyLiveReplyError`). |
| `matching.ts` | `selectDmCampaign`: EXACT > CONTAINS > INTENT > EVERY, then source filter (2) / audience (1) beat ANY, then `priority`, then oldest; a campaign in its cooldown is skipped. Pure. |
| `claim.ts` | `decideDmTrigger` (the one decision, webhook only), `findActiveConversations` (shared by that decision and the direct handler's bookkeeping), `isActiveCommentConversation`, `readDmClaimNote`. |

Rules worth knowing:
- **One decision per DM.** "Does a DM trigger answer this?" is decided once,
  in the webhook, before the DM-keyword path and the assistant run
  (`ingest.ts claimAndStoreDmEvent` → `claim.ts decideDmTrigger`). The answer
  is stored on the event: `claimedCampaignId` (FK, SET NULL on delete) plus
  `rawPayload.dmClaim` (matched keyword, or the reason nothing was claimed,
  shown in the logs). The route keeps exactly the events stored with a
  `claimedCampaignId` away from production; the worker answers exactly those,
  with exactly that campaign, and never decides again (no audience / cooldown
  / thread re-check). Unclaimed events never fire a DM trigger.
- Worker hard checks only: the claimed campaign is still active on the same
  account (else IGNORED, "kampaniya o'chirilgan…", plus a WARNING operational
  event — production skipped that message too, so it is left unanswered:
  rare, but visible), the 24h window, quota / rate limit. A retry uses the
  same campaign.
- Per-person serialisation: the decision and the insert run in one
  transaction holding `pg_advisory_xact_lock(hashtext('trigger-dm-claim'),
  hashtext('<account>:<sender>'))` (lock_timeout 3s), so two webhooks for one
  person cannot both claim inside one cooldown. Postgres rather than Redis:
  the lock ends with the commit that makes the claimed row visible (no gap, no
  TTL to outlive). Any error there (lock timeout, database) claims nothing:
  the event is stored unclaimed and production answers it.
- A redelivered webhook keeps the stored decision (production still skips a
  claimed message; an unclaimed one stays unclaimed).
- Not claimed: quick-reply taps (payload), and DMs while a comment / live
  campaign owns the thread (an ACTIVE COMMENT / LIVE_COMMENT execution:
  sent / opened / last message under 24h, not stopped by an earlier message).
- Audience: from the person's stored `InstagramEvent` rows on the account up
  to this message (and earlier messages of the same payload); none =
  NEW_CONTACT. REOPENED = previous DM-side event (DM, story reply, mention)
  older than `reopenAfterHours`.
- Cooldown = this campaign's executions to this sender on this account in
  PENDING / SENDING / RETRYING / SENT (by createdAt) or events already claimed
  for it from this sender, within `cooldownHours` (0 = off).
- Bookkeeping (lastInboundAt, stop on reply) touches only ACTIVE executions
  (same `findActiveConversations` query): a stale execution's window is never
  reopened by a later DM.
- The reply is a normal DM inside the window the person opened, with the
  quick replies attached; NO_CLICK follow-up steps are never scheduled (no
  button). Taps come back as `c2:<execution>:qr:<id>` like any execution's.
- Live comments: production does not read `live_comments`, so no claim.

Limits (L3):
- Audience history only exists since the account's first trigger campaign:
  events are not stored before that, so someone who talked to the account
  earlier counts as NEW_CONTACT on their first message after it.
- REOPENED needs a previous DM-side event; a person whose only history is a
  comment is RETURNING, never REOPENED.
- Message timestamps come from Meta; two messages with the same timestamp are
  ordered by the lock (whichever webhook decided first is the earlier one).

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

`STORY_REACTION` is reserved and never produced until its payload is
confirmed against real webhooks; meanwhile every reaction is stored as
`MESSAGE_REACTION` for inspection.
