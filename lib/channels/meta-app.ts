/**
 * The Meta app behind Facebook Pages, Threads-adjacent login and Ads.
 *
 * FACEBOOK_APP_* belongs to the Instagram app: its secret signs /api/webhook.
 * Pages, Messenger and ads live in a separate Meta app, so its id and secret
 * come from FACEBOOK_CHANNELS_APP_*. When those are unset we fall back to
 * FACEBOOK_APP_*, which keeps a single-app setup working.
 */
export function facebookChannelsApp(env: Record<string, string | undefined> = process.env): { appId: string; secret: string } {
  return {
    appId: (env.FACEBOOK_CHANNELS_APP_ID || env.FACEBOOK_APP_ID || "").trim(),
    secret: (env.FACEBOOK_CHANNELS_APP_SECRET || env.FACEBOOK_APP_SECRET || "").trim(),
  };
}
