# Security policy

SocialAuto handles Instagram access tokens, webhook payloads, and campaign
data. Report security issues responsibly, privately, and directly to the
repository owner rather than in a public issue.

## Sensitive areas

The parts most worth scrutiny:

- Instagram OAuth state verification
- Encrypted Instagram access tokens
- Meta webhook signature verification
- Workspace isolation
- Public report pages
- Tracked link redirects
- Worker retry and dedupe behavior
- Environment variable handling

## Secrets

Never commit any of these, and rotate one if it is exposed anywhere it could
be logged:

- `DATABASE_URL`, `REDIS_URL`
- `NEXTAUTH_SECRET`, `CRON_SECRET`, `ENCRYPTION_KEY`
- `RESEND_API_KEY`
- `INSTAGRAM_APP_SECRET`, `FACEBOOK_APP_SECRET`
- Live webhook payloads that contain user data
