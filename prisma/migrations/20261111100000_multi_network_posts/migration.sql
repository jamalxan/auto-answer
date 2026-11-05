-- Network-only posts: a post may go to Facebook / Threads / YouTube without an Instagram account.
ALTER TABLE "ScheduledPost" ALTER COLUMN "instagramAccountId" DROP NOT NULL;
