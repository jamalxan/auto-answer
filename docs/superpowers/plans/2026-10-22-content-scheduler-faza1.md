# Content Scheduler — Faza 1 (P0 core) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A developer-area Content Scheduler that stores media in an S3-compatible bucket, validates posts per the Instagram field matrix, publishes feed images / carousels / Reels / Stories through the Content Publishing API at the scheduled minute, falls back to Telegram manual publishing, and activates a linked comment-to-DM campaign in the same transaction as the publish.

**Architecture:** New `lib/content/*` domain layer (pure validation + Prisma services), one new Meta client file (`lib/meta/publish.ts`), two new BullMQ queues (`content-publish`, `media-process`) registered in the existing worker process, a minute cron sweeper, and `/developer/content` screens over `/api/developer/content/*` routes. Nothing in the production webhook / DM path changes; `Automation` and `TriggerCampaign` only gain a nullable `scheduledPostId`.

**Tech Stack:** Next.js 16 App Router, Prisma 7, BullMQ 5, Zod 4, Vitest + `__tests__/helpers/memory-db.ts`, `@aws-sdk/client-s3` + `@aws-sdk/s3-request-presigner`, `sharp`, system `ffmpeg`/`ffprobe` via `child_process`.

**Spec:** `docs/superpowers/specs/2026-10-22-content-scheduler-design.md`

## Global Constraints

- Caption ≤ 2200 chars, ≤ 30 hashtags, ≤ 20 @mentions; first comment ≤ 2200; alt text ≤ 1000.
- Username regex `^[a-zA-Z0-9._]{1,30}$`; leading `@` stripped; duplicates merged (case-insensitive).
- Coordinates 0.0–1.0, rounded to 4 decimals.
- scheduledAt ≥ now + 5 min and ≤ now + 365 days; stored UTC; default timezone `Asia/Tashkent`.
- Carousel 2..`CAROUSEL_MAX_ITEMS` (default 10); collaborators ≤ `IG_MAX_COLLABORATORS` (default 3); late rule `LATE_PUBLISH_MAX_MIN` (default 15).
- Feed/carousel image aspect 0.8 (4:5) … 1.91; Reels 3 s–15 min, ≤ 300 MB; Story video 3–60 s, ≤ 100 MB; carousel video ≤ 60 s; image ≤ 8 MB prepared.
- Container prepared `scheduledAt − 30 min` (video `− 60 min`); container status polled every 30 s, video max 20 min; publish accuracy ±60 s.
- Job id `publish_<postId>_<attempt>` (BullMQ forbids `:`); status changes are compare-and-swap on `status` + `version`.
- Per-account Redis lock `content:acct:<id>`; worker concurrency 5 (publish), 1 (media).
- Every service error message in Uzbek; responses `{ success, data | error }`; other workspace's id → 404.
- Kill switch `CONTENT_SCHEDULER_DISABLED=1`; feature stays under `/developer` (dev login + app session).
- Prepared copies deleted 30 days after publish; workspace quota `CONTENT_STORAGE_QUOTA_BYTES` default 5 GB.

## Review Focus

1. A post whose media asset is still `PROCESSING` at prepare time must go FAILED with `PUBLISH_MEDIA_INVALID` ("Media tayyor emas"), not throw and retry forever — Task 8 test `prepare fails cleanly when media not READY`.
2. `media_publish` returns after a timeout but Meta actually published: the second attempt must see `status_code=PUBLISHED` and bind the newest media instead of publishing twice — Task 8 test `publish timeout then PUBLISHED container does not republish`.
3. A FEED_IMAGE draft that receives a video asset must be rejected at validation ("Video feed post Reels sifatida chiqadi — turini Reels qiling"), never sent to Meta as an image — Task 5 test.
4. Deleting a `MediaAsset` used by a SCHEDULED post must be refused (Prisma `Restrict` plus service check) — Task 6 test.
5. A workspace with Telegram disconnected and a NEEDS_MANUAL post: the due handler must mark the post `NEEDS_MANUAL` once, email the owner, and not re-send every sweep — Task 9 test `manual notice is sent once`.

---

### Task 1: Schema, migration, config

**Files:**
- Modify: `prisma/schema.prisma` (append enums + 8 models; add fields to `InstagramAccount`, `Workspace`, `Automation`, `TriggerCampaign`)
- Create: `prisma/migrations/20261030100000_content_scheduler/migration.sql`
- Create: `lib/content/config.ts`
- Test: `__tests__/content-config.test.ts`

**Interfaces:**
- Produces: enums `PostType`, `PostStatus`, `MediaStatus`, `ReviewRule`; models exactly as spec §8 (`ScheduledPost.automations Automation[]`, `triggerCampaigns TriggerCampaign[]`; `Automation.scheduledPostId String?` + relation `scheduledPost ScheduledPost?`; same on `TriggerCampaign`; `InstagramAccount.grantedScopes String[] @default([])`, `canPublish Boolean @default(false)`, `accountType String?`, `publishQuotaUsed Int?`, `publishQuotaCheckedAt DateTime?`; `Workspace.timezone String @default("Asia/Tashkent")`, `mediaStorageBytes BigInt @default(0)`, relations `mediaAssets`, `scheduledPosts`, `savedTexts`).
- Produces `lib/content/config.ts`:
  ```ts
  export function isContentSchedulerEnabled(): boolean           // CONTENT_SCHEDULER_DISABLED
  export const CONTENT_LIMITS = { captionChars: 2200, hashtags: 30, mentions: 20, firstCommentChars: 2200, altTextChars: 1000, minScheduleLeadMs: 5*60_000, maxScheduleAheadMs: 365*86_400_000, storySeriesGapMs: 60_000, sameMinuteGapMs: 120_000 } as const
  export function carouselMaxItems(): number                       // CAROUSEL_MAX_ITEMS, default 10, 2..20
  export function maxCollaborators(): number                       // IG_MAX_COLLABORATORS, default 3, 1..5
  export function latePublishMaxMs(): number                       // LATE_PUBLISH_MAX_MIN*60_000, default 15 min
  export function storageQuotaBytes(): number                      // CONTENT_STORAGE_QUOTA_BYTES, default 5 GiB
  export const PREPARE_LEAD_MS = { image: 30*60_000, video: 60*60_000 } as const
  export const CONTAINER_POLL_MS = 30_000; export const CONTAINER_MAX_WAIT_MS = { image: 5*60_000, video: 20*60_000 } as const
  export const FIRST_COMMENT_DELAY_MS = 10_000
  export const MEDIA = { imageMaxUploadBytes: 30*1024**2, videoMaxUploadBytes: 1024**3, imagePreparedMaxBytes: 8*1024**2, reelMaxBytes: 300*1024**2, storyVideoMaxBytes: 100*1024**2, imageMaxWidth: 1440, feedAspectMin: 0.8, feedAspectMax: 1.91, reelMinMs: 3_000, reelMaxMs: 15*60_000, storyMinMs: 3_000, storyMaxMs: 60_000, carouselVideoMaxMs: 60_000 } as const
  ```

