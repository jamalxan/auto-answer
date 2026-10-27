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
  existing cron); the vault holds the new channels' tokens (Telegram, Facebook,
  Threads, YouTube) from phase 4 on.
- Meta webhook processing still runs inline in the route (it enqueues per event);
  moving the whole parse into the worker is a separate change.
