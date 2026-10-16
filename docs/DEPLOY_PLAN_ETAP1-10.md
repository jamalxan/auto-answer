# FINAL DEPLOY CHECKLIST (ETAP 1-12) — updated 2026-10-16

Merge tip: `developer-etap12` (commit e6019d0). All branches are on GitHub.
Verified on the tip: prisma validate, tsc, eslint (0 errors), vitest 2409/2409,
next build OK. Nothing has been deployed yet.

New additive migrations since the deployed `f39167d` (13): comment_automation_2,
etap3, javobai_etap4, crm_etap5, flows_etap6, integration_types_etap8,
outbound_bus_analytics_etap8_10, engagement_etap9, migration_etap11 (`20261022100000`),
mcp_etap12 (`20261023100000`). They only add tables/columns/indexes.

Order (night, after approval):
1. Server `.env`: set `ADMIN_INITIAL_USERNAME`, `ADMIN_INITIAL_EMAIL`,
   `ADMIN_INITIAL_PASSWORD` (>= 12 chars). Without them `/admin` stays closed.
2. Optional `/developer`: `DEVELOPER_EMAIL` + `DEVELOPER_PASSWORD_HASH`
   (`node scripts/hash-developer-password.mjs`, choose a NEW password).
3. Leave `CRM_ENABLED` unset (CRM stays off). Kill switches default to "on
   unless disabled"; set `MIGRATION_DISABLED=1`, `MCP_DISABLED=1`,
   `ENGAGEMENT_DISABLED=1` if you want those modules inert after deploy.
4. DB backup: `docker exec socialauto-postgres-1 pg_dump -U postgres socialauto > ~/backups/socialauto_$(date +%Y%m%d_%H%M).dump`
5. `git checkout master && git merge --ff-only developer-etap12 && git push origin master`
   (this triggers CI/CD: typecheck + tests -> image -> compose up -> /api/health).
6. Smoke test (section below). Rollback: `APP_TAG=f39167d7d367383fdd824b096a3d107a32f5f8fe`.

> Update 2026-10-18 (2): ETAP 12 (MCP) is in the chain; merge tip is
> `developer-etap12`. Extra additive migration: `20261023100000_mcp_etap12`.
> Switch: `MCP_DISABLED`.

> Update 2026-10-18: ETAP 11 (ManyChat migration) is now part of the chain; the
> tip to merge is `developer-etap11`. One more additive migration:
> `20261022100000_migration_etap11`. Switch: `MIGRATION_DISABLED`.

# Deploy plan — audit fixes + developer area (ETAP 1–10)

> Update 2026-10-17: ETAP 9 (Engagement) is now part of the chain; the tip to
> merge is `developer-etap9` (not `developer-etap6`). One more additive
> migration: `20261021100000_engagement_etap9`. Switch: `ENGAGEMENT_DISABLED`.

Server: AWS `ubuntu@32.199.91.62` (nginx on the host, Docker compose project
`socialauto` in `~/socialauto`). CI/CD already exists: a push to `master`
runs `.github/workflows/deploy.yml` (typecheck + tests → image to GHCR →
`docker compose pull/up` on the server → `/api/health` check).

Checked on 2026-10-16:
- Server runs `ghcr.io/jamalxan/auto-answer:f39167d` (current `master`).
- Tables are tiny (Conversation 13, Lead 6, DmLog 2 rows), so the new indexes
  build instantly — no locking concern on this server.
- `AdminAccount` table is **empty** and `ADMIN_INITIAL_PASSWORD` is unset (see
  step 1).
- None of the developer-area switches are set, so after the deploy every new
  module is off for customers.

## What reaches production

1. **Audit fixes** (branch `audit-fixes`): security hardening and bug fixes
   described in its commit message. These change customer-facing behaviour
   (rate-limited admin login, cron auth, health detail only with the cron
   secret, role checks, Cyrillic language detection, Tashkent report days…).
2. **Developer area** (`/developer`, own login) — closed until
   `DEVELOPER_EMAIL` + `DEVELOPER_PASSWORD_HASH` are set.
