-- CreateEnum
CREATE TYPE "PostType" AS ENUM ('FEED_IMAGE', 'FEED_VIDEO', 'CAROUSEL', 'REEL', 'TRIAL_REEL', 'STORY');

-- CreateEnum
CREATE TYPE "PostStatus" AS ENUM ('DRAFT', 'PENDING_REVIEW', 'SCHEDULED', 'PAUSED', 'PREPARING', 'READY_TO_PUBLISH', 'PUBLISHING', 'PUBLISHED', 'NEEDS_MANUAL', 'PUBLISHED_MANUAL', 'FAILED', 'REJECTED', 'EXPIRED_REVIEW', 'CANCELED');

-- CreateEnum
CREATE TYPE "MediaStatus" AS ENUM ('UPLOADING', 'PROCESSING', 'READY', 'FAILED', 'DELETED');

-- CreateEnum
CREATE TYPE "ReviewRule" AS ENUM ('ANY', 'ALL', 'OPTIONAL');

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "scheduledPostId" TEXT;

-- AlterTable
ALTER TABLE "InstagramAccount" ADD COLUMN     "accountType" TEXT,
ADD COLUMN     "canPublish" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "grantedScopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "publishQuotaCheckedAt" TIMESTAMP(3),
ADD COLUMN     "publishQuotaUsed" INTEGER;

-- AlterTable
ALTER TABLE "TriggerCampaign" ADD COLUMN     "scheduledPostId" TEXT;

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "mediaStorageBytes" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN     "timezone" TEXT NOT NULL DEFAULT 'Asia/Tashkent';

-- CreateTable
CREATE TABLE "MediaAsset" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "uploadedById" TEXT,
    "kind" TEXT NOT NULL,
    "originalKey" TEXT NOT NULL,
    "preparedKey" TEXT,
    "thumbKey" TEXT,
    "mimeType" TEXT NOT NULL,
    "sizeBytes" BIGINT NOT NULL,
    "width" INTEGER,
    "height" INTEGER,
    "durationMs" INTEGER,
    "codec" TEXT,
    "fps" DOUBLE PRECISION,
    "status" "MediaStatus" NOT NULL DEFAULT 'UPLOADING',
    "error" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MediaAsset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledPost" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "createdById" TEXT,
    "type" "PostType" NOT NULL,
    "status" "PostStatus" NOT NULL DEFAULT 'DRAFT',
    "caption" TEXT,
    "firstComment" TEXT,
    "collaborators" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "shareToFeed" BOOLEAN NOT NULL DEFAULT true,
    "coverMediaId" TEXT,
    "thumbOffsetMs" INTEGER,
    "trialStrategy" TEXT,
    "audioName" TEXT,
    "locationId" TEXT,
    "isAiGenerated" BOOLEAN NOT NULL DEFAULT false,
    "autoPublish" BOOLEAN NOT NULL DEFAULT true,
    "manualReason" TEXT,
    "scheduledAt" TIMESTAMP(3),
    "timezone" TEXT NOT NULL DEFAULT 'Asia/Tashkent',
    "seriesId" TEXT,
    "seriesIndex" INTEGER,
    "containerId" TEXT,
    "containerStatus" TEXT,
    "containerCreatedAt" TIMESTAMP(3),
    "igMediaId" TEXT,
    "permalink" TEXT,
    "publishedAt" TIMESTAMP(3),
    "firstCommentId" TEXT,
    "firstCommentStatus" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastErrorCode" TEXT,
    "lastErrorMessage" TEXT,
    "reviewRule" "ReviewRule",
    "reviewSubmittedAt" TIMESTAMP(3),
    "labels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "deletedAt" TIMESTAMP(3),

    CONSTRAINT "ScheduledPost_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ScheduledPostMedia" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "mediaId" TEXT NOT NULL,
    "position" INTEGER NOT NULL,
    "altText" TEXT,
    "userTags" JSONB NOT NULL DEFAULT '[]',
    "cropRect" JSONB,
    "containerId" TEXT,

    CONSTRAINT "ScheduledPostMedia_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PublishAttempt" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "step" TEXT NOT NULL,
    "ok" BOOLEAN NOT NULL,
    "metaCode" INTEGER,
    "metaSubcode" INTEGER,
    "fbTraceId" TEXT,
    "message" TEXT,
    "durationMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PublishAttempt_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostReview" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "reviewerUserId" TEXT,
    "externalEmail" TEXT,
    "tokenHash" TEXT,
    "decision" TEXT,
    "comment" TEXT,
    "postVersion" INTEGER NOT NULL,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostReview_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostNote" (
    "id" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "authorId" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "PostNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SavedText" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SavedText_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "PostingSlot" (
    "id" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "weekday" INTEGER NOT NULL,
    "minuteOfDay" INTEGER NOT NULL,
    "postType" "PostType",

    CONSTRAINT "PostingSlot_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MediaAsset_workspaceId_createdAt_idx" ON "MediaAsset"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledPost_igMediaId_key" ON "ScheduledPost"("igMediaId");

-- CreateIndex
CREATE INDEX "ScheduledPost_status_scheduledAt_idx" ON "ScheduledPost"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "ScheduledPost_workspaceId_scheduledAt_idx" ON "ScheduledPost"("workspaceId", "scheduledAt");

-- CreateIndex
CREATE INDEX "ScheduledPost_instagramAccountId_scheduledAt_idx" ON "ScheduledPost"("instagramAccountId", "scheduledAt");

-- CreateIndex
CREATE INDEX "ScheduledPostMedia_mediaId_idx" ON "ScheduledPostMedia"("mediaId");

-- CreateIndex
CREATE UNIQUE INDEX "ScheduledPostMedia_postId_position_key" ON "ScheduledPostMedia"("postId", "position");

-- CreateIndex
CREATE INDEX "PublishAttempt_postId_createdAt_idx" ON "PublishAttempt"("postId", "createdAt");

-- CreateIndex
CREATE INDEX "PostReview_postId_idx" ON "PostReview"("postId");

-- CreateIndex
CREATE INDEX "PostNote_postId_idx" ON "PostNote"("postId");

-- CreateIndex
CREATE INDEX "SavedText_workspaceId_idx" ON "SavedText"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "PostingSlot_instagramAccountId_weekday_minuteOfDay_key" ON "PostingSlot"("instagramAccountId", "weekday", "minuteOfDay");

-- AddForeignKey
ALTER TABLE "Automation" ADD CONSTRAINT "Automation_scheduledPostId_fkey" FOREIGN KEY ("scheduledPostId") REFERENCES "ScheduledPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerCampaign" ADD CONSTRAINT "TriggerCampaign_scheduledPostId_fkey" FOREIGN KEY ("scheduledPostId") REFERENCES "ScheduledPost"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MediaAsset" ADD CONSTRAINT "MediaAsset_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledPost" ADD CONSTRAINT "ScheduledPost_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledPost" ADD CONSTRAINT "ScheduledPost_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledPostMedia" ADD CONSTRAINT "ScheduledPostMedia_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ScheduledPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ScheduledPostMedia" ADD CONSTRAINT "ScheduledPostMedia_mediaId_fkey" FOREIGN KEY ("mediaId") REFERENCES "MediaAsset"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PublishAttempt" ADD CONSTRAINT "PublishAttempt_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ScheduledPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostReview" ADD CONSTRAINT "PostReview_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ScheduledPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostNote" ADD CONSTRAINT "PostNote_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ScheduledPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SavedText" ADD CONSTRAINT "SavedText_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "PostingSlot" ADD CONSTRAINT "PostingSlot_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

