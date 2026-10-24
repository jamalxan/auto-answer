# Content Scheduler — Faza 2 plan (ETAP 13)

Spec: `docs/superpowers/specs/2026-10-22-content-scheduler-design.md` (the TZ of 2026-10-22).
Faza 1 (PR #8, branch `content-scheduler`) is the base; this branch `content-scheduler-faza2`
stacks on it. Everything stays in the developer area (`/developer/content`,
`/api/developer/content/*`); moving to the main dashboard waits for the owner (master TZ 1.2 / 63).

The Prisma schema already holds the Faza 2 tables (`PostReview`, `PostNote`, `PostingSlot`,
`ScheduledPost.seriesId/seriesIndex/reviewRule/reviewSubmittedAt`). A migration is added only where a
column is genuinely missing.

## Work packages

Three packages run in parallel worktrees, two after them. Each package: TDD (Vitest +
`__tests__/helpers/memory-db.ts`), `npx tsc --noEmit` 0, `npm run lint` 0 errors, one or more commits.

### WP-A — Approval flow and notes (FR-A1…A5, notes)
- `lib/content/review.ts`: submit for review (`{reviewerUserIds[], externalEmails[], rule}`), member
  decision, external token decision (32 random bytes, SHA-256 stored, 7 days), rules ANY / ALL /
  OPTIONAL, one rejection stops; approval → SCHEDULED through `schedulePost`; edit resets review
  (FR-A3, post back to DRAFT + reviews invalidated by `postVersion`); 3-hour grace → EXPIRED_REVIEW
  in the sweeper (FR-A4); OperationalEvent audit.
- PENDING_REVIEW needs a requested slot: store it in `scheduledAt` while pending.
- Routes: `posts/[id]/review`, `posts/[id]/decision`, `posts/[id]/notes` (GET/POST),
  `reviews` (GET "mendan kutilmoqda / yuborganlarim / rad etilganlar"), public
  `app/api/content/reviews/[token]` (GET preview, POST decision) + page `app/review/[token]`
  (no session, noindex, branded).
- Telegram: `content:approve:` / `content:reject:` callbacks for member reviewers; email to external
  reviewers (existing mailer).
- UI: "Tasdiqlar" tab, composer "Tasdiqqa yuborish" wired, post detail review history + notes.

### WP-B — Story series, recurrence, posting slots (FR-C9, FR-S8, FR-S9) — AC-4
- Story series: a STORY with N media → N posts sharing `seriesId`, `seriesIndex`, one minute apart.
- Recurrence: daily / weekdays / monthly, end date; ≤ 180 days and ≤ 200 copies; each copy its own
  post with `seriesId`; "edit this / whole series" on unscheduled copies.
- Slots: `GET/PUT accounts/[id]/slots`, "Navbatga qo'shish" puts the post in the next free slot.
- Composer + slots editor UI.

### WP-C — CSV import, AI caption, MCP tools (FR-I1/I2, FR-AI1, §9 MCP)
- CSV preview (no write) + commit; template download; 200 rows; per-row errors.
- AI caption: topic + tone + language → 3 variants + ≤ 15 hashtags through the existing LLM provider
  and `LlmUsage`, within the workspace AI budget.
- MCP: `list_scheduled_posts`, `get_scheduled_post`, `create_post_draft` (preview + confirm, DRAFT
  only), `get_publishing_quota`.

### WP-D (after A–C) — Calendar and insights (FR-S6, FR-S7, FR-V3, FR-V4)
- Drag-and-drop reschedule in month / week (SCHEDULED, DRAFT only), bulk actions in the list
  (shift time, pause, delete, send to review), feed grid preview (last 12 published + scheduled,
  drafts faded), best-times heat map (online_followers when ≥ 100 followers, else own posts' 90-day
  reach, else "Ma'lumot yetarli emas").

### WP-E (after A–C) — Campaign and housekeeping (FR-L1, FR-L5, §7 storage)
- Inline comment-to-DM campaign creation in the composer (keyword, public reply, DM text, link,
  follow-gate) reusing the existing campaign service; caption keyword warning.
- 30-day cleanup of prepared copies of published posts (sweeper), storage counter released.

## Out of scope here
Main-dashboard promotion, ru / en copies, Canva / Drive, RSS, polls — owner decisions or P3.
Real-account acceptance (AC-1…AC-10) needs the owner to reconnect @jamalxann with the publish scope
and to set `MEDIA_S3_*`.
