-- Network-only posts: a post may go to Facebook / Threads / YouTube without an Instagram account.
ALTER TABLE "ScheduledPost" ALTER COLUMN "instagramAccountId" DROP NOT NULL;

-- "Har biriga alohida": a target's own text and time.
ALTER TABLE "ChannelPostTarget" ADD COLUMN "captionOverride" TEXT;
ALTER TABLE "ChannelPostTarget" ADD COLUMN "scheduledAtOverride" TIMESTAMP(3);
