# Meta App Review notes

You only need App Review if you want people who are not testers on your app to connect their own Instagram accounts.

SocialAuto uses the official Instagram API to send a private reply to someone who comments on a connected professional account's post or reel.

## Permissions to request

- `instagram_business_basic`
- `instagram_business_manage_comments`
- `instagram_business_manage_messages`
- `instagram_business_content_publish` (Content Scheduler)

## Permission justifications

Paste these into the App Review request, adjusted to your wording.

`instagram_business_basic`. We use this to identify the connected Instagram professional account after the user authorizes through Instagram business login, so we can associate the account with their workspace and show which account each automation belongs to.

`instagram_business_manage_comments`. When a follower comments a keyword the account owner configured on the owner's own post or reel, we receive the comment through the comments webhook and, if the owner enabled it, post a public reply under that comment. We only act on comments on the connecting account's own media.

`instagram_business_manage_messages`. After a follower comments a configured keyword, we send that follower a one-time private reply with content the account owner set up, typically a link or answer the follower asked for by commenting. This is the standard Instagram comment-to-DM flow. We send one reply per matching comment and respect Meta's rate limits.

`instagram_business_content_publish`. Business owners schedule feed posts, carousels, Reels and Stories for their own Instagram professional account in advance. We create the media container and publish it only at the time the user chose and only with content the user uploaded and wrote; nothing is published without an explicit schedule set by the user. We read `content_publishing_limit` to stay inside Meta's 24-hour quota, and we never edit or delete published media.

## Screencast script

Record on your published app, real accounts, one take, about two to three minutes. Narrate each step.

1. Sign in with an email magic link.
2. Go to Settings and click Connect Instagram. Show the consent screen with the permissions being granted.
3. Create a campaign on a recent post with keyword `LINK`, a DM message, and save.
4. On a second phone or account, comment `LINK` on that post.
5. Show the second account receiving the DM, and the public reply appearing under the comment.
6. Back in the app, show the DM Logs page with the SENT row.
7. (Content Scheduler) Open Content → "+ Post yaratish", upload an image, write the caption, pick a time a few minutes ahead and click "Rejalashtirish". Show the SCHEDULED card in the calendar.
8. When the time comes, show the post appearing on the Instagram profile and the calendar card turning to "Chiqdi" with the permalink.
9. Show the post detail with the publish attempts list, and the linked comment-to-DM campaign now active on that post.

Reviewers want to see the permission produce a real result for a real user. This flow does that directly.

## Compliance positioning

- The app never scrapes Instagram and never asks for a password.
- It only sends a reply when someone comments on the connected account's own content.
- Tokens are encrypted at rest with AES-256-GCM.
- Users can disconnect Instagram from Settings.
- Publishing happens only at a time the user scheduled, with media the user uploaded; media is stored in a private bucket and handed to Meta through short-lived signed URLs. Story stickers, links and music are never faked: those posts are handed back to the user to publish manually.
- Per-account rate limiting and deduplication prevent spammy behavior.

## Business verification

Meta usually requires business verification before granting Advanced Access. It asks for a document proving a legal entity: a business registration or license, articles of incorporation, a business tax document, or a business bank statement. Without a registered business, this step cannot be completed, and the practical path is to keep running the connected Instagram accounts as testers, which never needs review.
