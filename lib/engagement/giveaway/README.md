# Giveaway engine (ETAP 9.1 / 9.2)

Design and owner decisions: `docs/developer/etap-9-engagement.md`. Kill switch
`ENGAGEMENT_DISABLED=1` (no collector, no worker, no gate extension, no queue).

## Flow

```
webhook -> InstagramEvent (account gate: ACTIVE giveaway / referral program = engaged)
        -> collector.ts   (maintenance tick ~1/min, <= COLLECT_BATCH events per giveaway)
        -> GiveawayEntry  (one per person, rules.ts evaluateEntry)
        -> follow.ts      (only when rules.follow.required, 2 calls/s, cached on the entry)
owner:  closeAndCommit -> drawGiveaway -> confirmDraw -> notifyWinners
        disqualifyEntry (winner) -> VOID + new draw, new commitment
backfill.ts: Graph comments -> entries directly (no InstagramEvent rows)
```

| File | Role |
|---|---|
| `rules.ts` | zod rules v1, `RULE_VERIFIABILITY` (UI copy), `extractTaggedHandles`, pure `evaluateEntry` |
| `collector.ts` | keyset scan (`createdAt,id` cursor on the giveaway row), `recordParticipation` (shared with backfill), follow sweep, counters, `drainGiveaway` |
| `follow.ts` | throttled `getUserFollowStatus`; UNVERIFIABLE is asked again after 6 h |
| `backfill.ts` | `startBackfill` (RUNNING + queue job) / `runBackfill`; cap `BACKFILL_CAP`; never throws |
| `draw.ts` | pure commit-reveal draw and `verifyDraw` |
| `verify.ts` | rebuilds the entrants of a stored sequence, `verifyStoredDraw` |
| `lifecycle.ts` | activate, close+commit, draw, confirm, disqualify/re-draw, manual review, archive |
| `notify.ts` | DM (window open, not opted out) -> public reply -> Telegram; idempotent |
| `export.ts` | entries CSV, publishable draw record (10 000 rows max) |

Shared plumbing in `lib/engagement/`: `config.ts` (constants, kill switch),
`queue.ts` (queue "engagement": `giveaway-backfill`, `giveaway-notify`,
`referral-reward`), `worker.ts` (`registerEngagementJobHandler`,
`registerEngagementMaintenanceTask`, `runEngagementMaintenance`), `gate.ts`,
`errors.ts` (`EngagementServiceError`).

## Rules worth knowing

- Entry status: `ELIGIBLE` / `INELIGIBLE` / `PENDING_CHECK` (follow not asked yet,
  or UNVERIFIABLE under policy HOLD) / `WINNER` / `DISQUALIFIED`. A failed rule
  beats a pending follow check, so no Graph call is wasted.
- An owner decision (`markEntry`, `resolveUnverifiable`) is stored in
  `checks.manual`; the collector never overrides it. WINNER / DISQUALIFIED are frozen.
- A story mention before the comment creates an entry with `firstCommentId = ""`;
  the comment fills it in later. Public replies need a comment id.
- Only the owner closes a giveaway; the window end only stops new entries.
- The collector cursor is insertion order (`createdAt`), so a late backtrack event
  is never skipped; the event `timestamp` must lie inside the window.

## Fair draw

`commitment = sha256(utf8(seedHex))`, shown when the giveaway is closed; the
seed is stored encrypted. The draw sorts eligible entrants by `igUserId`,
`entrantsHash = sha256(ids joined by "\n")`, then HMAC-SHA256(seed bytes,
`"<entrantsHash>:<counter>"`) words with rejection sampling feed a Fisher-Yates
shuffle; first `winners` win, next `backups` are backups
(`hmac-sha256-fisher-yates/v1`). `GiveawayDraw` stores the revealed seed and a
one-line `verification`. Disqualifying a winner VOIDs the sequence and draws
`sequence + 1` with a NEW seed/commitment over the remaining ELIGIBLE entries;
the old seed stays revealed. Entrants of an old sequence are rebuilt from
entries (ELIGIBLE / WINNER, or DISQUALIFIED with
`checks.draw.disqualifiedAfterSeq >= sequence`).

## Notifications

Never before `confirmDraw`. A winner with a SENT DM or public reply is skipped on
every rerun (per entry across draws); failed or skipped attempts are retried.
A public reply is not a private message, so an opt-out blocks only the DM.
One Telegram summary per draw (`entryId = "draw:<seq>"` in `GiveawayNotification`).

## Limits

Follow is best effort (Meta may answer nothing); like / save / share /
follow-another-account cannot be verified. Follow checks happen at collection
time (plus re-asking UNVERIFIABLE ones), not again at draw time.

## Review fixes (consistency notes)

- **Cursors** advance on idle scans too (to `now - 60s`, never backwards; rows are read only up to `now`), so a scan never grows.
- **Guarded transitions**: activate / close / archive / confirm are `updateMany` on the expected status; the loser gets 409. The seed is generated right before the guarded close, so the published commitment always matches the revealed seed. A double draw maps P2002 on (giveawayId, sequence) to 409.
- **Entrant list is frozen at commit** for fairness. `markEntry` / `resolveUnverifiable` stay allowed while CLOSED (owner decisions); the draw record and verification show "O'zgarishlar commitdan keyin: N" (entries with `checks.manual.at` later than `committedAt`). `closeAndCommit` returns `entrantsHash`, `entrantsCount`, `pendingExcluded`; entries still PENDING_CHECK do not enter the draw (the UI warns).
- **Notifications** are claim-first (`@@unique(giveawayId, entryId, channel)`): PENDING row, send, settle. FAILED / SKIPPED may be claimed again; a SENT one never; a PENDING older than 10 minutes is "noaniq — qo'lda tekshiring" and is not resent.
- **Backfill** RUNNING is stale after 10 minutes without progress (`updatedAt`); the worker `failed` handler resets it to FAILED.
- `confirmCampaignId` is only a label of the Comment 2.0 campaign that confirms participation; the campaign itself sends the DM.
- `giveaway_entry` points are awarded when an entry is created for a known CRM contact.