- [ ] **Step 1: Write failing config test** (`__tests__/content-config.test.ts`): `carouselMaxItems()` is 10 by default, 20 with env `CAROUSEL_MAX_ITEMS=20`, clamps `99`→20 and `abc`→10; `isContentSchedulerEnabled()` false with `CONTENT_SCHEDULER_DISABLED=1`; `latePublishMaxMs()` = 900000 default. Use `vi.stubEnv`.
- [ ] **Step 2: Run** `npx vitest run __tests__/content-config.test.ts` → FAIL (module missing).
- [ ] **Step 3: Implement `lib/content/config.ts`** per Interfaces.
- [ ] **Step 4: Run test** → PASS.
- [ ] **Step 5: Edit `prisma/schema.prisma`**: append spec §8 enums and models verbatim (add `coverMedia MediaAsset? @relation("PostCover", ...)` for `coverMediaId`, `createdBy User? @relation(...)` only if `User` already has such back-relations — otherwise keep `createdById String?` plain). Add the four modified-model fields. `PostingSlot`, `PostReview`, `PostNote` are included now so Faza 2 needs no second migration.
- [ ] **Step 6: Generate**: `npx prisma generate` → success; `npx prisma migrate diff --from-migrations prisma/migrations --to-schema-datamodel prisma/schema.prisma --script > prisma/migrations/20261030100000_content_scheduler/migration.sql` (dev DB URL from `.env`); inspect that it only ADDs tables/columns/enums.
- [ ] **Step 7: Apply locally**: `npx prisma migrate deploy` against the embedded dev Postgres (port 5434) → applied; `npm run typecheck` → clean.
- [ ] **Step 8: Add to `__tests__/helpers/memory-db.ts` RELATIONS**: `scheduledPost: { media: many scheduledPostMedia(postId), instagramAccount: one, workspace: one, attemptsLog: many publishAttempt(postId), automations: many automation(scheduledPostId), triggerCampaigns: many triggerCampaign(scheduledPostId) }`, `scheduledPostMedia: { media: one mediaAsset(mediaId), post: one scheduledPost(postId) }`, `mediaAsset: { usages: many scheduledPostMedia(mediaId) }`; DEFAULTS for `scheduledPost` (`status: "DRAFT", version: 1, attempts: 0, collaborators: [], labels: [], shareToFeed: true, autoPublish: true, isAiGenerated: false, timezone: "Asia/Tashkent", deletedAt: null`), `mediaAsset` (`status: "UPLOADING", tags: []`).
- [ ] **Step 9: Commit** `feat(content): scheduler schema, migration and config`.

### Task 2: OAuth publish scope + grantedScopes / canPublish

**Files:**
- Modify: `lib/meta/oauth.ts:94-105` (scope string, `exchangeCodeForToken` return), `app/api/instagram/callback/route.ts:46-115`
- Create: `lib/content/permissions.ts`
- Test: `__tests__/oauth.test.ts` (extend), `__tests__/content-permissions.test.ts`

