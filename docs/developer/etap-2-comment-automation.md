# ETAP 2 — Comment Automation 2.0 (developer area)

Master TZ: sections 8–13 and 63 (ETAP 2). Built in the developer area at
`/developer/comments`; the customer product is not touched.

## Where it lives

Comment 2.0 is the trigger engine's `COMMENT` handler (`lib/triggers`). The
engine already normalises and stores comment events per account; it gets a
handler, its own config tables and a follow-up sweep. Production campaigns
(`Automation`, `lib/queue/dm-worker.ts`) keep working unchanged, except for one
guard: a comment that a Comment 2.0 campaign will answer is skipped by the old
worker, so nobody gets two DMs (see "Overlap").

```
comment webhook / backtrack ─▶ InstagramEvent(COMMENT) ─▶ handleComment
   match (keywords + intents + priority) ─▶ TriggerExecution
   ├─ public reply (variant)                       ── optional
   └─ private reply (variant) [+ opening button]   ── one message, Meta rule
button tap (postback c2:…) / quick reply (c2:…) / any DM from the person
   ─▶ InstagramEvent(DIRECT_MESSAGE, payload) ─▶ handleDirectMessage
   ├─ c2:<execution>:open  ─▶ main message + quick replies, window opened
   ├─ c2:<execution>:qr:<id> ─▶ quick-reply action (message / lead / handoff)
   └─ plain DM ─▶ lastInboundAt (stop-on-reply, keeps the 24h window open)
follow-up sweep (every minute) ─▶ due TriggerFollowUpRun ─▶ DM or SKIPPED
```

## Meta rules this design follows (checked 2026-10-15)

- A private reply can be sent within **7 days** of the comment, **one message**
  per commenter. → Backtrack is capped at 7 days; comments older than that
  are skipped as "expired", never sent.
- The conversation can only continue after the person **responds**, inside the
  **24-hour** window. → Follow-ups and the main message go out only after a
  button tap, quick-reply tap or DM, and a follow-up whose window has closed
  is SKIPPED with a reason, never forced.
- Quick replies: max 13, title max 20 chars, `text` / `user_phone_number` /
  `user_email`; the tap arrives as a message with `quick_reply.payload`.
  Their support inside a private reply is not documented, so quick replies
  are only sent in the main message after the window is open; the private
  reply itself uses the button template production already uses.

Sources: developers.facebook.com — Instagram Platform "Private Replies" and
"Quick Replies" pages.

## Features (TZ → implementation)

| TZ | Implementation |
|---|---|
| 8.1 Keywords: exact, contains, many, case-insensitive, Uzbek Latin, Cyrillic, Russian | `lib/triggers/keywords.ts`: normaliser (case, apostrophe forms o‘/o'/oʻ, Cyrillic → Latin transliteration, punctuation) + built-in intents (PRICE, ADDRESS, CATALOG, ORDER, DELIVERY, CONTACT, INFO) with uz-Latn / uz-Cyrl / ru variants |
| 8.2 Priority | exact keyword > keyword contained > intent > every comment; then a specific post beats "any post"; then campaign `priority`; then oldest |
| 9 Reply variants 3–10, Random / Sequential / Weighted | `TriggerReplyVariant` (kind DM or PUBLIC), `replyMode` on the campaign; only approved variants are used |
| 10 AI reply generator, Generate → Preview → Edit → Approve | generate endpoint returns drafts only; saved AI variants start unapproved and the engine ignores them until approved |
| 11 Backtrack | `TriggerBacktrackRun`: scan the campaign's posts back N ≤ 7 days, skip duplicates / already processed / already answered by production / expired, queue the rest |
| 12 Quick replies (message / flow / AI / handoff / lead) | `TriggerQuickReply` actions MESSAGE, LEAD_CAPTURE (phone quick reply → contact phone), HANDOFF (stop automation + Telegram alert). FLOW and AI are ETAP 6 / ETAP 4 and are not offered yet |
| 13 Follow-up: delay, condition, max attempts, cancel, stop on reply / purchase / handoff | `TriggerFollowUpStep` + `TriggerFollowUpRun`; conditions ALWAYS / NO_REPLY / NO_CLICK; stop flags on the campaign; "purchase" = lead captured (no payments yet) |
| ETAP 2.7 Queue visibility | per-campaign counts of executions and scheduled follow-ups |

## Overlap with production

`isCommentClaimedByCommentEngine(instagramAccountId, mediaId, text)` runs the
same matching against active Comment 2.0 campaigns. The production worker
calls it first in `processComment` and returns early when it is true. Only the
developer can create Comment 2.0 campaigns, so customer accounts are never
affected. Quick-reply taps with a `c2:` payload are claimed the same way as
story replies, so the DM-keyword path and the assistant do not answer them.
A phone number shared from a LEAD_CAPTURE chip may come back with the number
as its payload instead of `c2:`; a message that is a phone number from someone
with a pending lead (`lib/triggers/lead-capture.ts`) is claimed and handled as
that tap.

## Not in this stage

- FLOW and AI quick-reply actions (ETAP 6 Flow Builder, ETAP 4 JavobAI).
- Real payments for "stop on purchase" — a captured lead stands in for it.
- Live comments (ETAP 3).
