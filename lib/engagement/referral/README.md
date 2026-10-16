# Referral and points (ETAP 9.3 / 9.4)

Design and owner decisions: `docs/developer/etap-9-engagement.md`. Kill switch
`ENGAGEMENT_DISABLED=1` (attribution, qualification, listeners and rewards all
become no-ops). One program per Instagram account.

## Flow

1. **Code.** `createReferralCode(ws, programId, { igUserId | contactId })`:
   6 characters of `23456789ABCDEFGHJKLMNPQRSTUVWXYZ`, idempotent per
   (program, referrer). Link: `referralLink(username, code)` →
   `https://ig.me/m/<username>?ref=rf_<code>`.
2. **Attribution** (`attribution.ts`, maintenance task `referral`, every tick).
   Keyset scan (`CrmSyncCursor`, source `engagement:referral`, seeded at "now")
   over `InstagramEvent.ref LIKE 'rf_%'`, ≤ 500 per tick. Accounts with an
   active program only; events older than the program's activation time and
   unknown codes are ignored; the code is case-insensitive. The first ref of a
   friend wins (`@@unique(programId, refereeIgUserId)`). `ReferralEvent.createdAt`
   is the time of the ref event.
3. **Fraud flags** (`fraud.ts`, pure): `SELF_REFERRAL`, `SAME_PHONE` (both
   `CrmContact.phoneE164` known and equal; re-checked at qualification),
   `BURST` (> `burstLimitPerDay` events of one referrer in 24 h),
   `ALREADY_KNOWN_CONTACT` (the friend had events on the account before the
   ref event; the carrying event is excluded).
4. **Qualification** (`qualification.ts`).
   - `FIRST_MESSAGE`: the friend's own `DIRECT_MESSAGE` with text, or a
     quick-reply tap (`payload`), at/after the ref event. An empty
     `messaging_referral` (link merely opened) does not count. A `message.referral`
     that is itself a text message does.
   - `LEAD`: CRM listener `lead_created` (sweep: a deal with a lead created after the ref).
   - `PURCHASE`: CRM listener `stage_changed` into a WON stage (sweep: `wonAt` after the ref).
   - Flagged events whose condition is met stay `PENDING` with
     `rewardSnapshot.awaitingReview` until the owner decides.
   - The sweep covers PENDING events of the last 14 days (300 per tick,
     newest first) and re-drives `QUALIFIED` events whose reward did not finish.
5. **Reward** (`reward.ts`). `QUALIFIED → REWARDED` is an `updateMany` claim, so
   two executions never both reward. Then: tag (`rewardRules.tagSlug`, origin
   AUTOMATION, sourceRef `referral:<eventId>`), points (`rewardRules.points`,
   else the workspace rule `referral_qualified`; ledger key
   `ReferralEvent/<id>/referral_qualified`), Telegram to the owner
   (`telegramOwner`), DM to the referrer (`dmTemplate`, `{name}`) and to the
   friend (`refereeDmTemplate`) **only inside the 24 h window** and through
   `sendGuarded`; otherwise the snapshot says `oyna yopiq — DM yuborilmadi`.
   The Telegram message and DMs are at-most-once (claim first); tag and points
   are idempotent by themselves.
6. **Review** (`program.ts` `reviewReferralEvent`). APPROVE of a flagged
   PENDING/QUALIFIED event qualifies and rewards it (whatever the condition);
   REJECT sets `REJECTED` (a REWARDED event cannot be rejected).

`rf_` refs do not create the automatic `havola:<ref>` CRM tag
(`lib/crm/tags.ts applyAutomationTags`).

## Points, badges, leaderboard

- Ledger `EngagementPoint`, unique on `(sourceTable, sourceId, reason)`;
  `awardPoints` never throws, writes a CRM `NOTE` ("Ball: +N (…)") and checks
  badges. Defaults (`settings.ts`): `comment` 1 (**disabled**), `giveaway_entry`
  2, `referral_qualified` 10, `purchase` 20. Badges: `faol` 10, `elchi` 50,
  `vip` 150 (`Nishon: …` NOTE, once per contact).
- Listeners (`module.ts`): `stage_changed` WON → `purchase` points
  (`CrmDeal/<dealId>`); `interaction` comment (payload `eventType: COMMENT`,
  `eventId`) → `comment` points only when enabled (`InstagramEvent/<id>`).
  Giveaway entry points are awarded by the giveaway code via `awardPoints`.
- `leaderboard(ws, { period: "7d" | "30d" | "all", limit })` aggregates in
  memory; periods start at Tashkent midnight (7d = today + 6 days). `ledger`
  pages the raw rows.

## Wiring

`registerEngagementReferralModule()` (module.ts) registers the maintenance task
`referral`, the job handler `referral-reward` and the CRM listener. It is called
once from `worker/dm-worker.ts` (not on import: the worker must not be
imported back by this module).

## Limits

- `ReferralProgram` has no activation column; the activation time is kept in
  `rewardRules._activatedAt` (stripped from `getProgram().rewardRules`, exposed
  as `activatedAt`).
- ig.me refs for a brand-new conversation need Icebreakers and do not work on
  Instagram Web.

## Review fixes (consistency notes)

- APPROVE of a flagged event lifts the review hold only (`reviewedAt`, `awaitingReview=false`); the qualification condition still decides (met now = rewarded now, otherwise the listener / sweep rewards it later).
- Reward side effects are isolated try/catch steps; `rewardSnapshot.tagDone / pointsDone` mark the idempotent steps, and the sweep re-drives REWARDED events (last 3 days, older than 2 minutes) missing them, re-running only tag + points.
- The attribution cursor advances on idle scans (`now - 60s`).
- Points: per-contact total is one SUM; the leaderboard is a GROUP BY contactId with SUM ordered and limited (at most 100 rows), never a full ledger read.
