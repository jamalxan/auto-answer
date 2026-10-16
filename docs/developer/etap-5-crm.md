# ETAP 5 — CRM / Lead Management (developer area)

Master TZ: sections 27–33, 53 and 63 (ETAP 5). Built at `/developer/crm` on
top of the existing records; nothing in production is rewritten.

## The problem CRM solves first

A person's data is spread over four stores, each keyed by the Instagram-
scoped sender id of one business account:

| Store | Written by | Holds |
|---|---|---|
| `InstagramContact` + `TriggerConversation` | trigger engine (accounts with a campaign) | username, name, phone (quick reply), interactions |
| `Conversation` + `ConversationMessage` | assistant / JavobAI | messages, `collected` (name, phone, language), operator activity |
| `Lead` + `LeadDelivery` + `AiLeadInsight` | assistant / JavobAI / trigger lead chip | phone, product, summary, score, deliveries |
| `DmLog` | legacy comment → DM campaigns | people reached who never wrote back |

`CrmContact` is the single identity: unique per `(instagramAccountId,
igUserId)`, with links to the conversation and the trigger contact, a
denormalised summary (phone, name, language, score, temperature,
last inbound / outbound, assigned operator, status) and a merged timeline
read live from all stores (messages are never copied).

## Decisions (owner, 2026-10-16)

1. Every new lead enters the pipeline at **"Yangi lead"**; the Telegram
   "Bog'lanildi" button moves it to "Bog'lanildi". Won / Lost write back
   to JavobAI's temperature (CUSTOMER / LOST).
2. Broadcasts **skip** people in an active handoff (listed with the reason
   "Operator bilan suhbatda").
3. Assignment notifications go to the **workspace Telegram chat** with
   take / release buttons; the person who presses "Qabul qildim" is assigned.

Technical decisions: contact identity per Instagram account (no cross-
account merge yet; `mergedIntoId` reserved); three fire-and-forget hooks in
`lib/assistant/engine.ts` (inbound stored, operator reply, AI reply) enqueue
a `crm` job, plus a 5-minute cursor reconciler as the safety net; additive
index `Conversation(workspaceId, updatedAt)` plus one `(cursor column, id)`
index per reconciled table (InstagramEvent, Conversation, Lead,
TriggerExecution, DmLog, AiConversationState, AiHandoff); contacts without JavobAI state
show score "—"; `MEMBER` stays as the legacy alias of OPERATOR; the customer
settings UI is untouched until promotion; default stages and tags are seeded
lazily per workspace in Uzbek.

## History vs. live events (review fixes, 2026-10-16)

- **Backfill** is the only way history enters the CRM. The button queues a
  `crm-backfill` job (HTTP 202; 409 while the CRM is off) and the worker runs
  it in id-keyset pages of 500, **silently**: deals, stage moves, handoff and
  score mirrors are written, but no listener fires (no ON_LEAD / ON_HOT
  assignment, no Telegram alert, no broadcast attribution).
- **Reconciler**: a source without a `CrmSyncCursor` row is seeded at
  now − 60 s on first run (`createdAt` = seed time); the 30-day rescans
  (lead contacted / deliveries, handoff accept / close) never read before
  that seed. Every scan stops at now − 60 s (`RECONCILE_LAG_MS`) so a
  transaction still in flight cannot commit a row behind the cursor. Deal,
  handoff and score writes from the reconciler are silent (`{ silent: true }`
  on `ensureDealForLead`, `markLeadContacted`, `moveDeal`, `syncHandoffRows`,
  `mirrorAiState`); listeners fire from the hooks.
- **Interactions** reach listeners only when they move the contact's anchor
  forward (`lastInboundAt` / `lastOutboundAt` / `lastInteractionAt`), so a
  replay never re-triggers a listener. Stop-word opt-outs are also deduped by
  message identity (OPT_OUT activity `sourceId` = `<contactId>_mid_<mid>`, or
  the time when there is no mid): stop → manual opt-in → replay keeps the
  person opted in.
- **Take**: an OPERATOR (or legacy MEMBER) cannot take a contact another
  member actively holds (Telegram "Qabul qildim", inbox reply, "Bog'lanildi",
  handoff accept) — 403 "boshqa operatorga biriktirilgan"; MANAGER+ can.
  Every `crm:` Telegram button press is answered exactly once.
- **Stages**: deleting a stage that still holds a deal is 422 (also when a
  deal lands there during the save — the RESTRICT foreign key is caught);
  ON_STAGE rules of a deleted stage are deactivated and lose their stage.
  The Kanban shows the newest 100 deals per column plus the real count.

## Data model (new tables only)

`CrmContact`, `CrmTag`, `CrmContactTag` (origin MANUAL / AI / AUTOMATION /
SYSTEM), `CrmSegment` (filter JSON, cached count), `CrmPipeline`, `CrmStage`
(kind OPEN / WON / LOST, entry flag), `CrmDeal` (one per `Lead`, stage,
won/lost), `CrmAssignmentRule` (ROUND_ROBIN / TEAM / SPECIALIST; trigger
ON_HOT / ON_LEAD / ON_HANDOFF / ON_STAGE / MANUAL), `CrmAssignment`,
`CrmActivity` (events with no other home: tags, stages, assignments, notes,
broadcasts, plus denormalised score / temperature / handoff changes;
idempotent on `(sourceTable, sourceId, type)`), `CrmSyncCursor`,
`CrmBroadcast`, `CrmBroadcastRecipient` (eligibility snapshot + reason).
`WorkspaceRole` gets MANAGER, OPERATOR, VIEWER (additive enum values).

