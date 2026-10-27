# SocialAuto — to'liq avtomatlashtirish (audit hujjati bo'yicha reja)

Manba: owner's audit `SocialAuto audit va to'liq avtomatlashtirish yechimi.md` (2026-10-26).
Owner ruling: "hamma narsani bajar, API keylarni ishning eng oxirida". So every phase is built
and tested without live keys (fixtures / fake transports); the keys + live checks are phase 9.

Rules carried over: new modules live under `/developer` until the owner promotes them
([[developer-area]]); stack stays Node/Next/Prisma/BullMQ (no Python service); every external
call has timeout + retry + 429 handling; tenant filter on every query; secrets never logged.

## Audit facts re-checked 2026-10-26 (MCP, 30 d)

- "39 % LLM errors" = 7/18 calls, but 3 are the AI Flow Builder (dev tool), 3 the JavobAI
  sandbox, 1 a production `reply` with 0 ms latency (failed before any model call). Customer
  traffic: 0/1 in 7 days. Root problem: `llm_usage` stores only ok/false, so nobody can see
  WHY a call failed → phase 1 adds the error kind and splits customer vs tooling calls.
- Latency 11.4 s average is dominated by Flow Builder (16 s, ~4k output tokens) and
  comment_variants (24 s); chat turns are 6–7 s.

## Phases

| # | Phase | Doc section | Status |
|---|---|---|---|
| 1 | Reliability + cleanup: LLM error kinds, customer-vs-tool split, second-vendor failover; legacy → new campaign migration (shadow comparison, cutover, rollback); AI Flow Builder → Beta; lead temperature only when scored; test-data cleanup tool. Landing copy moved to phase 8 (it must match the new tariffs) | Audit, Olib tashlash | done (PR) |
| 2 | AI trust ladder per intent: observe → copilot → auto, readiness (≥50 samples, ≥90 % judge match, 0 critical in last 100, approved fact), auto-rollback, fact candidates with expiry + owner approval, number validator, comment rules, copilot drafts in inbox, manager-bot reply → customer + "add to KB", escalation, golden eval set | AI yordamchi | done (PR) |
| 3 | T0 ChannelAdapter + capability matrix (Instagram behind it, no behaviour change), T1 credential vault (envelope AES-256-GCM, key_version, refresh worker), T2 webhook gateway (dedup 48 h, Telegram secret header), T7 security (SSRF, log redaction, tenant isolation, denial-of-wallet) | T0–T2, T7 | done (PR) |
| 4 | T3 Telegram channel: /start code link, my_chat_member ownership check, publish (text/photo/video/album) via Content Scheduler, discussion comments, channel DMs (Bot API 9.2), Business mode | T3 | done (PR) |
| 5 | Content intelligence: insights (`views` metric), median-relative score, multimodal tags (hook, format, subtitles, CTA, 9:16), typical-error checks, weekly report, 2-week plan + Reel scenario template, Trial Reels A/B | Kontent intellekti | done (PR) |
| 6 | T4 Facebook Page, T5 Threads, T6 YouTube adapters (fixtures, no live keys): OAuth → vault, webhooks, inbox, private-reply / DM-window policy, cross-post with processing poll, daily limits, YouTube quota + comment polling | T4–T6 | done (PR) |
| 7 | Ads: boost suggestion (2× median), CTD context into the agent, CAPI "sold" events, guardrails (daily/monthly cap, CPL auto-pause, owner approval for every spend) | Reklama | done (PR) |
| 8 | Monetization: Start / Biznes / Pro / Agentlik limits (channels, AI replies, video analyses, scheduled posts) enforced; Click / Payme adapters behind flags; landing repositioning (drop "hech qanday funksiya qulflanmagan") | Monetizatsiya, Landing | done (PR #22) |
| 9 | Keys + live checks (owner): Telegram bot tokens, FB Login for Business config_id, Threads app, Google OAuth, Click/Payme, Meta ads scopes; reconnect amoCRM + Telegram alerts | Tokenlar | owner |

Owner-only, not code: YaTT → Business Verification, App Review screencasts, Google OAuth
verification + YouTube audit, BotFather bots, privacy/terms text review by a lawyer, data
localisation opinion.

## Phase 9 runbook (keys + live checks)

Order matters: keys only help once the code runs in production.

1. **Merge the stack** #15 → #22 into master (owner; `gh pr merge` is blocked for Claude).
   The Deploy workflow ships it and runs the migrations. Nothing changes for customers:
   every new module sits under /developer, billing limits are off (`BILLING_ENFORCED` unset),
   Payme/Click answer 404, the ads tick runs only for connected ad accounts.
2. **Server env** (`~/socialauto/.env` on 48.217.83.167, then restart web + worker with `--no-deps`):

   | Key | Where it comes from | Owner action needed |
   |---|---|---|
   | `CREDENTIAL_KEKS`, `CREDENTIAL_KEK_VERSION` | generated (`openssl rand -hex 32`) — vault for FB/Threads/YouTube/ads tokens | no |
   | `LLM_FALLBACK_PROVIDER/MODEL/API_KEY/BASE_URL` | second LLM provider key | key |
   | `FACEBOOK_APP_ID` (+ existing secret) | Meta app | — |
   | `FACEBOOK_LOGIN_CONFIG_ID` | Meta app → Facebook Login for Business → configuration (pages_show_list, pages_manage_posts, pages_read_engagement, pages_manage_engagement, pages_messaging) | Meta console |
   | `FACEBOOK_ADS_CONFIG_ID` | second configuration: ads_management, ads_read, business_management | Meta console |
   | `THREADS_APP_ID`, `THREADS_APP_SECRET` | Meta app → Threads use case; redirect `/api/developer/channels/callback/threads`, webhook `/webhooks/threads` | Meta console |
   | `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google Cloud → OAuth client (web), YouTube Data API v3 enabled; redirect `/api/developer/channels/callback/youtube` | Google console |
   | `PAYME_ENABLED`, `PAYME_MERCHANT_ID`, `PAYME_KEY`, `PAYME_TEST=1` first | Payme Business cabinet; endpoint `https://socialauto.uz/api/billing/payme` | merchant contract (legal entity / YaTT) |
   | `CLICK_ENABLED`, `CLICK_SERVICE_ID`, `CLICK_MERCHANT_ID`, `CLICK_SECRET_KEY` | Click merchant cabinet; prepare/complete `https://socialauto.uz/api/billing/click/{prepare,complete}` | merchant contract |
   | Telegram bot token(s) | BotFather; bot added as channel admin | owner's Telegram |

   Webhooks to register in the Meta app: `/webhooks/facebook` (page feed, messages), `/webhooks/threads`.
3. **Live checks** (Claude can run these once 1–2 are done): connect FB Page / Threads / YouTube in
   /developer/channels, cross-post one test post, private-reply test comment; Payme sandbox
   (`PAYME_TEST=1`) full Create → Perform → Cancel from the Payme test cabinet; Click test payment;
   ads: connect ad account, build one boost (stays PAUSED), reject it; reconnect amoCRM + Telegram alerts.
4. **Turn on billing** only after the owner fixes the final prices: `BILLING_ENFORCED=1`, update the
   DB PricingPlan rows and the /settings "no plan limits" line.
