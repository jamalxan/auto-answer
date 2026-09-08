# Instagram Comment-to-DM Automation — Backend

Backend implementation of the TZ "Instagram Comment-to-DM Automation Platform v1.0"
(rule-based, non-AI comment→DM funnel engine). This covers the API + webhook
receiver + background worker (Sections 5–7, 9 of the spec). The Next.js admin
panel is **not** included — this repo exposes the REST API it would consume.

## Stack

FastAPI · SQLAlchemy 2.0 (async) · PostgreSQL 15 · Redis 7 · ARQ (background jobs) ·
httpx (Meta Graph API client) · JWT auth · Fernet token encryption.

## What's implemented, mapped to the TZ

| TZ section | Where |
|---|---|
| FR-1 Account connection, token refresh, webhook subscribe | `app/routers/accounts.py`, `app/workers/tasks.py::refresh_tokens_job` |
| FR-2 Campaign management, priority resolution | `app/models/campaign.py`, `app/routers/campaigns.py`, `app/workers/tasks.py::_resolve_campaign` |
| FR-3 Keyword matching (case/Cyrillic normalise, modes, negative kw, length guard) | `app/services/keyword_matcher.py`, `app/utils/text_normalize.py` |
| FR-4 Public comment reply + variant rotation + loop prevention | `app/workers/tasks.py::process_comment_event`, `app/services/conversation_engine.py::pick_variant` |
| FR-5 Gate strategies (none / self_confirm=S1 / external_db=S2 / engagement=S5) | `app/services/gate_evaluator.py` |
| FR-6 DM delivery, state machine, quick replies, placeholders | `app/services/conversation_engine.py`, `app/services/template_renderer.py` |
| FR-7 Link management, UTM params | `Campaign.reward_link` / `Campaign.utm_params`, applied automatically via `template_renderer.apply_utm()` everywhere `{link}` is rendered |
| FR-8 Admin panel API surface (preview, test mode) | `app/routers/campaigns.py` (`/preview`, `/test`) |
| FR-9 Logging, filterable events, CSV export | `app/routers/events.py`, `app/routers/leads.py` |
| FR-10 Alerts: token expiry (A10), sustained rate limiting (A9), webhook subscription lost, delivery failure rate | `app/services/notifications.py`, wired into `app/workers/tasks.py` (`refresh_tokens_job`, `check_webhook_subscriptions_job`, `check_delivery_health_job`) and `meta_client.py` (throttle detection) |
| A6 abandoned-conversation timeout | `app/workers/tasks.py::sweep_abandoned_conversations_job` (cron, a few times a day) |
| NFR-4 Idempotency | unique `ig_comment_id` + `IntegrityError` catch in `process_comment_event` |
| NFR-5 Security | `app/security.py` (Fernet + JWT + bcrypt), signature check in `webhooks.py` |
| NFR-6 Rate limiting | `app/services/rate_limiter.py` + `tenacity` backoff in `meta_client.py` |
| NFR-3 missed-webhook recovery | `app/workers/tasks.py::reconciliation_poll_job` (cron, best-effort) |

**Not built here (explicitly out of scope or panel-side):** the Next.js admin
UI itself, S3 (manual audit — this is an admin process, not code), S4 (Meta
native Subscriptions — gate as `external_db`/`none` today, wire in once
eligibility + the exact endpoint are confirmed), click-tracking redirect
service (FR-7.3, marked deferrable to v1.1 in the TZ).

## Before you run this for real — Section 2 & 10 of the TZ still apply

This code implements **all four** automatable gate strategies
(`none`, `self_confirm`, `external_db`, `engagement`) as a per-campaign choice
(FR-5.1), so the S1–S5 decision from TZ section 2.2 doesn't block the build —
you choose it per campaign in the admin panel / API. But two things in
`app/services/meta_client.py` are marked with `IMPORTANT` comments and **must**
be re-verified against current Meta docs before go-live, per the TZ's own
Section 10 risk table:

1. Exact Graph API endpoint paths for private replies / DM sends.
2. Exact permission/scope names for the Meta App (`instagram_business_manage_comments`,
   `instagram_business_manage_messages` or whatever they're called by the time
   you submit for App Review).

## Local setup

```bash
cp .env.example .env
# then fill in:
#   TOKEN_ENCRYPTION_KEY  -> python -c "from cryptography.fernet import Fernet; print(Fernet.generate_key().decode())"
#   APP_SECRET_KEY        -> any long random string
#   META_APP_ID / META_APP_SECRET / META_WEBHOOK_VERIFY_TOKEN / META_OAUTH_REDIRECT_URI
#     from your Meta Developer App (Business type)

docker compose up -d postgres redis
docker compose run --rm api alembic upgrade head
docker compose run --rm api python -m app.cli create-admin --email you@example.com --password "change-me"

docker compose up -d
```

- API: http://localhost:8000 — interactive docs at `/docs`
- Health check: `GET /health`
- Webhook URL to register in the Meta App Dashboard: `https://your-domain/webhooks/instagram`
  (must be HTTPS in production; use ngrok/cloudflared for local testing)

## Running without Docker

```bash
python -m venv .venv && source .venv/bin/activate
pip install -r requirements.txt
alembic upgrade head
uvicorn app.main:app --reload            # API process
arq app.workers.worker_settings.WorkerSettings   # separate terminal: worker process
```

## Meta App configuration checklist (TZ section 7.3)

1. Create a **Business**-type app at developers.facebook.com.
2. Add "Instagram" + "Webhooks" products.
3. Configure Instagram Business Login / Facebook Login for Business, redirect URI = `META_OAUTH_REDIRECT_URI`.
4. Webhook subscription fields: `comments`, `messages`, `messaging_postbacks` — verify token = `META_WEBHOOK_VERIFY_TOKEN`.
5. Re-verify exact permission names in the App Dashboard's Permissions tab (they change — see Section 10).
6. Submit for **App Review** before using on any account without a developer/tester role (TZ 7.3 — this is a hard gate, plan for it as its own phase per TZ section 9, P6).

## Testing a campaign without touching real Instagram

`POST /api/campaigns/{id}/test` runs the keyword-matching + gate-strategy logic
against a fake comment and tells you what *would* happen — no Graph API calls,
no real DM (FR-8.2). `GET /api/campaigns/{id}/preview` renders every message
template with sample placeholder values so you can sanity-check copy before
going live (FR-8.1).

## Running the test suite

```bash
pip install -r requirements-dev.txt
pytest
```

Covers the pure/deterministic layer with no external services required
(a `fake_redis` fixture stands in for Redis; Meta HTTP calls are mocked with
`respx`): keyword matching incl. Cyrillic normalisation and word/contains/exact
modes (FR-3), UTM link building and placeholder rendering (FR-6.5 / FR-7.2),
all four gate strategies (FR-5), message-variant rotation (FR-4.3), the local
rate limiter and sustained-throttle alert de-dupe (NFR-6 / FR-10.1), and
webhook HMAC signature validation (A11). It does **not** cover the DB-backed
routers/worker tasks end-to-end — those were verified manually against a real
Postgres + Redis + running API/worker pair (create campaign → simulated
webhook → idempotent event log → conversation → lead, including the graceful
failure path when a Graph API call itself fails). Wiring that up as automated
integration tests (a test Postgres + `httpx.ASGITransport` against `app.main:app`)
is the natural next step if this repo grows a CI pipeline.

## Open items from TZ Section 11 that remain business decisions, not code

Campaign granularity, repeat-comment behavior, final Uzbek message copy,
static vs dynamic reward links, expected comment volume, and admin user count
are all configurable per-campaign in this backend — nothing in the code forces
a particular answer to those questions.