**Interfaces:**
- `exchangeCodeForToken` returns `{ accessToken, userId, permissions: string[] }` (Instagram Login's token response carries `permissions`; absent → `[]`).
- `lib/content/permissions.ts`: `export const PUBLISH_SCOPE = "instagram_business_content_publish"`; `export function canPublishFromScopes(scopes: string[]): boolean`; `export type ContentPermission = "content.view" | "content.create" | "content.schedule" | "content.approve"`; `export function canContent(role: string | null | undefined, p: ContentPermission): boolean` — VIEWER: view; OPERATOR (and MEMBER): view+create; MANAGER/ADMIN/OWNER: all. Uses `normalizeRole` from `lib/workspace-permissions`.

- [ ] **Step 1: Failing tests**: `getAuthorizationUrl` scope contains `instagram_business_content_publish`; `canPublishFromScopes(["instagram_business_basic"])` false, with publish scope true; `canContent("OPERATOR","content.schedule")` false, `canContent("MANAGER","content.schedule")` true, `canContent("VIEWER","content.create")` false, `canContent("MEMBER","content.create")` true.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**: scope string; `permissions` parsed from token JSON (`data.permissions` may be an array or comma string — normalize); callback upsert writes `grantedScopes: permissions`, `canPublish: canPublishFromScopes(permissions)` in both `create` and `update`.
- [ ] **Step 4: Run tests + `npm run typecheck`** → PASS.
- [ ] **Step 5: Commit** `feat(content): request content_publish scope, store granted scopes`.

### Task 3: Storage driver (S3-compatible + local)

**Files:**
- Create: `lib/content/storage.ts`, `lib/content/storage-local.ts`, `app/api/developer/content/media/local/[...key]/route.ts` (local driver only: GET serves a file given a valid HMAC token, PUT accepts an upload)
- Test: `__tests__/content-storage.test.ts`
- Modify: `package.json` (add `@aws-sdk/client-s3`, `@aws-sdk/s3-request-presigner`)

**Interfaces:**
```ts
export interface StorageDriver {
  presignPut(key: string, opts: { contentType: string; contentLength: number; expiresSec: number }): Promise<{ url: string; headers: Record<string,string> }>;
  presignGet(key: string, expiresSec: number): Promise<string>;
  getObject(key: string): Promise<Buffer>;
  putObject(key: string, body: Buffer, contentType: string): Promise<void>;
  deleteObject(key: string): Promise<void>;
  headObject(key: string): Promise<{ size: number; contentType?: string } | null>;
}
export function getStorage(): StorageDriver           // MEDIA_STORAGE_DRIVER=s3|local (default s3 when MEDIA_S3_BUCKET set, else local)
export function mediaKey(workspaceId: string, ext: string, now?: Date): string   // ws/<wsId>/<yyyy>/<mm>/<cuid>.<ext>
export function isStorageConfigured(): boolean
```
Env: `MEDIA_S3_ENDPOINT`, `MEDIA_S3_REGION` (default `auto`), `MEDIA_S3_BUCKET`, `MEDIA_S3_ACCESS_KEY`, `MEDIA_S3_SECRET_KEY`, `MEDIA_S3_FORCE_PATH_STYLE` (default `1`), `MEDIA_LOCAL_DIR` (default `.media`), `NEXTAUTH_URL` for local URLs.

- [ ] **Step 1: Failing tests**: `mediaKey("ws1","jpg",new Date("2026-10-22T10:00:00Z"))` matches `/^ws\/ws1\/2026\/10\/[a-z0-9]+\.jpg$/`; local driver round-trip put→head→get→delete in a temp dir; local `presignPut` URL contains a `token` query whose HMAC verifies via exported `verifyLocalToken(key, token, exp)`; S3 driver with `MEDIA_S3_*` stubbed builds a presigned PUT URL containing the bucket and `X-Amz-Signature` (no network).
- [ ] **Step 2: Run** → FAIL. Install deps: `npm i @aws-sdk/client-s3 @aws-sdk/s3-request-presigner`.
- [ ] **Step 3: Implement** both drivers; local route handlers verify HMAC (`NEXTAUTH_SECRET`) over `key|exp`, reject expired, path-traversal-safe (`key` must match `/^ws\/[a-z0-9]+\/\d{4}\/\d{2}\/[a-z0-9-]+\.[a-z0-9]+$/`, and prepared/thumb variants `…\.(prepared|thumb)\.[a-z0-9]+$`).
- [ ] **Step 4: Run tests** → PASS.
- [ ] **Step 5: Commit** `feat(content): S3-compatible and local media storage drivers`.

### Task 4: Meta publish client

**Files:**
- Create: `lib/meta/publish.ts`
- Test: `__tests__/meta-publish.test.ts` (`vi.stubGlobal("fetch", …)`)

**Interfaces:**
```ts
export type ContainerStatus = "IN_PROGRESS" | "FINISHED" | "ERROR" | "EXPIRED" | "PUBLISHED";
export interface UserTagParam { username: string; x?: number; y?: number }
export interface ContainerParams {
  imageUrl?: string; videoUrl?: string;
  mediaType?: "REELS" | "STORIES" | "CAROUSEL"; isCarouselItem?: boolean; children?: string[];
  caption?: string; userTags?: UserTagParam[]; collaborators?: string[]; altText?: string;
  coverUrl?: string; thumbOffsetMs?: number; shareToFeed?: boolean; audioName?: string;
  trialStrategy?: "MANUAL" | "SS_PERFORMANCE"; locationId?: string; isAiGenerated?: boolean;
}
export async function createContainer(token: string, igUserId: string, p: ContainerParams): Promise<{ id: string }>
export async function getContainerStatus(token: string, containerId: string): Promise<{ status: ContainerStatus; statusText?: string }>   // fields=status_code,status
export async function publishContainer(token: string, igUserId: string, creationId: string): Promise<{ id: string }>
export async function getPublishedMedia(token: string, mediaId: string): Promise<{ id: string; permalink?: string; media_product_type?: string; timestamp?: string }>
export async function getPublishingLimit(token: string, igUserId: string): Promise<{ quotaUsage: number; quotaTotal: number }>   // fields=quota_usage,config{quota_total}
export async function createComment(token: string, mediaId: string, message: string): Promise<{ id: string }>
export function containerParamsToBody(p: ContainerParams): URLSearchParams   // pure; user_tags/collaborators/children JSON-encoded, booleans "true"/"false", trial_params JSON
```
All use `POST`/`GET` on `https://graph.instagram.com/<ver>/…` with the token in `Authorization: Bearer`; errors go through the existing `handleResponse` (export it from `lib/meta/client.ts` as `handleMetaResponse`).

- [ ] **Step 1: Failing tests**: `containerParamsToBody` maps `userTags` → `user_tags` JSON with x/y, `shareToFeed:false` → `"false"`, `children` → comma list, `trialStrategy` → `trial_params={"graduation_strategy":"MANUAL"}`, `isCarouselItem` → `is_carousel_item=true`, omits undefined; `createContainer` posts to `/<ig>/media` and returns id; `getContainerStatus` maps `status_code`; `publishContainer` posts `creation_id`; `getPublishingLimit` reads `data[0].quota_usage` and `config.quota_total` (default 50 when missing); a 190 response throws `TokenExpiredError`; a `{code:9}` response throws `MetaApiError` code 9.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**.
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** `feat(meta): content publishing client`.

### Task 5: Domain schema + validation (field matrix)

**Files:**
- Create: `lib/content/schema.ts` (Zod input schemas), `lib/content/validate.ts` (pure rules), `lib/content/text.ts` (caption counters, username normalizer), `lib/content/time.ts` (tz conversion)
- Test: `__tests__/content-validate.test.ts`, `__tests__/content-text.test.ts`, `__tests__/content-time.test.ts`

**Interfaces:**
```ts
// text.ts
export function countCaption(text: string): { chars: number; hashtags: number; mentions: number }   // chars = Array.from(text).length (code points), hashtags = /(^|\s)#[\p{L}\p{N}_]+/gu, mentions = /(^|\s)@[A-Za-z0-9._]+/g
export function normalizeUsernames(list: string[]): string[]                                        // strip @, trim, lowercase-dedupe, keep first casing, drop invalid
export const USERNAME_RE = /^[a-zA-Z0-9._]{1,30}$/
// time.ts
export function zonedToUtc(date: string /*YYYY-MM-DD*/, time: string /*HH:mm*/, tz: string): Date   // Intl-based, no library
export function utcToZoned(d: Date, tz: string): { date: string; time: string }
export function isValidTimeZone(tz: string): boolean
// schema.ts
export const userTagSchema, mediaItemInputSchema = { mediaId, altText?, userTags?: UserTag[], cropRect? }
export const postInputSchema  // { instagramAccountId, type, caption?, firstComment?, collaborators?, shareToFeed?, coverMediaId?, thumbOffsetMs?, trialStrategy?, audioName?, locationId?, isAiGenerated?, autoPublish?, manualReason?, media: MediaItemInput[], labels?, linkCampaign?: { automationId?: string; triggerCampaignId?: string } }
export const scheduleInputSchema  // { scheduledAt: ISO string | {date,time,timezone} }
export const postsQuerySchema     // { from?, to?, account?, status?, type?, q?, page?, pageSize? }
// validate.ts
export type ValidationIssue = { field: string; message: string }
export interface MediaFacts { id: string; kind: "IMAGE"|"VIDEO"; status: MediaStatus; width?: number|null; height?: number|null; durationMs?: number|null; sizeBytes: number }
export function validatePost(input: PostInput, media: MediaFacts[], opts: { carouselMax: number; maxCollaborators: number; now?: Date }): ValidationIssue[]
export const FIELD_MATRIX: Record<PostType, { caption, userTags, userTagCoords: "required"|"optional"|"none", collaborators, firstComment, altText, cover, shareToFeed, trial, location, aiFlag }>   // spec §6
export function scheduleIssues(at: Date, now: Date): ValidationIssue[]
```

- [ ] **Step 1: Failing tests** (spec AC-11 + §6 + Review Focus 3): 2300-char caption → issue `caption`; 31 hashtags → `caption` "30 ta hashtag"; 21 mentions → issue; STORY with caption → issue `caption` ("Story'da caption yo'q"); STORY with collaborators → issue; FEED_IMAGE with VIDEO asset → issue `type`; FEED_IMAGE with 3:1 image (3000×1000) → issue `media[0]` containing "1.91"; FEED_IMAGE user tag without x/y → issue; REEL user tag without x/y → ok; CAROUSEL with 1 item → issue, 11 items (max 10) → issue; CAROUSEL video 61 s → issue; STORY video 62 s → issue "60 s"; REEL 2 s → issue; REEL 301 MB → issue; collaborators 4 (max 3) → issue; collaborator "bad name!" → issue; media not READY → issue `media[0]` "tayyor emas"; `countCaption("salom #a #b @x 👋")` → `{chars:17, hashtags:2, mentions:1}` (count precisely in the test); `normalizeUsernames(["@Foo","foo","Bar!","  baz "])` → `["Foo","baz"]`; `zonedToUtc("2026-10-24","19:00","Asia/Tashkent")` → `2026-10-24T14:00:00.000Z`; `utcToZoned` inverse; `scheduleIssues(now+4min)` → issue, `now+6min` → none, `now+366d` → issue.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(content): post schemas, field-matrix validation, caption counters, tz helpers`.

### Task 6: Media service + processing worker

**Files:**
- Create: `lib/content/media.ts` (service), `lib/content/media-process.ts` (sharp/ffmpeg), `lib/content/queue.ts` (both queues — publish job types defined here too, used by Task 8), `lib/content/worker.ts` (skeleton: media worker only; Task 8 adds publish)
- Modify: `package.json` (add `sharp`), `Dockerfile` (apt `ffmpeg`), `worker/dm-worker.ts` (register `createContentWorkers()` / `runContentMaintenance()` when enabled)
- Test: `__tests__/content-media.test.ts`, `__tests__/content-media-process.test.ts` (sharp real on a generated PNG; ffprobe mocked via injected `exec`)

**Interfaces:**
```ts
// queue.ts
export const CONTENT_PUBLISH_QUEUE = "content-publish"; export const MEDIA_PROCESS_QUEUE = "media-process";
export const PREPARE_JOB = "prepare"; export const PUBLISH_JOB = "publish"; export const FIRST_COMMENT_JOB = "first-comment"; export const MANUAL_NOTIFY_JOB = "manual-notify"; export const MEDIA_PROCESS_JOB = "media-process";
export interface PublishJob { postId: string; attempt: number }
export interface MediaProcessJob { mediaId: string }
export function getContentPublishQueue(): Queue<PublishJob>; export function getMediaProcessQueue(): Queue<MediaProcessJob>
export function hasContentQueueBackend(): boolean
export async function schedulePrepare(postId: string, attempt: number, at: Date): Promise<void>     // jobId publish_<postId>_<attempt>_prepare
export async function schedulePublish(postId: string, attempt: number, at: Date): Promise<void>     // jobId publish_<postId>_<attempt>
export async function scheduleFirstComment(postId: string, delayMs: number): Promise<void>
export async function scheduleManualNotify(postId: string, at: Date): Promise<void>
export async function enqueueMediaProcess(mediaId: string): Promise<void>                           // jobId media_<id>
export async function removePostJobs(postId: string, attempt: number): Promise<void>
// media.ts
export const presignInputSchema = z.object({ fileName, mimeType: enum[jpeg,png,webp,heic,heif,mp4,quicktime], sizeBytes: int>0 })
export async function presignUpload(workspaceId: string, userId: string, input: PresignInput): Promise<{ mediaId: string; uploadUrl: string; headers: Record<string,string>; expiresInSec: 900 }>  // creates MediaAsset UPLOADING; refuses over per-kind max and over storage quota (Workspace.mediaStorageBytes + size > quota → 413 "Ombor kvotasi to'ldi")
export async function completeUpload(workspaceId: string, mediaId: string): Promise<MediaAsset>     // headObject must exist and size match → PROCESSING + enqueue; else 400
export async function listMedia(workspaceId: string, q: { kind?, tag?, status?, page?, pageSize? }): Promise<{ items: MediaRow[]; total: number }>   // MediaRow includes thumbUrl (signed 1h) and usedByPostIds
export async function deleteMedia(workspaceId: string, mediaId: string): Promise<void>              // 409 if any usage whose post is not in {PUBLISHED, PUBLISHED_MANUAL, CANCELED, FAILED, REJECTED, EXPIRED_REVIEW} and deletedAt null; deletes objects; sets DELETED; decrements mediaStorageBytes
export async function signedMediaUrl(key: string, expiresSec?: number): Promise<string>
// media-process.ts
export interface Probe { width?: number; height?: number; durationMs?: number; codec?: string; fps?: number; audioCodec?: string; bitrate?: number; faststart?: boolean }
export async function probeVideo(file: string, exec?: ExecFn): Promise<Probe>                        // ffprobe -v error -print_format json -show_streams -show_format
export function needsTranscode(p: Probe): boolean                                                    // codec not h264/hevc, fps outside 23–60, bitrate > 25 Mbps, audio not aac, !faststart
export function ffmpegArgs(input: string, output: string, p: Probe): string[]                        // libx264 -preset veryfast -crf 23 -r clamp -c:a aac -b:a 128k -ar 48000 -movflags +faststart -maxrate 25M
export async function prepareImage(buf: Buffer): Promise<{ out: Buffer; width: number; height: number }>  // sharp: rotate(), toColorspace srgb, resize width ≤1440, jpeg q 90 → if > 8 MB retry q 80, 70
export async function makeThumb(buf: Buffer | string /*video path*/, kind): Promise<Buffer>          // 640 px JPEG; video: ffmpeg -ss 0.5 frame
export async function processMedia(mediaId: string, deps?: ProcessDeps): Promise<void>               // UPLOADING/PROCESSING → READY (preparedKey, thumbKey, metadata) or FAILED (error); updates Workspace.mediaStorageBytes with prepared+thumb sizes; MIME verified by magic bytes (first 16 bytes: FFD8FF jpeg, 89504E47 png, RIFF…WEBP, ftyp… heic/mp4/mov) → mismatch FAILED "Fayl turi mos emas"
```
`ProcessDeps = { storage?: StorageDriver; exec?: ExecFn; tmpDir?: string }` for tests. ffmpeg runs with a 10-minute timeout and `nice -n 10` when available; sharp `limitInputPixels: 50e6`.

- [ ] **Step 1: Failing tests (media.ts, memory-db)**: presign creates UPLOADING asset with key under `ws/<ws>/`; sizeBytes 31 MB image → 413; quota exceeded → 413; `completeUpload` with storage.headObject null → 400 and asset stays UPLOADING; with matching head → PROCESSING and `enqueueMediaProcess` called (mock queue); `deleteMedia` on asset used by SCHEDULED post → 409; used only by PUBLISHED post → ok; other workspace id → 404.
- [ ] **Step 2: Failing tests (media-process.ts)**: `prepareImage` on a 3000×1000 sharp-generated PNG returns JPEG width 1440; `needsTranscode({codec:"h264",fps:30,bitrate:8e6,audioCodec:"aac",faststart:true})` false, with `fps:120` true, `codec:"vp9"` true; `ffmpegArgs` contains `-movflags +faststart` and `-b:a 128k`; `probeVideo` parses a canned ffprobe JSON (exec mocked) into `{width:1080,height:1920,durationMs:45000,codec:"h264",fps:30}`; `processMedia` with a PNG whose magic bytes say JPEG mismatch → FAILED; happy image path → READY with thumbKey and preparedKey, workspace bytes incremented.
- [ ] **Step 3: Run** → FAIL. Install `sharp`. **Step 4: Implement** all four files; `worker.ts` exports `createContentWorkers(): { publish: Worker; media: Worker }` (publish processor stub returns `{ skipped: "not yet" }` until Task 8) and `runContentMaintenance()` (no-op until Task 9). Register in `worker/dm-worker.ts` behind `isContentSchedulerEnabled()`; add to `shutdown`. Dockerfile runner stage: `apt-get install -y --no-install-recommends wget ca-certificates ffmpeg`.
- [ ] **Step 5: Run tests + typecheck** → PASS. **Step 6: Commit** `feat(content): media library service and processing worker`.

### Task 7: Post service, transitions, quota, campaign link

**Files:**
- Create: `lib/content/transitions.ts`, `lib/content/service.ts`, `lib/content/quota.ts`, `lib/content/link-campaign.ts`, `lib/content/saved-texts.ts`
- Test: `__tests__/content-transitions.test.ts`, `__tests__/content-service.test.ts`, `__tests__/content-quota.test.ts`, `__tests__/content-link-campaign.test.ts`

**Interfaces:**
```ts
// transitions.ts (pure)
export const TRANSITIONS: Record<PostStatus, PostStatus[]>   // spec §7 table exactly
export function canTransition(from: PostStatus, to: PostStatus): boolean
export const EDITABLE: PostStatus[] = ["DRAFT","SCHEDULED","PAUSED","FAILED","NEEDS_MANUAL","REJECTED","EXPIRED_REVIEW","CANCELED"]
export const TERMINAL: PostStatus[] = ["PUBLISHED","PUBLISHED_MANUAL"]
// service.ts  (every fn takes workspaceId first; unknown id → throws ServiceError 404 "Post topilmadi"; uses lib/crm/result ServiceResult via run())
export class ContentError extends Error { constructor(public status: number, message: string) }
export async function createPost(ws, userId, input: PostInput): Promise<PostDetail>                // DRAFT; validates media belong to ws; stores media rows; story caption dropped; FEED_IMAGE+video → ContentError 400
export async function updatePost(ws, id, input: Partial<PostInput> & { version: number }): Promise<PostDetail>   // 409 "Post boshqa joyda o'zgartirilgan" on version mismatch; refuses unless status in EDITABLE; version++ ; if status was SCHEDULED/PAUSED: re-validate; reviews reset (Faza 2)
export async function getPost(ws, id): Promise<PostDetail>                                           // + media (signed thumb URLs), attemptsLog, linked campaign summary
export async function listPosts(ws, q: PostsQuery): Promise<{ items: PostCard[]; total: number }>
export async function schedulePost(ws, id, at: Date, opts: { now?: Date }): Promise<PostDetail>     // validatePost must be clean; scheduleIssues; same-minute shift (+2 min while another SCHEDULED post of the account is within 60 s); quota check (quota.ts) → 409 PUBLISH_QUOTA message; sets SCHEDULED, attempts++ , calls schedulePrepare + schedulePublish; if !autoPublish or manualReason → status stays SCHEDULED but jobs = scheduleManualNotify only
export async function publishNow(ws, id): Promise<PostDetail>                                        // scheduledAt = now+1 min, same path
export async function pausePost / resumePost / unschedulePost(ws, id)                                 // CAS; pause removes jobs; resume re-schedules (must still be ≥ now+5m else 400)
export async function retryPost(ws, id): Promise<PostDetail>                                         // FAILED → SCHEDULED with scheduledAt=max(old, now+1m)
export async function cancelPost(ws, id)                                                             // → CANCELED (from SCHEDULED/PAUSED/NEEDS_MANUAL/FAILED), pauses linked campaign
export async function deletePost(ws, id)                                                             // soft delete; removes jobs; pauses linked campaign (FR-L4)
export async function duplicatePost(ws, id, opts: { instagramAccountId?: string }): Promise<PostDetail>
export async function markPublishedManually(ws, id): Promise<PostDetail>                             // NEEDS_MANUAL → PUBLISHED_MANUAL, publishedAt now
export async function validateDraft(ws, input: PostInput): Promise<ValidationIssue[]>
// quota.ts
export async function accountQuota(accountId: string, now?: Date): Promise<{ used: number; total: number; scheduledNext24h: number; resetsAt: Date | null; source: "api"|"cache"|"default" }>  // calls getPublishingLimit at most every 10 min (publishQuotaCheckedAt), stores publishQuotaUsed; default total 50
export function quotaWindowFull(q, extra = 1): boolean       // used + scheduledNext24h + extra > total
// link-campaign.ts
export async function attachCampaignToPost(ws, postId, link: { automationId?: string; triggerCampaignId?: string }): Promise<void>   // sets scheduledPostId; Automation: isActive=false, postId=null, pendingNextReel=false; TriggerCampaign: active=false, mediaScope=SPECIFIC, mediaIds=[]
export async function activateLinkedCampaigns(tx, postId: string, igMediaId: string): Promise<{ automations: number; triggers: number }>   // in the publish transaction: Automation.postId=igMediaId,isActive=true; TriggerCampaign.mediaIds=[igMediaId],active=true
export async function pauseLinkedCampaigns(postId: string): Promise<void>
export function captionMentionsKeyword(caption: string | null, keywords: string[]): boolean   // FR-L5 warning helper
// saved-texts.ts
export const savedTextInputSchema = { title ≤32, body ≤16192, tags[] }
export async function listSavedTexts(ws) / createSavedText(ws, input) / updateSavedText(ws, id, input) / deleteSavedText(ws, id)
```

- [ ] **Step 1: Failing transition tests**: `canTransition("SCHEDULED","PREPARING")` true, `("PUBLISHED","DRAFT")` false, `("FAILED","NEEDS_MANUAL")` true, `("PUBLISHING","DRAFT")` false; every status in the spec table has an entry.
- [ ] **Step 2: Failing service tests (memory-db; mock `./queue` functions and `./quota.accountQuota`)**: createPost stores DRAFT with media rows ordered by position; story caption null; other-workspace media id → 404; updatePost wrong version → 409; updatePost on PUBLISHING → 409 "chiqarilmoqda"; schedulePost at now+4min → 400; at now+10min → SCHEDULED, `schedulePrepare` called with `at = scheduledAt − 30 min` for image and `− 60 min` for REEL, `schedulePublish` with `at = scheduledAt`; two posts same account 30 s apart → second shifted +2 min; quota full (mock used 50/50) → 409; `autoPublish:false` → `scheduleManualNotify` called and no prepare; pause → PAUSED and `removePostJobs` called; resume → SCHEDULED + jobs; deletePost sets deletedAt and calls `pauseLinkedCampaigns`; duplicatePost → new DRAFT with same media rows; markPublishedManually from SCHEDULED → 409, from NEEDS_MANUAL → PUBLISHED_MANUAL; AC-14: `getPost(otherWs, id)` → 404.
- [ ] **Step 3: Failing quota tests**: first call hits `getPublishingLimit` (mocked) and stores `publishQuotaUsed`; second call within 10 min uses cache; Meta error → `source:"default"` total 50 used from scheduled count; `quotaWindowFull({used:49,total:50,scheduledNext24h:1})` true.
- [ ] **Step 4: Failing link tests**: `attachCampaignToPost` deactivates the automation and clears postId; `activateLinkedCampaigns` sets postId + isActive; TriggerCampaign gets `mediaIds=[id]`, `mediaScope:"SPECIFIC"`, `active:true`; `captionMentionsKeyword("Yozing: NARX", ["narx"])` true.
- [ ] **Step 5: Run all** → FAIL. **Step 6: Implement.** **Step 7: Run + typecheck** → PASS.
- [ ] **Step 8: Commit** `feat(content): post service, status machine, quota and campaign linking`.

### Task 8: Publish pipeline worker

**Files:**
- Create: `lib/content/publish.ts`, `lib/content/errors.ts`
- Modify: `lib/content/worker.ts` (real processors), `lib/foundation/error-catalog.ts` (14 new codes from spec §11, `TEXT_RULES` for `content publish` prefixed messages)
- Test: `__tests__/content-publish.test.ts` (memory-db + mocked `@/lib/meta/publish`, `./queue`, `@/lib/telegram/notify`), `__tests__/foundation-error-catalog.test.ts` (extend)

**Interfaces:**
```ts
// errors.ts
export type PublishErrorCode = "PUBLISH_TOKEN_EXPIRED" | "PUBLISH_NO_PERMISSION" | "PUBLISH_QUOTA" | "PUBLISH_RATE_LIMIT" | "PUBLISH_MEDIA_FETCH" | "PUBLISH_MEDIA_INVALID" | "PUBLISH_CONTAINER_TIMEOUT" | "PUBLISH_CONTAINER_EXPIRED" | "PUBLISH_INVALID_USER_TAG" | "PUBLISH_INVALID_COLLABORATOR" | "PUBLISH_PPA_REQUIRED" | "PUBLISH_ACCOUNT_RESTRICTED" | "PUBLISH_UNKNOWN" | "FIRST_COMMENT_FAILED" | "CAMPAIGN_LINK_FAILED"
export function classifyPublishError(err: unknown, containerStatusText?: string): { code: PublishErrorCode; retry: "none" | "backoff" | "new-container" | "new-url" | "manual"; delaysMs: number[] }
// publish.ts (deps injectable for tests: { meta, storage, now, notify })
export async function preparePost(postId: string, attempt: number, deps?): Promise<PrepareResult>   // SCHEDULED→PREPARING (CAS); checks token ACTIVE, canPublish, media READY; signed GET URLs 24h; children containers then parent; polls status until FINISHED (CONTAINER_POLL_MS, max per kind) → READY_TO_PUBLISH; ERROR → classify; EXPIRED → one new container; records PublishAttempt rows (CONTAINER, STATUS)
export async function publishPost(postId: string, attempt: number, deps?): Promise<PublishResult>   // READY_TO_PUBLISH (or SCHEDULED when prepare was skipped for an image <30 min away → run prepare inline) → PUBLISHING (CAS + Redis lock content:acct:<id>) → late check (now − scheduledAt > latePublishMaxMs → FAILED "Vaqt o'tib ketdi") → quota recheck → media_publish → getPublishedMedia → $transaction: PUBLISHED + igMediaId + permalink + activateLinkedCampaigns → scheduleFirstComment if firstComment → notify "✅ … chiqdi" ; on timeout/unknown after media_publish: getContainerStatus → PUBLISHED ⇒ bind newest account media (getUserMedia) instead of republishing
export async function postFirstComment(postId: string, deps?): Promise<void>                        // createComment; firstCommentStatus SENT/FAILED; 3 attempts via BullMQ
export async function failPost(postId: string, code: PublishErrorCode, message: string, opts: { toManual?: boolean }): Promise<void>   // FAILED or NEEDS_MANUAL; notify TG+email+OperationalEvent
```
Worker processors: `PREPARE_JOB` → `preparePost`, `PUBLISH_JOB` → `publishPost`, `FIRST_COMMENT_JOB` → `postFirstComment`, `MANUAL_NOTIFY_JOB` → Task 9 `sendManualNotice`. Backoff: `classifyPublishError().delaysMs` drives `job.moveToDelayed` style re-enqueue with `attempt` unchanged and a `_rN` jobId suffix; `retry:"none"` → `failPost`.

- [ ] **Step 1: Failing tests** (fake timers): image post, `preparePost` creates one container with `image_url` = signed URL, `caption`, `user_tags`, polls FINISHED → READY_TO_PUBLISH, two PublishAttempt rows ok; carousel 3 items → 3 child containers with `is_carousel_item` then parent with `children` order preserved, parent gets caption/collaborators, children get altText/userTags; REEL → `media_type:"REELS"`, `cover_url`, `share_to_feed:false`; STORY → `media_type:"STORIES"`, no caption; `publishPost` → PUBLISHED, igMediaId, permalink, linked Automation `postId=igMediaId,isActive=true`, `scheduleFirstComment` called; **Review Focus 1**: media PROCESSING → FAILED `PUBLISH_MEDIA_INVALID`, no Meta call; **Review Focus 2**: `publishContainer` throws timeout, `getContainerStatus` → PUBLISHED, `getUserMedia` newest id → PUBLISHED once, `publishContainer` called once; token BROKEN → stays SCHEDULED, notify called, no Meta call (AC-10); late by 16 min → FAILED "Vaqt o'tib ketdi"; container ERROR with status text "aspect ratio" → FAILED `PUBLISH_MEDIA_INVALID`; EXPIRED → second container created then FINISHED; 190 during prepare → account token BROKEN-marked (`tokenStatus:"BROKEN"`) + stays SCHEDULED; `classifyPublishError(MetaApiError code 4)` → `{code:"PUBLISH_RATE_LIMIT", retry:"backoff", delaysMs:[60e3,120e3,240e3,480e3]}`; code 9 → PUBLISH_QUOTA; concurrent `publishPost` twice (Promise.all) → one PUBLISHED, one `{skipped}` (CAS); first comment success → `firstCommentStatus:"SENT"`, failure → "FAILED" and post still PUBLISHED; error catalog `explainError("content publish: PUBLISH_QUOTA …")` has Uzbek problem text.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** publish.ts, errors.ts, worker processors, catalog entries (each: `code`, `severity`, `retryable`, `problem`, `cause`, `solution`, `action` from spec §11 table; action `reconnect` for token/permission, `wait` for quota/rate, `retry` for unknown, `none` otherwise).
- [ ] **Step 4: Run + typecheck** → PASS. **Step 5: Commit** `feat(content): publish pipeline with idempotent media_publish and campaign activation`.

### Task 9: Sweeper, late rule, Telegram manual publish

**Files:**
- Create: `lib/content/manual.ts`, `lib/content/sweep.ts`, `app/api/cron/content-sweep/route.ts`
- Modify: `lib/content/worker.ts` (`runContentMaintenance` = `sweepContent()` self-throttled 60 s), `lib/telegram/bot.ts:463-470` (`content:` callback prefix), `lib/telegram/api.ts` (add `sendPhoto`, `sendVideo`, `sendMediaGroup`), `scripts/cron.sh` (call `content-sweep` every minute), `lib/foundation/diagnostics.ts` or `queue-stats.ts` (add `content-publish` + `media-process` counts to the existing queue card)
- Test: `__tests__/content-manual.test.ts`, `__tests__/content-sweep.test.ts`, `__tests__/telegram-bot-content.test.ts` (if a bot test harness exists; else cover `handleContentCallback` directly)

**Interfaces:**
```ts
// manual.ts
export async function sendManualNotice(postId: string, deps?): Promise<{ delivered: "telegram" | "email" | "none" }>   // SCHEDULED/FAILED(toManual) → NEEDS_MANUAL (CAS, sets manualNoticeAt via lastErrorMessage? no — add column? → use PublishAttempt step "MANUAL_NOTICE" as the sent marker); Telegram: media group / photo / video (signed 24h URLs), then caption as its own message, then tags/collaborators list + buttons [["✅ E'lon qildim" content:done:<id>], ["❌ Bekor qilish" content:cancel:<id>]] and url button instagram://; no chats → alertWorkspace email + OperationalEvent
export async function handleContentCallback(data: string, tgUserId: string): Promise<string>        // "content:done:<id>" → markPublishedManually (resolves workspace via TelegramUser/TelegramChat); "content:cancel:<id>" → cancelPost; returns the toast text
export async function bindManualPost(postId: string, deps?): Promise<boolean>                        // FR-N3: newest account media published after publishedAt−5min with matching media type → igMediaId; called by sweep for PUBLISHED_MANUAL rows without igMediaId, publishedAt within 30 min
// sweep.ts
export async function sweepContent(now = new Date()): Promise<{ requeued: number; late: number; manual: number; bound: number; expiredContainers: number }>
//   SCHEDULED/READY_TO_PUBLISH with scheduledAt ≤ now and no live job (queue.getJob(jobId) null, or no backend): re-run schedulePrepare/schedulePublish (same attempt) ; scheduledAt < now − latePublishMaxMs → failPost late; !autoPublish or manualReason and due → sendManualNotice; PREPARING older than CONTAINER_MAX_WAIT_MS.video + 5 min → FAILED PUBLISH_CONTAINER_TIMEOUT; READY_TO_PUBLISH with container older than 23 h → back to SCHEDULED (new container next prepare)
```

- [ ] **Step 1: Failing tests**: `sendManualNotice` with a workspace chat → NEEDS_MANUAL, `sendMediaGroup` called with signed URLs, second call (`sendPhoto` for a single image), caption message, buttons present, a `PublishAttempt` step `MANUAL_NOTICE`; **Review Focus 5**: no chats → email sent once, second `sendManualNotice` call is a no-op (`delivered:"none"`, no second email); `handleContentCallback("content:done:<id>")` → PUBLISHED_MANUAL; `bindManualPost` picks the media whose timestamp ≥ publishedAt − 5 min; `sweepContent`: due SCHEDULED without job → `schedulePublish` called (AC-8); 16 min late → FAILED; due manual → notice; stale PREPARING → FAILED.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement** (cron route mirrors `attach-next-reel`: `isAuthorizedCronRequest`, returns the counters; `cron.sh`: every minute `call content-sweep` under the `minute` loop — add a `last_content` guard like `last_slot`).
- [ ] **Step 4: Run + typecheck** → PASS. **Step 5: Commit** `feat(content): sweeper, late rule and Telegram manual publishing`.

### Task 10: API routes

**Files:**
- Create: `lib/developer/content-guard.ts`; routes under `app/api/developer/content/`: `media/presign/route.ts`, `media/[id]/complete/route.ts`, `media/route.ts` (GET), `media/[id]/route.ts` (DELETE), `posts/route.ts` (GET, POST), `posts/[id]/route.ts` (GET, PATCH, DELETE), `posts/[id]/[action]/route.ts` (POST; action ∈ schedule | publish-now | pause | resume | unschedule | retry | cancel | mark-published | duplicate), `validate/route.ts`, `accounts/[id]/quota/route.ts`, `saved-texts/route.ts`, `saved-texts/[id]/route.ts`, `meta/route.ts` (GET: accounts with canPublish/tokenStatus, campaigns, limits, role flags, storage usage, telegram connected)
- Test: `__tests__/content-api.test.ts` (pattern of `engagement-service.test.ts`: mock dev session + workspace ctx; call route handlers with `NextRequest`)

**Interfaces:**
- `requireContent(access: "view" | "create" | "schedule" | "approve"): Promise<DeveloperAuth>` — maps to `canContent`; writes refuse VIEWER; 404 without dev session.
- Action route mapping: schedule/publish-now/pause/resume/unschedule/retry/cancel → `"schedule"`; mark-published/duplicate → `"create"`; unknown action → 404.
- Route bodies use Task 5/7 schemas; `respond(await run(...))`.

- [ ] **Step 1: Failing tests**: no dev session → 404; VIEWER POST posts → 403; OPERATOR POST posts → 201; OPERATOR POST schedule → 403 (AC-13); MANAGER schedule → 200 with status SCHEDULED; GET posts of other workspace's id → 404; PATCH with stale version → 409; unknown action → 404; GET meta returns `accounts[0].canPublish`.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement.** **Step 4: Run + typecheck** → PASS.
- [ ] **Step 5: Commit** `feat(content): developer API routes for scheduler`.

### Task 11: Developer UI — calendar, composer, library, saved texts, post detail

**Files:**
- Create: `app/developer/(secure)/content/page.tsx`, `components/developer/content/shared.ts`, `content-dashboard.tsx` (tabs: `calendar` | `library` | `texts`; query `?tab=&post=&new=&date=`), `calendar-view.tsx` (month / week / list switch, account + status + type filters, search, quota pill "Bugun X/50", cards per spec §10.1, click empty day → composer with date), `composer.tsx` (form per spec §10.2 order; live counters; media picker with upload via presign→PUT→complete and polling until READY; per-item alt text + tag editor; collaborators; first comment; Reels cover/thumb-offset/share_to_feed; story manual toggle; automation card: pick existing Automation/TriggerCampaign of the account; schedule picker with timezone; buttons "Draft saqlash" / "Rejalashtirish · <date>" / "Hozir chiqarish"; autosave every 5 s on dirty), `tag-editor.tsx` (click-to-place pills on the image, drag, ×), `preview.tsx` (feed card / 9:16 Reels / Story frame), `media-library.tsx` (grid, status, tags, usage, delete, storage quota bar), `saved-texts.tsx`, `post-detail.tsx` (status timeline, attempts table, error explanation + action buttons Retry / Qo'lda chiqarish / Qayta ulash, permalink, linked campaign)
- Modify: `lib/developer/modules.ts` (add `{ key: "content-scheduler", etap: 13, title: "Content Scheduler", summary: "Post, karusel, Reels va Story rejalashtirish; qo'lda e'lon; post → comment-to-DM bog'lanishi.", status: "BUILDING", href: "/developer/content" }`; fix the ETAP 10 summary sentence about deferral)
- Test: `__tests__/content-ui-logic.test.ts` for pure helpers in `shared.ts`: `postCardTone(status)`, `groupPostsByDay(posts, tz)`, `composerButtonLabel(state)`, `fieldVisible(type, field)` (mirrors FIELD_MATRIX import)

UI rules: `components/developer/ui.tsx` primitives (`inputClass`, `primaryButton`, `Pill`, `Field`, `Choice`), Uzbek copy, `requestJson` from `components/developer/comments/shared`, `"use client"`, no new UI libraries, phone-width layout works (composer becomes a full-page stack).

- [ ] **Step 1: Failing helper tests**: `postCardTone("PUBLISHED")` = `"success"`, `"FAILED"` → `"error"`, `"NEEDS_MANUAL"` → `"warning"`, `"DRAFT"` → `"muted"`; `groupPostsByDay` buckets by Asia/Tashkent date; `composerButtonLabel({ mode:"schedule", at, canSchedule:false })` = "Tasdiqqa yuborish"; `fieldVisible("STORY","caption")` false.
- [ ] **Step 2: Run** → FAIL. **Step 3: Implement helpers** → PASS. **Step 4: Build the screens** listed above (one commit per component group is fine). **Step 5:** `npm run typecheck && npm run lint` clean; `npm run dev`, open `/developer/content`, create a draft with a local-driver upload, schedule it, observe SCHEDULED card and post detail — record what was checked in the commit message.
- [ ] **Step 6: Commit** `feat(developer): Content Scheduler screens`.

### Task 12: Docs, env, deploy wiring, regression

**Files:**
- Create: `docs/developer/etap-13-content-scheduler.md` (what is built, env vars, kill switch, Meta prerequisites, how to test on @jamalxann, acceptance checklist AC-1…AC-15 with status)
- Modify: `.env.example` (all `MEDIA_*`, `CONTENT_*`, `CAROUSEL_MAX_ITEMS`, `IG_MAX_COLLABORATORS`, `LATE_PUBLISH_MAX_MIN`), `docs/DECISIONS.md` (append section "Content Scheduler" with the six open-question decisions), `README.md` (one line in the module list), `META_APP_REVIEW.md` (publish permission paragraph + screencast steps from spec §12), `docker-compose.prod.yml` only if a new env must be passed through.

- [ ] **Step 1: Write docs and env example.**
- [ ] **Step 2: Full verification**: `npm run typecheck`, `npm test`, `npm run build` — all clean; paste the summary lines into the commit.
- [ ] **Step 3: Commit** `docs(content): scheduler ETAP 13 notes, env and app-review text`.
- [ ] **Step 4: Open PR** `content-scheduler` → `master` titled "feat: Content Scheduler (ETAP 13, developer area, Faza 1)" with the AC checklist; note that AC-1…AC-10 need the real tester account after the publish scope is granted.

---

## Out of this plan (Faza 2+)

Approval flow and `/review/[token]` (FR-A*), feed grid preview, best times, CSV import, AI caption, recurrence, posting slots, MCP tools, moving screens to `app/(dashboard)/content`, i18n ru/en copies, 30-day prepared-copy cleanup job, storage quota per tariff.
