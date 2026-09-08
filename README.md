# SocialAuto

Instagram comment-to-DM automation. Someone comments a keyword on a post or
reel, and SocialAuto sends them a private reply through the official
Instagram/Meta API a second later — no scraping, no browser automation, no
password sharing.

## What it does

- Watches comments on connected Instagram professional accounts via webhook
  (with a polling reconciler as a backstop).
- Matches keywords per campaign and sends a Meta-compliant private reply,
  with an optional public reply under the comment.
- Supports an opening DM, a follow-gate before revealing the link, tracked
  links with click analytics, and a delayed follow-up message.
- Multi-account workspaces with team roles and shareable, read-only client
  reports.
- Multi-language dashboard and marketing site (Uzbek, Russian, English).

## Stack

Next.js (App Router) + React, TypeScript, Prisma/PostgreSQL, Redis + BullMQ,
NextAuth (email magic links), Tailwind CSS. See [docs/stack.md](docs/stack.md)
for the full architecture.

## Local development

```bash
npm install
docker compose up -d       # Postgres + Redis for local dev
cp .env.example .env       # fill in the values
npx prisma migrate dev
npm run dev                # web app
npm run worker             # DM delivery worker, in a second terminal
```

## Deployment

The production deployment is a Docker Compose stack (`docker-compose.prod.yml`)
behind nginx: `web`, `worker`, `cron`, `postgres`, and `redis` services. See
[docs/stack.md](docs/stack.md) for the environment variables and process
layout.
