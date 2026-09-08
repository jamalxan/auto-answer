# Stack

The application libraries, runtime processes, and the actual production
deployment this project runs on.

## Application

| Layer | Tool |
| --- | --- |
| Framework | Next.js 16 (App Router, Turbopack) + React 19 |
| Language | TypeScript 5 |
| ORM / DB | Prisma 7 with the `@prisma/adapter-pg` driver, PostgreSQL |
| Queue | BullMQ 5 on Redis, via `ioredis` |
| Auth | Auth.js / NextAuth 5 (email magic links) |
| Email | Resend (login links) |
| Validation | Zod 4 |
| Charts | Recharts 3 |
| Styling | Tailwind CSS 4 |
| Tests | Vitest 4 |
| Worker runtime | `tsx` (runs `worker/dm-worker.ts`) |
| Instagram | Official Meta Graph API (Instagram Login) |
| i18n | Custom typed dictionary (uz / ru / en), cookie-persisted |

## Runtime — three processes, two datastores

- **Web app + API** (`npm start`): Next.js. Serves the dashboard, the OAuth
  callback, and the incoming webhook.
- **Worker** (`npm run worker`): a long-running Node process. Consumes the
  send queue, sends the DMs, runs the polling reconciler, and performs the
  follow-gate `is_user_follow_business` checks. Must stay always-on.
- **Cron** (`scripts/cron.sh`): a lightweight scheduler loop that calls the
  `/api/cron/*` routes on a timer (attach-next-reel every 5 minutes,
  refresh-tokens and snapshot-followers once a day).
- **PostgreSQL**: campaigns, DM logs, accounts, sessions, tracked links, click
  events.
- **Redis**: the BullMQ send queue and the per-account rate limiter.

The web app and the worker must share the same `DATABASE_URL`, `REDIS_URL`,
and `ENCRYPTION_KEY`. The web app stores the encrypted Instagram token; the
worker decrypts it to send. Different keys mean every send fails to decrypt.

## Production deployment

A single Docker Compose stack (`docker-compose.prod.yml`) on one server,
behind nginx with a Let's Encrypt certificate:

| Service | Image | Notes |
| --- | --- | --- |
| `web` | built from `Dockerfile` | `next start`, proxied by nginx on 127.0.0.1:3000 |
| `worker` | same image | `npm run worker` |
| `cron` | same image | `sh scripts/cron.sh` |
| `postgres` | `postgres:16` | local volume |
| `redis` | `redis:7-alpine` | local volume |

To redeploy after a `git pull`:

```bash
sudo docker compose -f docker-compose.prod.yml build web worker cron
sudo docker compose -f docker-compose.prod.yml up -d --no-deps web worker cron
```

## Environment variables

Names only — values live in `.env` on the server (gitignored), never in the
repo:

`NEXTAUTH_URL`, `NEXTAUTH_SECRET`, `CRON_SECRET`, `ENCRYPTION_KEY`,
`DATABASE_URL`, `REDIS_URL`, `RESEND_API_KEY`, `EMAIL_FROM`, `ALLOWED_EMAILS`,
`META_GRAPH_API_VERSION`, `INSTAGRAM_APP_ID`, `INSTAGRAM_APP_SECRET`,
`FACEBOOK_APP_SECRET`, `WEBHOOK_VERIFY_TOKEN`, `POSTGRES_PASSWORD`.
