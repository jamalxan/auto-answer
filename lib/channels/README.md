# Channel layer (audit 2026-10-26, phase 3)

Every social channel sits behind one `ChannelAdapter` (`types.ts`). Business
logic never imports a channel SDK; a new channel is a new adapter registered in
`registry.ts` plus an entry in `capabilities.json`.

| File | What |
|---|---|
| `types.ts` | `ChannelAdapter`, `InboundEvent`, `PostVariant`, `ChannelError` kinds |
| `capabilities.json` / `capabilities.ts` | capability matrix (config), env override `CHANNEL_CAPABILITIES_JSON`, DM / private-reply window helpers |
| `http.ts` | `channelFetch`: timeout, exponential backoff + jitter, 429 `Retry-After`, `Idempotency-Key`, per-tenant hourly cap |
| `instagram.ts` | Instagram adapter over `lib/meta/*` + `normalizeInstagramWebhook` |
| `vault.ts` | `ChannelCredential` envelope encryption (AES-256-GCM DEK per row, KEK by `keyVersion`), rotate, revoke (crypto-shred), tenant-scoped load |
| `refresh.ts` | daily refresh / liveness pass, called from `/api/cron/refresh-tokens` |
| `telegram.ts` | Telegram adapter (phase 4): text / photo / video / album publish, large-file upload, edit, delete, comment reply, channel DM |
| `crosspost.ts` | `ChannelPostTarget`: a Content Scheduler post also goes to Telegram / Facebook / Threads / YouTube at its slot (content sweeper step 11); processing uploads polled, daily limits / quota → `nextAttemptAt` |
| `api.ts` | Graph (Meta) and Google JSON calls over `channelFetch`, error bodies → `ChannelError` kinds, YouTube quota reset at Pacific midnight |
| `facebook.ts` | Facebook Page adapter (phase 6): text / photo / multi-photo / video / Reels, comments, hide, Messenger, private reply, insights; Login for Business; `normalizeFacebookWebhook` |
| `threads.ts` | Threads adapter: container → publish (text, image, video, carousel), replies, hide, insights; Threads login + 60-day token refresh; `normalizeThreadsWebhook` |
| `youtube.ts` | YouTube adapter: resumable upload (video / Shorts), processing poll, comment reply, moderation, statistics; Google OAuth; project quota counter; comment polling |
| `access.ts` | `usableCredentials`: vault load + usable gate + tenant tag + on-demand access-token refresh (YouTube) |
| `policy.ts` | private reply once per comment within the window (claimed `ChannelPrivateReply` row), DM only inside the 24 h window |
| `inbox.ts` | Facebook / Threads / YouTube events → `ChannelMessage`, panel replies, hide, YouTube poll (content sweeper step 12) |

Facebook / Threads / YouTube screen: `/developer/channels` (connect via
`/api/developer/channels/connect/<channel>`, OAuth callback stores the tokens in
the vault). Webhooks: `/webhooks/facebook` (FACEBOOK_APP_SECRET) and
`/webhooks/threads` (THREADS_APP_SECRET), both through
`lib/webhooks/channel-webhook.ts`. All built against fixtures; live keys are phase 9.

Telegram's bot side lives in `lib/telegram/channel.ts`: `my_chat_member` ownership
check (only a linked manager connects a channel, anyone else and the bot leaves),
discussion-group comments, channel DMs (Bot API 9.2), Telegram Business, the
`ChannelMessage` inbox and replies. Screen: `/developer/telegram`.

Webhook gateway: `lib/webhooks/gateway.ts` (1 MB body limit, 48 h dedup,
rate-limited rejection log without the body). Log redaction:
`lib/security/redact.ts`, installed in `instrumentation.ts` (web) and
`worker/dm-worker.ts`. SSRF: `lib/integrations/net.ts` + `lib/integrations2/url-policy.ts`
(already in place before this phase).

## Setup
Nothing is required: without `CREDENTIAL_KEKS` the vault uses a KEK derived
from `ENCRYPTION_KEY`. For production, generate a KEK
(`node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"`),
set `CREDENTIAL_KEKS=1:<key>` and `CREDENTIAL_KEK_VERSION=1`, then run `rewrapCredentials()`.

## Not moved yet (TODO, each with its own regression tests)
- The comment worker, JavobAI runtime and Content Scheduler still call
  `lib/meta/*` directly. The comment guard's hide already goes through the adapter.
- Instagram tokens still live in `InstagramAccount.accessToken` (refreshed by the
  existing cron); the vault holds the new channels' tokens (Facebook, Threads,
  YouTube). Telegram uses the platform bot (audit variant A), so it has no
  per-channel secret; a customer's own bot token (variant B) is not built.
- Telegram inbox messages are answered by a person (panel or the Telegram alert
  button); JavobAI auto-replies are Instagram-only until the runtime is
  channel-neutral. Telegram post statistics need MTProto (audit: later).
- Meta webhook processing still runs inline in the route (it enqueues per event);
  moving the whole parse into the worker is a separate change.
