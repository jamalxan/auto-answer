# Foundation (ETAP 1, DEV)

TZ §3–7, §51, §60, §61, §63: honest Instagram connection status, reconnect,
user-friendly errors, a per-workspace queue view and a diagnostics checklist.
Developer-only, at `/developer/foundation`; nothing here is linked from the
customer UI. It reads existing tables only — no schema change, no new queue.

```
/developer/foundation ─▶ foundation-dashboard.tsx
                           ├ GET  /api/developer/foundation/overview ─▶ overview.ts
                           │        connections.ts ─▶ connection-status.ts (pure)
                           │        queue-stats.ts (DmLog, DM queue, Redis rate keys)
                           │        diagnostics.ts (pure builders + loader)
                           ├ POST /api/developer/foundation/connections/:id/check ─▶ checkAccountToken
                           └ GET  /api/developer/foundation/errors ─▶ errors-feed.ts ─▶ error-catalog.ts (pure)
```

| File | Role |
|---|---|
| `connection-status.ts` | Account fields → one of the 7 TZ §4.1 statuses + explanation + action. Pure. |
| `error-catalog.ts` | Any error / stored error string → code, severity, retryable, Muammo / Sabab / Yechim, action. Pure. |
| `queue-stats.ts` | `estimateEtaMinutes`, `buildRateUsage` (pure) and `loadQueueStats` (DmLog, DM queue scan, `rate:dm:<instagramId>`). |
| `diagnostics.ts` | `build…Check` per subsystem (pure) and `runDiagnostics(workspaceId)`. |
| `connections.ts` | Load accounts with derived status; manual re-check (real Graph call). |
| `errors-feed.ts` | Last 7 days of DmLog / WebhookEvent / OperationalEvent / InstagramEvent failures, explained. |
| `overview.ts` | One call for the screen: loads connections + queue once and feeds them to diagnostics. |
| `time.ts` | `withTimeout`, `formatAgo`, `formatMinutes`. |

## Connection status rules (first match wins)

| Condition | Status |
|---|---|
| `accessToken = ""`, reason = Meta deauthorize callback | `RECONNECT_REQUIRED` |
| `accessToken = ""` (user disconnected) | `DISCONNECTED` |
| `tokenExpiresAt` in the past | `EXPIRED` |
| `BROKEN`, 190/463 or "Session has expired" | `EXPIRED` |
| `BROKEN`, 190/458 app removed · 459 checkpoint · 460 password changed · 464 unconfirmed | `RECONNECT_REQUIRED` |
| `BROKEN`, 190/467, other 190, or token cannot be decrypted | `INVALID` |
| `BROKEN`, anything else | `ERROR` (re-check) |
| `ACTIVE`, last check (or connect) > 24h ago | `ERROR` (status unknown, re-check) |
| `ACTIVE`, expires within 10 days | `EXPIRING` |
| otherwise | `CONNECTED` |

The reason comes from `tokenLastError`, written by `markTokenBroken` with
Meta's message plus the `[code=190 sub=463 …]` tail from `lib/meta/client`.
Subcode wins; Meta's wording is the fallback when the subcode is missing.

## Rules worth knowing

- **Tenant isolation.** Every query filters by `auth.ctx.workspaceId`. The DM
  queue is shared, so its jobs are filtered by the workspace's Instagram ids
  instead of showing global counts. `OperationalEvent` rows with
  `workspaceId = null` are platform-wide and never shown. Worker health is
  reduced to healthy + age (the heartbeat's host/pid are platform data).
- **Rate keys use the Instagram id** (`rate:dm:<InstagramAccount.instagramId>`),
  which is what the DM worker and the trigger engine pass to `reserveDMSlot`.
- **Redis outages** are time-boxed (2–2.5s) and shown as "Noma'lum"; a failed
  diagnostics source turns its row into `unknown`, never a 500.
- **Raw Meta text** (`OAuthException #190`) only appears in `technical`, shown
  under "Texnik ma'lumot".

## Extending

- New error: add an entry to `ERROR_CATALOG` and a match (code in `classify`,
  or a stored-string pattern in `TEXT_RULES`), plus a test.
- New diagnostics row: write a pure `buildXCheck(input, now)`, load its input
  in `runDiagnostics` via `settle(...)`, add tests for each branch.
