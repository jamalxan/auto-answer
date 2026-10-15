-- Comment Automation 2.0 (developer area, ETAP 2). Additive only: new enums,
-- new tables and nullable/defaulted columns on the trigger engine tables.

-- CreateEnum
CREATE TYPE "TriggerMediaScope" AS ENUM ('ANY', 'SPECIFIC');

-- CreateEnum
CREATE TYPE "TriggerReplyMode" AS ENUM ('RANDOM', 'SEQUENTIAL', 'WEIGHTED');

-- CreateEnum
CREATE TYPE "TriggerVariantKind" AS ENUM ('DM', 'PUBLIC');

-- CreateEnum
CREATE TYPE "TriggerVariantSource" AS ENUM ('MANUAL', 'AI');

-- CreateEnum
CREATE TYPE "TriggerQuickReplyAction" AS ENUM ('MESSAGE', 'LEAD_CAPTURE', 'HANDOFF');

-- CreateEnum
CREATE TYPE "TriggerFollowUpCondition" AS ENUM ('ALWAYS', 'NO_REPLY', 'NO_CLICK');

-- CreateEnum
CREATE TYPE "TriggerFollowUpStatus" AS ENUM ('SCHEDULED', 'SENDING', 'SENT', 'SKIPPED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "TriggerSideStatus" AS ENUM ('SENT', 'FAILED');

-- CreateEnum
CREATE TYPE "TriggerBacktrackStatus" AS ENUM ('RUNNING', 'DONE', 'FAILED');

-- AlterTable
ALTER TABLE "InstagramEvent" ADD COLUMN     "backtrackRunId" TEXT,
ADD COLUMN     "payload" TEXT;

-- AlterTable
ALTER TABLE "TriggerCampaign" ADD COLUMN     "intents" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "mainMessage" TEXT,
ADD COLUMN     "mediaIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "mediaScope" "TriggerMediaScope" NOT NULL DEFAULT 'ANY',
ADD COLUMN     "openingButtonLabel" TEXT,
ADD COLUMN     "priority" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "publicReplyEnabled" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN     "replyMode" "TriggerReplyMode" NOT NULL DEFAULT 'RANDOM',
ADD COLUMN     "sequenceCursor" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "stopOnHandoff" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "stopOnLead" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "stopOnReply" BOOLEAN NOT NULL DEFAULT true;

-- AlterTable
ALTER TABLE "TriggerExecution" ADD COLUMN     "handedOffAt" TIMESTAMP(3),
ADD COLUMN     "lastInboundAt" TIMESTAMP(3),
ADD COLUMN     "leadCapturedAt" TIMESTAMP(3),
ADD COLUMN     "openedAt" TIMESTAMP(3),
ADD COLUMN     "publicReplyError" TEXT,
ADD COLUMN     "publicReplyStatus" "TriggerSideStatus",
ADD COLUMN     "stopReason" TEXT,
ADD COLUMN     "stoppedAt" TIMESTAMP(3),
ADD COLUMN     "variantId" TEXT;

-- AlterTable
ALTER TABLE "InstagramContact" ADD COLUMN     "email" TEXT,
ADD COLUMN     "phone" TEXT;

-- CreateTable
CREATE TABLE "TriggerReplyVariant" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "kind" "TriggerVariantKind" NOT NULL,
    "text" TEXT NOT NULL,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "source" "TriggerVariantSource" NOT NULL DEFAULT 'MANUAL',
    "approvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TriggerReplyVariant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriggerQuickReply" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "label" TEXT NOT NULL,
    "action" "TriggerQuickReplyAction" NOT NULL,
    "responseText" TEXT,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TriggerQuickReply_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriggerFollowUpStep" (
    "id" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "delayMinutes" INTEGER NOT NULL,
    "condition" "TriggerFollowUpCondition" NOT NULL DEFAULT 'ALWAYS',
    "message" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TriggerFollowUpStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriggerFollowUpRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "executionId" TEXT NOT NULL,
    "stepId" TEXT NOT NULL,
    "status" "TriggerFollowUpStatus" NOT NULL DEFAULT 'SCHEDULED',
    "scheduledAt" TIMESTAMP(3) NOT NULL,
    "sentAt" TIMESTAMP(3),
    "reason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TriggerFollowUpRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriggerBacktrackRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "days" INTEGER NOT NULL,
    "status" "TriggerBacktrackStatus" NOT NULL DEFAULT 'RUNNING',
    "scanned" INTEGER NOT NULL DEFAULT 0,
    "queued" INTEGER NOT NULL DEFAULT 0,
    "skippedDuplicate" INTEGER NOT NULL DEFAULT 0,
    "skippedNoMatch" INTEGER NOT NULL DEFAULT 0,
    "skippedExpired" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "TriggerBacktrackRun_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "TriggerReplyVariant_campaignId_kind_sort_idx" ON "TriggerReplyVariant"("campaignId", "kind", "sort");

-- CreateIndex
CREATE INDEX "TriggerQuickReply_campaignId_sort_idx" ON "TriggerQuickReply"("campaignId", "sort");

-- CreateIndex
CREATE INDEX "TriggerFollowUpStep_campaignId_sort_idx" ON "TriggerFollowUpStep"("campaignId", "sort");

-- CreateIndex
CREATE INDEX "TriggerFollowUpRun_status_scheduledAt_idx" ON "TriggerFollowUpRun"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "TriggerFollowUpRun_workspaceId_createdAt_idx" ON "TriggerFollowUpRun"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TriggerFollowUpRun_executionId_stepId_key" ON "TriggerFollowUpRun"("executionId", "stepId");

-- CreateIndex
CREATE INDEX "TriggerBacktrackRun_campaignId_startedAt_idx" ON "TriggerBacktrackRun"("campaignId", "startedAt");

-- CreateIndex
-- Comment 2.0 checks "did production already answer this comment?" by commentId.
CREATE INDEX "DmLog_commentId_idx" ON "DmLog"("commentId");

-- AddForeignKey
ALTER TABLE "InstagramEvent" ADD CONSTRAINT "InstagramEvent_backtrackRunId_fkey" FOREIGN KEY ("backtrackRunId") REFERENCES "TriggerBacktrackRun"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerExecution" ADD CONSTRAINT "TriggerExecution_variantId_fkey" FOREIGN KEY ("variantId") REFERENCES "TriggerReplyVariant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerReplyVariant" ADD CONSTRAINT "TriggerReplyVariant_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TriggerCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerQuickReply" ADD CONSTRAINT "TriggerQuickReply_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TriggerCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerFollowUpStep" ADD CONSTRAINT "TriggerFollowUpStep_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TriggerCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerFollowUpRun" ADD CONSTRAINT "TriggerFollowUpRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerFollowUpRun" ADD CONSTRAINT "TriggerFollowUpRun_executionId_fkey" FOREIGN KEY ("executionId") REFERENCES "TriggerExecution"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerFollowUpRun" ADD CONSTRAINT "TriggerFollowUpRun_stepId_fkey" FOREIGN KEY ("stepId") REFERENCES "TriggerFollowUpStep"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerBacktrackRun" ADD CONSTRAINT "TriggerBacktrackRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerBacktrackRun" ADD CONSTRAINT "TriggerBacktrackRun_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TriggerCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