## Segments (TZ §29)

Filter DSL `{ v: 1, all: [...], any: [...] }` over: tag / not_tag, score,
temperature, status, stage, pipeline, assigned / unassigned, phone_present,
email_present, language, source, account, last_interaction (days),
window_open, opted_out, custom.<key>. Compiled to a Prisma `where`; preview
= count + first rows through the same `where`.

## Pipeline (TZ §30)

Default stages per workspace: Yangi lead (entry) → Bog'lanildi → Saralangan →
Hot → Muzokara → Yutildi (WON) / Yo'qotildi (LOST). Stages are editable
(rename, reorder, add, kind). A deal moves by drag in the Kanban or by
events: lead contacted → "Bog'lanildi".

## Operator assignment (TZ §31, §53)

Rules by trigger and priority; strategies: round robin (atomic cursor), team
(round robin inside the team), specialist (product keywords matched with
`normalizeForMatch` against extracted product, lead product and tags).
Permission matrix (`lib/workspace-permissions.ts`): manage_instagram,
manage_campaigns, view_contacts, assign_leads, manage_billing, manage_ai,
export_data, view_analytics for OWNER / ADMIN / MANAGER / OPERATOR / VIEWER.
Security fix shipped with the enum: the six `role !== "MEMBER"` checks become
`canManageWorkspace(role)` so a VIEWER or OPERATOR is never read as a manager.
The production leads CSV (`/api/leads/export.csv`) checks `canExportLeads`:
`export_data` per the matrix (VIEWER / OPERATOR → 403), except that legacy
`MEMBER` keeps the export it always had (no regression for existing teams).
The production Settings → Team list shows MANAGER / OPERATOR / VIEWER as a
read-only label (the ADMIN / MEMBER picker would demote them). Known, left as
is: the production members PATCH lets an ADMIN grant ADMIN (pre-existing).

## Broadcast (TZ §33) — policy-aware

What the code enforces (Meta rules as checked on 2026-10-15): a business may
message a person only inside the **24-hour window** after that person's last
message or button tap. There is no messaging-tag support in the app and the
human-agent tag is not meant for promotional sends, so recipients outside the
window are shown as **not eligible** with the reason, never silently dropped.

Eligibility per recipient at send time (snapshot stored): workspace not
suspended, token healthy, window open (`isWindowOpen`, 5-minute margin), not
opted out (stop words "stop", "to'xtat", "отпишите" or manual), frequency cap
(default one broadcast per 24h), not in an active handoff, not a duplicate.
Sends go through `sendGuarded` (workspace quota + 750/h account bucket);
rate-limit results re-schedule, never skip. Delivery in batches
(`throttlePerHour`, default 100) on the `crm` queue with a lease per
recipient. One delivery chain per broadcast: every scheduled tick bumps
`CrmBroadcast.tickSeq` (job id `bcb_<id>_<tickSeq>`, `nextTickAt` = when it is
due); a tick whose number is no longer the row's stops, so pause → resume
during a running tick never leaves two chains, and the minute sweep re-queues
a lost chain from `nextTickAt` instead of scanning the queue. Pause takes
effect before the next send (leases go back to PENDING); cancel during a
running tick marks the leased rows SKIPPED "Broadcast bekor qilindi.".
Replies are attributed within `replyWindowHours` (48); conversions within
`conversionWindowDays` (7) only for a new deal or a forward move (WON, or a
later non-LOST stage) — moving back, sideways or to LOST is not a conversion.

**Opt-in:** the CRM runs only with `CRM_ENABLED=1` (web and worker). Without it
hooks, the `crm` worker, the reconciler and broadcasts are all off and
production is untouched; `CRM_DISABLED=1` is the kill switch and wins over
`CRM_ENABLED=1`.

## Sub-phases

| Phase | Scope | Done when |
|---|---|---|
| 5.0 Foundation | tables, cursors, backfill, hooks, `crm` queue/worker, contacts list + detail with merged timeline | every person in the four stores has one `CrmContact`; a test contact's timeline shows comment → reply → DM → AI reply → lead → delivery in order; without `CRM_ENABLED=1` (or with `CRM_DISABLED=1`) production is untouched |
| 5.1 Tags + segments | tag CRUD, manual / AI / automation tags, segment builder with preview, CSV export | "HOT + phone + Toshkent + IELTS" returns the expected contacts; preview count = list count |
| 5.2 Pipeline | default stages, stage editor, Lead → deal, Kanban, Won/Lost + temperature write-back | TZ §63: comment → reply → phone chip → Lead → "Yangi lead" → "Bog'lanildi" → Won → JavobAI shows CUSTOMER |
| 5.3 Roles + assignment | enum + permission matrix + security fix, Team tab, rules, engine, Telegram take / release | HOT contact auto-assigned round robin; "Qabul qildim" assigns the presser; VIEWER gets 403 on writes |
| 5.4 Broadcast | tables, policy engine, queue, UI with eligibility preview, opt-out, attribution | 3 recipients (1h ago / 2 days ago / opted out) → exactly one DM, two reasons shown; reply and conversion attributed |
