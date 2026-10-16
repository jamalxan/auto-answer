# ETAP 9 — Engagement: Giveaway, Referral, Gamification (developer area)

Master TZ: sections 43–45 and 63 (ETAP 9). Built at `/developer/engagement`.
Kill switch `ENGAGEMENT_DISABLED=1`.

## Decisions (owner, 2026-10-16)

1. **Winner announcement.** If the 24h window is closed, a **public reply**
   under the winner's comment ("@username tabriklaymiz! Direct'ga yozing") is
   posted, and the owner always gets the winner list on Telegram.
2. **Referral qualifies on the friend's first message.**
3. Technical (accepted from the analysis): follow rule when unverifiable =
   HOLD for manual review ("mark all unverifiable as eligible" one click);
   participation confirmation only through a linked Comment 2.0 campaign (so
   the one private reply per comment belongs to one engine); backfill cap
   5 000 comments per post, follow-check 2 calls/s; one referral program per
   Instagram account; comment points off by default; commit–reveal draw.

## What is verifiable (shown in the UI verbatim)

| Condition | Verifiable | How |
|---|---|---|
| Comment on the post (keyword / any) | yes | InstagramEvent COMMENT, backfill via Graph |
| Tag N friends | partly | `@handle` parsing — proves the text, not that people are real |
| Mention the account in a story | yes, when it arrives | STORY_MENTION (public accounts / private followers only) |
| Follow the account | best effort | `is_user_follow_business`: FOLLOWER / NOT_FOLLOWER / UNVERIFIABLE (unconfirmed for pure commenters — measured in 9.1) |
| Like / save / share / follow another account | **no** | no API |

## Collection

- Live cursor collector (maintenance tick, ≤ 500 events/tick): InstagramEvent
  COMMENT on the giveaway media (also the ad's `original_media_id`) and
  STORY_MENTION inside the window; one entry per person
  (`@@unique(giveawayId, igUserId)`), tagged handles accumulated.
- Backfill: `getRecentMediaComments` → entries written directly (no
  InstagramEvent rows, so Comment 2.0 is never re-triggered).
- Account gate: an ACTIVE giveaway or referral program counts as "engaged"
  (otherwise the account would store no events).
- Rules are evaluated by pure `evaluateEntry(rules, facts, now)`.

## Fair draw (commit–reveal)

Commit: `seed = randomBytes(32)`, `sha256(seed)` shown before the draw, seed
stored encrypted. Eligible entrants sorted by `igUserId`, `entrantsHash` =
sha256 of the list. Draw: HMAC-SHA256(seed, counter) stream → rejection
sampling → Fisher–Yates; first k winners, next b backups; algorithm
`hmac-sha256-fisher-yates/v1`. Reveal stores the seed and a one-line
verification string; a pure `verifyDraw` recomputes everything. Disqualifying
a winner VOIDs the draw and runs a new sequence with a new commitment. The
owner must CONFIRM a draw before any notification goes out.

## Winner notification (policy aware)

DM if the window is open (and not opted out, via `sendGuarded`) → else public
comment reply (once) → always Telegram to the owner. Never a DM outside the
window, never a second private reply to a comment.

## Referral

Code per referrer (6 chars, no 0/O/1/I), link
`https://ig.me/m/<username>?ref=rf_<code>`; attribution from
`InstagramEvent.ref`; first ref wins; qualifier FIRST_MESSAGE (LEAD /
PURCHASE supported via CRM listeners); reward = tag + points + Telegram to
the owner + DM to the referrer only inside their window. Fraud flags:
SELF_REFERRAL, SAME_PHONE, BURST (> N/day), ALREADY_KNOWN_CONTACT — flagged
events wait for the owner's approve/reject. ig.me refs for a new conversation
need Icebreakers and do not work on Instagram Web.

## Gamification (minimal)

Points ledger (idempotent on `(sourceTable, sourceId, reason)`): giveaway
entry, referral qualified, purchase (deal WON), optional comment; badges by
threshold; leaderboard (7d / 30d / all). Shown in the CRM contact timeline as
activities. No customer-facing UI.

## Data model (new tables only)

`Giveaway`, `GiveawayEntry`, `GiveawayDraw`, `GiveawayNotification`,
`ReferralProgram`, `ReferralCode`, `ReferralEvent`, `EngagementSettings`,
`EngagementPoint`, `EngagementBadge`.

## Sub-phases

| Phase | Scope | Done when |
|---|---|---|
| 9.0 | schema, config, gate extension, `gw:`/`rf_` handling, module registry | existing suite green; `ENGAGEMENT_DISABLED=1` leaves everything untouched |
| 9.1 | giveaway create / rules / collect / backfill / follow check / list | a comment becomes an entry within a minute; duplicates collapse |
| 9.2 | commit, close, draw, verify, confirm, disqualify / re-draw, notify, export | commitment equals sha256(revealed seed); `verifyDraw` reproduces winners; one DM / reply per winner |
| 9.3 | referral program, codes, attribution, qualification, rewards, fraud flags | friend's first message → QUALIFIED → tag + points + Telegram; self-referral flagged |
| 9.4 | points, badges, leaderboard | each source adds points once (replay-safe) |
