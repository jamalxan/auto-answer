# ETAP 13 — Content Scheduler (developer area, Faza 1 + Faza 2)

Spec: `docs/superpowers/specs/2026-10-22-content-scheduler-design.md`; plan:
`docs/superpowers/plans/2026-10-22-content-scheduler-faza1.md`, Faza 2:
`docs/superpowers/plans/2026-10-23-content-scheduler-faza2.md`. Built at `/developer/content`,
API under `/api/developer/content/*`. Kill switch `CONTENT_SCHEDULER_DISABLED=1` (web + worker).
Registry status: BUILDING.

## What it is

Instagram feed posts, carousels, Reels, Trial Reels and Stories scheduled ahead of time and
published through the official Content Publishing API (Instagram Login,
`instagram_business_content_publish`). What the API cannot do (story stickers, links, music) goes
through **manual publishing over Telegram**: at the slot the workspace chats receive the media, the
caption as a copyable message and "E'lon qildim / Bekor qilish" buttons. The SocialAuto difference:
a comment-to-DM campaign linked in the composer is activated on the new `igMediaId` in the same
transaction as the publish, so the first keyword comment already gets its DM.

## What is built (Faza 1)

| Part | Where |
|---|---|
| Schema: `MediaAsset`, `ScheduledPost`, `ScheduledPostMedia`, `PublishAttempt`, `PostReview`, `PostNote`, `SavedText`, `PostingSlot`; nullable additions on `InstagramAccount`, `Workspace`, `Automation`, `TriggerCampaign` | `prisma/migrations/20261030100000_content_scheduler` (additive) |
| Config and limits (caption 2200 / 30 # / 20 @, media sizes, lead times, env knobs) | `lib/content/config.ts` |
| Storage drivers: S3-compatible (R2, Lightsail, MinIO) and local filesystem for dev | `lib/content/storage.ts`, `storage-local.ts`, route `media/local/[...key]` |
| Meta publishing client: container, status poll, publish, publishing limit, comment | `lib/meta/publish.ts` |
| Field matrix + validation shared by UI and server (spec §6) | `lib/content/validate.ts`, `schema.ts`, `text.ts`, `time.ts` |
| Media library: presign → direct PUT → complete → worker (sharp / ffmpeg: JPEG, ≤1440 px, H.264 + AAC, faststart, thumbnail) | `lib/content/media.ts`, `media-process.ts`, queue `media-process` |
| Post service, status machine, 24-hour quota (read from Meta, cached 10 min), campaign linking | `lib/content/service.ts`, `transitions.ts`, `quota.ts`, `link-campaign.ts` |
| Publish pipeline: prepare 30 min (image) / 60 min (video) before the slot, poll FINISHED, `media_publish` at the slot, idempotent (CAS on status + container `status_code` check when the call times out), first comment 10 s later, campaign activation in the same transaction | `lib/content/publish.ts`, `worker.ts`, queue `content-publish`, Redis lock `content:acct:{id}` |
| Sweeper every minute (lost jobs, 15-minute late rule, stale PREPARING) | `/api/cron/content-sweep`, `scripts/cron.sh`, `lib/content/sweep.ts` |
| Manual publishing over Telegram + `content:done:` / `content:cancel:` callbacks, email fallback, post-hoc media binding | `lib/content/manual.ts` |
| Error catalog entries `PUBLISH_*`, `FIRST_COMMENT_FAILED`, `CAMPAIGN_LINK_FAILED`, `PUBLISH_LATE` | `lib/foundation/error-catalog.ts` |
| Developer API (posts CRUD + actions, media, saved texts, validate, quota, meta) with `content.create / schedule / approve` permissions | `app/api/developer/content/*`, `lib/content/permissions.ts`, `lib/developer/content-guard.ts` |
| Screens: calendar (month / week / list, filters, quota pill), composer with live preview, people tagging on the image, media library, saved texts, post detail with explained errors and actions | `components/developer/content/*`, `app/developer/(secure)/content` |

Faza 2 has since added the approval flow and `/review/[token]` (WP-A), story series, recurrence
and posting slots (WP-B), CSV import, AI caption and the MCP tools (WP-C), and inline campaign
creation, the caption keyword warning, the 30-day cleanup of prepared copies and the quota / BROKEN
notifications (WP-E). Feed grid preview, best times and drag-and-drop reorder are WP-D (built in
parallel; see its own section once merged). Still deferred: moving the screens into the main
dashboard, ru / en copies, a per-tariff storage quota (today one env-wide
`CONTENT_STORAGE_QUOTA_BYTES`), Canva / Drive, RSS, polls.

## Env

| Variable | Default | Meaning |
|---|---|---|
| `CONTENT_SCHEDULER_DISABLED` | unset | `1` turns the module off: API answers 404, worker and sweeper stop |
| `MEDIA_STORAGE_DRIVER` | `s3` when `MEDIA_S3_BUCKET` is set, else `local` | `s3` or `local` |
| `MEDIA_S3_BUCKET`, `MEDIA_S3_ACCESS_KEY`, `MEDIA_S3_SECRET_KEY`, `MEDIA_S3_ENDPOINT`, `MEDIA_S3_REGION` | — | S3-compatible bucket (R2: endpoint `https://<account>.r2.cloudflarestorage.com`, region `auto`). The bucket stays private: uploads use presigned PUT (15 min), Meta fetches via presigned GET (24 h) |
| `MEDIA_LOCAL_DIR` | `.media` | Local driver folder (dev only — Meta cannot fetch from localhost, so publishing needs S3) |
| `CONTENT_STORAGE_QUOTA_BYTES` | 5 GB | Per-workspace storage quota |
| `CAROUSEL_MAX_ITEMS` | 10 | 2–20; Meta docs disagree (10 vs 20), verify on the real account |
| `IG_MAX_COLLABORATORS` | 3 | 1–5 |
| `LATE_PUBLISH_MAX_MIN` | 15 | A post later than this is not published automatically: FAILED + "Vaqt o'tib ketdi" |
| `FFMPEG_PATH`, `FFPROBE_PATH` | `ffmpeg`, `ffprobe` | Binaries for the media worker (the runner image installs `ffmpeg`) |

No new container: the `content-publish` and `media-process` queues run inside the existing
worker, the sweeper inside the existing cron loop.

## Meta prerequisites

1. `lib/meta/oauth.ts` now requests `instagram_business_content_publish`. The callback stores the
   granted scopes in `InstagramAccount.grantedScopes` and sets `canPublish`. Accounts connected
   before this change have `canPublish=false` until they are reconnected ("Qayta ulash" banner in the
   calendar); until then the composer works in draft and manual mode only.
2. In Development mode the permission works only for accounts with an app role (@jamalxann).
   Public customers need Advanced Access → App Review → Business Verification (blocked until the
   YaTT registration). Manual publishing over Telegram needs no permission and works for everyone.
3. Creator accounts may refuse story auto-publish; the pipeline falls back to NEEDS_MANUAL.

## Faza 2 — series, recurrence, slots (WP-B)

- **Story series (FR-C9).** The split happens at **schedule time**, not at create time: the composer
  edits one STORY draft with up to `CONTENT_LIMITS.storySeriesMax` (10) media ("3 ta story, 1 daqiqa
  oraliq bilan"). `schedulePost` checks lead time, the field matrix and the quota for all N items
  first, then keeps media[0] on the original (seriesIndex 0) and creates one STORY post per further
  media sharing a new `seriesId`, each scheduled `storySeriesGapMs` after the previous one through
  the normal path (own jobs, FR-S4 spacing keeps the order). Validation accepts a multi-media STORY
  only while it is unscheduled (`ValidateOptions.storySeries`); editing a SCHEDULED / PAUSED story
  back to several media is refused, so a queued story is always one media. Pause / unschedule /
  cancel act on one item. Post detail shows "Seriya: 2/3" with links.
- **Recurrence (FR-S8).** `lib/content/recurrence.ts` (pure, also used by the composer for the live
  count): daily / weekly (chosen weekdays, 0 = Monday) / monthly (same day; months without it are
  skipped), every N, wall-clock in the post's zone, end date inclusive; ≤ 180 days, ≤ 200 copies.
  Action `recur` (MANAGER+) on a DRAFT: the original becomes index 0, copies are duplicates sharing
  the `seriesId`, each goes through `schedulePost`; a copy that fails (quota, spacing) stays DRAFT in
  the series and is listed in the report instead of aborting the rest. Multi-media stories cannot be
  recurred. `delete-series-future` (MANAGER+) soft-deletes later items not yet published or in flight;
  `apply-to-series` (OPERATOR+) copies texts and switches to the series' DRAFT copies.
- **Posting slots (FR-S9).** `GET/PUT /api/developer/content/accounts/[id]/slots` (PUT replaces the
  weekly set, MANAGER+): weekday 0 = Monday, minuteOfDay in the workspace zone, optional postType.
  `nextFreeSlot` skips slots within the same minute as a queued post of the account; action `queue`
  schedules into the next free slot ≥ now + 5 min (8-week horizon, 409 when none). Calendar →
  "Slotlar" panel edits them; the composer shows "Navbatga qo'shish" when the account has slots.

## Faza 2 — CSV import, AI caption, MCP (WP-C)

| Piece | Where |
|---|---|
| CSV parse + row normalisation (pure: BOM, CRLF / LF, quoted fields, `,` or `;`, dates `2026-10-24` / `24.10.2026`, `@user:x:y` tags, campaign by keyword), ≤ 200 rows, downloadable template | `lib/content/csv.ts`, `csv-schema.ts` |
| Preview (no writes) → commit of the ticked rows (refused whole when any ticked row has an error) → schedule the imported drafts once their media are READY | `lib/content/csv-import.ts`; routes `POST import/csv` (preview), `import/csv/commit`, `import/csv/schedule`, `GET import/csv/template` |
| Media fetched from a URL into the library (SSRF-safe `fetchAttachment`: https only, public DNS, every redirect re-checked, streaming size cap — video 300 MB, 60 s timeout), then the normal media-process job | `lib/content/media-import.ts` |
| "AI bilan yozish" (FR-AI1): topic + tone + language → three variants and ≤ 15 hashtags; shared LLM provider and workspace AI budget, one `LlmUsage` row (`javobai_caption`) per call and an hourly cap; nothing is saved | `lib/content/ai-caption.ts`, `POST ai/caption`, `components/developer/content/ai-caption-panel.tsx` |
| MCP tools `list_scheduled_posts`, `get_scheduled_post`, `create_post_draft` (DRAFT only: no time / status / publish field), `get_publishing_quota`; token workspace, whitelist output, user text under `untrusted` | `lib/mcp/content.ts`, registered in `lib/mcp/tools.ts` |

## Faza 2 — campaigns and housekeeping (WP-E)

- **Inline campaign (FR-L1).** The composer's automation card has "Mavjud kampaniya" / "Yangi
  kampaniya". The new one takes keywords, an optional public reply, the DM text, an optional link
  (+ button label) and the follow gate, and is sent with the post body as `linkCampaign.create`
  (`newCampaignSchema` in `lib/content/schema.ts`). **Engine ruling: the legacy `Automation`** — it
  is what the main dashboard creates today (`POST /api/automations`) and the only engine with the
  follow gate (`requireFollow`); Comment 2.0 `TriggerCampaign` stays selectable as an existing
  campaign. No second copy of the rules: the dashboard route's create logic moved into
  `lib/campaigns/create-automation.ts` (`createAutomationBaseSchema`, `createAutomationRecord`,
  tracked links included) and both callers use it. The campaign is born waiting —
  `scheduledPostId` set, `isActive=false`, no post / any-post / next-reel target — and
  `activateLinkedCampaigns` switches it on in the publish transaction (FR-L2/L3; tested through
  `publishPost`). Only an explicit save creates it; autosave leaves the link alone, and after the
  save the composer switches to the new id, so a retry never makes a second copy.
- **Caption keyword (FR-L5).** `campaignKeywordWarnings` (`lib/content/validate.ts`) is a warning,
  never an error: `PostDetail.warnings`, `POST validate` → `warnings` (`draftWarnings`), and the
  composer's caption hint. Scheduling ignores it.
- **30-day cleanup (spec §7).** Sweep step 9, `cleanupPreparedCopies` (`lib/content/media.ts`):
  media whose every non-deleted usage is a post PUBLISHED / PUBLISHED_MANUAL more than 30 days ago
  (a draft, a queued post, a FAILED one that can be retried or a recent publish keeps it) lose the
  prepared copy: object deleted, `preparedKey` / `preparedBytes` nulled, bytes released from
  `Workspace.mediaStorageBytes`; original and thumbnail stay. 50 per sweep, idempotent, the write is
  guarded on the key it read, a storage error leaves the row for the next sweep. A video whose
  prepared copy is the original only loses the pointer (publishing falls back to `originalKey`, the
  same file). Re-using a cleaned asset (create / edit / duplicate) calls `reprepareCleanedMedia`:
  PROCESSING again + media-process job, the thumbnail bytes it will rewrite are released first.
- **Notifications (spec §11).** Sweep step 10, `lib/content/notify.ts`. "Kvota 80%": accounts that
  published in the last 24 h or have posts queued in the next 24 h are checked with `accountQuota`
  (cached 10 min); `(used + scheduledNext24h) / total ≥ 0.8` → Telegram, once per account per 24 h
  window; the dashboard side is the calendar quota pill (amber at 80%) plus the `OperationalEvent`
  WARNING. "Keyingi 24 soatda X ta post, akkaunt chiqara olmaydi": an account with `tokenStatus
  BROKEN` or `canPublish=false` and auto-publish posts (no manual reason) due in the next 24 h →
  Telegram + email (`alertWorkspace`), once per account per local day (workspace zone). No
  migration: the `OperationalEvent` row (source WORKER, stable message per account / window) is the
  dedupe marker, a key lock covers overlapping sweepers.

## How to test on @jamalxann

1. Set `MEDIA_S3_*` (R2 recommended) — Meta must be able to fetch the media URL.
2. Reconnect the account from `/developer/foundation` so the publish scope is granted; the meta
   endpoint shows `canPublish: true`.
3. `/developer/content` → "+ Post yaratish" → upload a JPEG → caption → "Rejalashtirish" at now + 6
   minutes. Watch the post detail: SCHEDULED → PREPARING → READY_TO_PUBLISH → PUBLISHING → PUBLISHED
   with the permalink; `PublishAttempt` rows list every Meta call.
4. Link a comment-to-DM campaign in the composer — or create one there with "Yangi kampaniya"; it
   shows "post kutilmoqda" until the post is out. After publishing, comment the keyword from another
   account and expect the DM (AC-7).
5. Story with the manual toggle: at the slot the Telegram chat receives media + caption + buttons.

Local without Meta: `MEDIA_STORAGE_DRIVER=local`, the fake account, `node --env-file=.env --import
tsx worker/dm-worker.ts`; upload and scheduling work end to end, the prepare step then records the
Meta 190 error in the post detail (verified 2026-10-23).

## Acceptance checklist

| AC | Status |
|---|---|
| AC-1 JPEG feed post at 19:00 publishes within the minute, PUBLISHED + permalink | needs real account |
| AC-2 5-item carousel (3 images + 2 videos) with user tags, order kept | needs real account (unit: carousel children order, tags per child) |
| AC-3 45 s Reels, custom cover, `share_to_feed=false`, one collaborator | needs real account (unit: container params) |
| AC-4 3-story series one minute apart | unit (Faza 2 WP-B, `content-series.test.ts`); live pending |
| AC-5 Link-sticker story → NEEDS_MANUAL → Telegram → PUBLISHED_MANUAL | unit + Telegram callback tests pass; live Telegram check pending |
| AC-6 First comment ≤ 30 s | unit (10 s job) ; live pending |
| AC-7 Linked campaign gets the DM within a minute | unit (activation in the publish transaction, also for a campaign created inline — WP-E); live pending |
| AC-8 Worker restart → sweeper republishes ≤ 2 min, no duplicate | unit (sweep re-queue; BullMQ "existing id is never re-added" modelled in `content-queue.test.ts`); live restart test pending |
| AC-9 `media_publish` timeout → published once | unit (status_code check, CAS) |
| AC-10 Token BROKEN → stays SCHEDULED, notified, continues after reconnect | unit + local live check (190 explained in post detail); WP-E adds the daily "posts due, account cannot publish" warning (`content-notify.test.ts`) |
| AC-11 2300 chars / 31 hashtags / 3:1 image / 62 s story rejected with exact text | unit |
| AC-12 PNG → JPEG, 4K 80 Mbps transcoded | unit (sharp / ffmpeg args); live pending. HEIC is refused with a hint (the prebuilt sharp has no HEVC decoder) |
| AC-13 OPERATOR creates, cannot schedule; MANAGER schedules | API test |
| AC-14 Other workspace's ids → 404 | API test |
| AC-15 Existing regression suite passes | `npx vitest run` → 197 files / 3217 tests (2026-10-24, after WP-E) |

Tests: `__tests__/content-*.test.ts`, `__tests__/meta-publish.test.ts`, `__tests__/mcp-content-tools.test.ts`.

## Faza 2 — approval flow and notes (WP-A, FR-A1…A5)

| Piece | Where |
|---|---|
| Submit / decide / token / sweep / notes / reviewer list | `lib/content/review.ts` |
| FR-A3 reset on edit (PENDING_REVIEW or approved SCHEDULED / PAUSED → DRAFT) | `lib/content/service.ts` `updatePost` |
| FR-A4 sweep step 8 | `lib/content/sweep.ts` → `sweepReviews` |
| `POST posts/[id]/review` (create), `POST posts/[id]/decision` (approve), `GET/POST posts/[id]/notes`, `GET posts/[id]/review` (history) | `app/api/developer/content/posts/[id]/[action]/route.ts` |
| `GET reviews?tab=mine\|sent\|rejected`; `/meta` → `reviewers` | `app/api/developer/content/reviews`, `meta` |
| External reviewer (no session, the token is the key, 404 on bad / expired / voided) | `app/api/content/reviews/[token]`, `app/review/[token]` (noindex, `/review/` disallowed in robots) |
| Telegram `content:approve:<reviewId>` / `content:reject:<reviewId>` | `lib/content/manual.ts` → `handleReviewCallback` |
| UI: Tasdiqlar tab, composer review form, post detail history + notes | `components/developer/content/reviews.tsx` |

Rules: a rejection needs a comment and always stops (→ REJECTED); ANY and OPTIONAL schedule on
the first approval, ALL waits for every assigned reviewer; an approver who was not assigned
decides alone (override — they could schedule it anyway). Approval schedules at the requested
slot, or a minute from now when the slot is under five minutes away or already past. OPTIONAL with
no rejection is approved by the sweeper at the slot; any PENDING_REVIEW post 3 h past its slot
becomes EXPIRED_REVIEW and the author is told (Telegram if linked, else email). A round is the set
of PostReview rows stamped with the post's version at submit; decisions do not bump the version,
edits do — so an edit voids the round and the old external link answers 404. Tokens: 32 random
bytes base64url, only the SHA-256 stored, 7 days from the round. "Rad etish" in Telegram does not
reject (the bot has no comment flow): it answers with a pointer to the app. "Yuborganlarim" lists
the user's own posts that went to review (there is no "submitted by" column). Every step writes an
`OperationalEvent` (source SYSTEM).
