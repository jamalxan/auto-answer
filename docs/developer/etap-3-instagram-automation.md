# ETAP 3 — Full Instagram Automation (developer area)

Master TZ: sections 14–18 and 63 (ETAP 3). Built on the trigger engine
(`lib/triggers`) and the Comment 2.0 building blocks (variants, quick replies,
follow-ups, claims). The customer product is not touched.

## Trigger types

| TZ | Trigger | Webhook | First reply | Window |
|---|---|---|---|---|
| 15 | **Direct** | `messages` (text) | normal DM | open — the person just wrote |
| 16 | **Story Reply** | `messages` + `reply_to.story` | V1 (existing, unchanged) | open |
| 16 | **Story Mention** | `messages` + attachment `story_mention` | normal DM | open |
| 16 | **Story Reaction** | `message_reactions` | — (observation mode) | — |
| 17 | **Live comment** | `live_comments` | private reply, only while live | opens on reply / tap |
| 18 | **Ad message** (click-to-Direct) | `messages` + `referral.source = ADS` | normal DM | open |
| 18 | **Ad comment** | `comments` + `media.original_media_id` | Comment 2.0 (already in ETAP 2) | — |
| 18 | **ig.me link** | `messages` / `messaging_referral` + `referral.ref` | normal DM | open |

DM-side triggers (Direct, Story Mention, Ad message, link) answer inside the
window the person opened, so there is no opening button: the reply goes out
with the quick replies straight away and follow-ups are scheduled from it.
Live comments behave like post comments (one private reply, optional opening
button), minus backtrack and public replies, and with no long retries — the
private reply is only allowed while the broadcast runs.

## Meta rules (checked 2026-10-15)

- Story mentions arrive as an inbox message (attachment `story_mention`, CDN
  url). They only arrive from public accounts, or private accounts that follow
  the business. The story media must not be stored — only its url as a
  reference (we store the url only).
- Live comments: a private reply is possible **only during the broadcast**;
  one per commenter. After the live ends the send fails — treated as final.
- Reactions: the `message_reactions` event carries the reacted message `mid`,
  `action` (react / unreact), `reaction`, `emoji`. Meta does not document
  whether a reaction **to a story** arrives this way. → Observation mode: the
  engine stores every reaction (as `MESSAGE_REACTION`, status IGNORED, reason
  "kuzatuv rejimi"), so a real story reaction can be inspected in the logs
  before any automation is switched on. No reply is sent.
- Click-to-Direct ads: `message.referral` with `source: "ADS"`, `type:
  "OPEN_THREAD"`, `ad_id`, `ads_context_data` (ad_title, photo_url /
  video_url). ig.me links (`https://ig.me/m/<username>?ref=<ref>`):
  `referral.ref`, `source: "SHORTLINKS"`, `type: "OPEN_THREAD"`. For a new
  conversation the ref is only delivered when the account has Icebreakers
  set; ig.me links do not work on Instagram Web (mobile app only).

Sources: developers.facebook.com — Instagram Platform webhook examples,
Private Replies, Story Mention, Using ig.me Links.

## Direct trigger conditions (TZ 15)

| TZ | Implementation |
|---|---|
| new DM, keyword, message contains | matching modes EVERY / CONTAINS / EXACT + intents (Comment 2.0 normaliser) |
| first-time user | audience NEW_CONTACT (first interaction with this account) |
| returning user | audience RETURNING_CONTACT |
| conversation reopen | audience REOPENED: last message from the person older than `reopenAfterHours` |
| button click | quick-reply taps (ETAP 2) |
| AI intent | built-in intents (dictionary, not an LLM — named honestly in the UI) |
| operator assignment | CRM, ETAP 5 — not offered yet |

Anti-spam: `cooldownHours` — one campaign answers the same person at most once
per cooldown (default 24h), whatever the matching mode.

## Overlap with production

Production has no handler for mentions, live comments, referrals or
reactions. Text DMs, however, also reach the DM-keyword campaigns and the
lead assistant. Whether a Direct / Story Mention / Ad campaign answers a DM is
decided once, in the webhook, before those paths run, and stored on the event
(`InstagramEvent.claimedCampaignId`, under a per-person Postgres advisory
lock). Production skips exactly the claimed events; the worker answers exactly
those, with that campaign, and never re-decides — so the person gets one
answer, never two and never none (except when the claimed campaign is switched
off in the seconds before the worker runs: logged as a warning). Details:
`lib/triggers/README.md`.

## Not in this stage

- Story Reaction replies — until a real payload confirms the shape.
- Operator-assignment trigger (ETAP 5), FLOW / AI quick-reply actions
  (ETAP 6 / ETAP 4).
- Migrating Story Reply V1 onto the new builder — it keeps working as is.