3. **Engines** that are inert without a campaign/flow/etc. for an account:
   trigger engine (gated per account), JavobAI (OFF per account), CRM
   (`CRM_ENABLED=1` required), flows (no published flow), integrations bus
   (no subscription), analytics (rollup job only).
4. **Migrations** (additive): audit schema cleanup is not a migration;
   `20261009…` already deployed; new: comment_automation_2, etap3,
   javobai_etap4, crm_etap5, flows_etap6, integration_types_etap8,
   outbound_bus_analytics_etap8_10.

## Before merging (do these first)

1. **Admin panel login.** The hard-coded admin account was removed. Add to the
   server `.env`:
   `ADMIN_INITIAL_USERNAME`, `ADMIN_INITIAL_EMAIL`, `ADMIN_INITIAL_PASSWORD`
   (≥ 12 chars). The first login attempt on an empty `AdminAccount` table
   creates it. Without this, `/admin` cannot be opened.
2. **Developer login** (optional, only if you want `/developer` on the server):
   `DEVELOPER_EMAIL=<email>` and
   `DEVELOPER_PASSWORD_HASH=$(node scripts/hash-developer-password.mjs)`.
   Choose a **new** password — the previous one appeared in git history.
3. **Backup the database**:
   `docker exec socialauto-postgres-1 pg_dump -U postgres socialauto > ~/backups/socialauto_$(date +%Y%m%d_%H%M).dump`
4. **Hourly DM cap (behaviour change).** `DM_HOURLY_LIMIT_DEFAULT` now
   defaults to **200** per Instagram account per hour; production used a
   hard-coded **750** before. Set it explicitly in the server `.env`
   (`DM_HOURLY_LIMIT_DEFAULT=750` preserves the previous production behaviour)
   until the owner has confirmed Meta's current figure; a per-account
   override (`InstagramAccount.dmHourlyLimit`) wins over it. Sends over the
   cap wait for the next window and are given up (FAILED, "Soatlik limit
   tufayli yuborilmadi — muddat o'tdi") after 24h (DMs) / 7 days (private
   replies to comments).
5. Optional switches (all default OFF): `CRM_ENABLED=1`,
   `JAVOBAI_MODEL`, `JAVOBAI_MODEL_SMART`, `FLOW_*`; see `.env.example`.

## Merge and deploy

The seven earlier commits and the later ones form one chain
(`audit-fixes → developer-etap1 → … → developer-etap12`). Merge the tip
(`developer-etap12`) into `master` with a normal merge commit, then push
`master`; the Deploy workflow does the rest. Because the chain is linear a
fast-forward is enough.

Expected during deploy: `web` runs `prisma migrate deploy` on start, then the
health check passes. If the health check fails the workflow prints
`docker logs socialauto-web-1`.

## After the deploy (smoke test, ~10 minutes)

- `curl https://<domain>/api/health` → `ok` (anonymous callers see statuses only).
- Log in as a normal user: dashboard, campaigns, leads, inbox, assistant.
- Create nothing new; check that an existing comment campaign still sends.
- `/admin/login` with the new admin credentials.
- Follow `docs/developer/TESTING.md` only for the modules you enable.

## Hardening: hide the nginx version (host, one line)

The app now sends HSTS/CSP/X-Frame-Options/etc. itself (`next.config.ts`).
On the host, add one line inside the `http { ... }` block of
`/etc/nginx/nginx.conf`, then `sudo nginx -t && sudo systemctl reload nginx`:

```
server_tokens off;
```

## HSTS (`Strict-Transport-Security`)

The app sends `max-age=31536000` only — deliberately **without**
`includeSubDomains`/`preload`, because other subdomains (e.g. promtchi) are not
verified to be HTTPS-only. Once every subdomain is confirmed to serve valid
HTTPS, change the value in `next.config.ts` (`securityHeaders`) to
`max-age=31536000; includeSubDomains` and, only if you also want browser
preload lists, `; preload` (then submit at hstspreload.org — hard to undo),
and update `__tests__/security-headers.test.ts`.

## Rollback

`docker compose -f docker-compose.server.yml` with
`APP_TAG=f39167d7d367383fdd824b096a3d107a32f5f8fe` pulls the previous image.
Migrations are additive, so the old image keeps working against the new schema.
Restore the dump only if data was damaged.
