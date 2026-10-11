-- CreateEnum
CREATE TYPE "InstagramEventType" AS ENUM ('STORY_REPLY', 'STORY_MENTION', 'DIRECT_MESSAGE', 'LIVE_COMMENT', 'STORY_REACTION', 'COMMENT');

-- CreateEnum
CREATE TYPE "InstagramEventStatus" AS ENUM ('PENDING', 'PROCESSING', 'PROCESSED', 'IGNORED', 'RETRYING', 'FAILED');

-- CreateEnum
CREATE TYPE "TriggerStoryScope" AS ENUM ('ALL', 'SPECIFIC');

-- CreateEnum
CREATE TYPE "TriggerMatchMode" AS ENUM ('EVERY', 'CONTAINS', 'EXACT');

-- CreateEnum
CREATE TYPE "TriggerResponseType" AS ENUM ('SEND_MESSAGE');

-- CreateEnum
CREATE TYPE "TriggerExecutionStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'RETRYING', 'FAILED', 'SKIPPED');

-- CreateEnum
CREATE TYPE "TriggerMessageDirection" AS ENUM ('INBOUND', 'OUTBOUND');

-- CreateTable
CREATE TABLE "InstagramEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "eventType" "InstagramEventType" NOT NULL,
    "senderId" TEXT NOT NULL,
    "senderUsername" TEXT,
    "messageId" TEXT NOT NULL,
    "storyId" TEXT,
    "storyUrl" TEXT,
    "mediaId" TEXT,
    "text" TEXT NOT NULL DEFAULT '',
    "timestamp" TIMESTAMP(3) NOT NULL,
    "rawPayload" JSONB NOT NULL,
    "processingStatus" "InstagramEventStatus" NOT NULL DEFAULT 'PENDING',
    "error" TEXT,
    "errorDetail" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "processingStartedAt" TIMESTAMP(3),
    "processedAt" TIMESTAMP(3),
    "contactId" TEXT,
    "conversationId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstagramEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriggerCampaign" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "triggerType" "InstagramEventType" NOT NULL,
    "storyScope" "TriggerStoryScope" NOT NULL DEFAULT 'ALL',
    "storyIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "matchingMode" "TriggerMatchMode" NOT NULL DEFAULT 'EVERY',
    "responseType" "TriggerResponseType" NOT NULL DEFAULT 'SEND_MESSAGE',
    "responseMessage" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TriggerCampaign_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriggerExecution" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "campaignId" TEXT NOT NULL,
    "status" "TriggerExecutionStatus" NOT NULL DEFAULT 'PENDING',
    "matchedKeyword" TEXT,
    "responseText" TEXT NOT NULL,
    "sentMessageId" TEXT,
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "errorDetail" TEXT,
    "nextRetryAt" TIMESTAMP(3),
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TriggerExecution_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "InstagramContact" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "igUserId" TEXT NOT NULL,
    "username" TEXT,
    "name" TEXT,
    "source" "InstagramEventType" NOT NULL,
    "firstInteractionAt" TIMESTAMP(3) NOT NULL,
    "lastInteractionAt" TIMESTAMP(3) NOT NULL,
    "interactionCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "InstagramContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriggerConversation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "lastMessageAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TriggerConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TriggerMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "direction" "TriggerMessageDirection" NOT NULL,
    "eventType" "InstagramEventType",
    "text" TEXT NOT NULL,
    "mid" TEXT,
    "storyId" TEXT,
    "eventId" TEXT,
    "executionId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TriggerMessage_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "InstagramEvent_workspaceId_createdAt_idx" ON "InstagramEvent"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "InstagramEvent_workspaceId_eventType_createdAt_idx" ON "InstagramEvent"("workspaceId", "eventType", "createdAt");

-- CreateIndex
CREATE INDEX "InstagramEvent_processingStatus_updatedAt_idx" ON "InstagramEvent"("processingStatus", "updatedAt");

-- CreateIndex
CREATE UNIQUE INDEX "InstagramEvent_instagramAccountId_messageId_key" ON "InstagramEvent"("instagramAccountId", "messageId");

-- CreateIndex
CREATE INDEX "TriggerCampaign_workspaceId_idx" ON "TriggerCampaign"("workspaceId");

-- CreateIndex
CREATE INDEX "TriggerCampaign_instagramAccountId_triggerType_active_idx" ON "TriggerCampaign"("instagramAccountId", "triggerType", "active");

-- CreateIndex
CREATE INDEX "TriggerExecution_workspaceId_createdAt_idx" ON "TriggerExecution"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "TriggerExecution_campaignId_createdAt_idx" ON "TriggerExecution"("campaignId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TriggerExecution_eventId_campaignId_key" ON "TriggerExecution"("eventId", "campaignId");

-- CreateIndex
CREATE INDEX "InstagramContact_workspaceId_lastInteractionAt_idx" ON "InstagramContact"("workspaceId", "lastInteractionAt");

-- CreateIndex
CREATE UNIQUE INDEX "InstagramContact_instagramAccountId_igUserId_key" ON "InstagramContact"("instagramAccountId", "igUserId");

-- CreateIndex
CREATE UNIQUE INDEX "TriggerConversation_contactId_key" ON "TriggerConversation"("contactId");

-- CreateIndex
CREATE INDEX "TriggerConversation_workspaceId_lastMessageAt_idx" ON "TriggerConversation"("workspaceId", "lastMessageAt");

-- CreateIndex
CREATE INDEX "TriggerMessage_conversationId_createdAt_idx" ON "TriggerMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "TriggerMessage_conversationId_mid_key" ON "TriggerMessage"("conversationId", "mid");

-- AddForeignKey
ALTER TABLE "InstagramEvent" ADD CONSTRAINT "InstagramEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstagramEvent" ADD CONSTRAINT "InstagramEvent_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstagramEvent" ADD CONSTRAINT "InstagramEvent_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "InstagramContact"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerCampaign" ADD CONSTRAINT "TriggerCampaign_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerCampaign" ADD CONSTRAINT "TriggerCampaign_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerExecution" ADD CONSTRAINT "TriggerExecution_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerExecution" ADD CONSTRAINT "TriggerExecution_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "InstagramEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerExecution" ADD CONSTRAINT "TriggerExecution_campaignId_fkey" FOREIGN KEY ("campaignId") REFERENCES "TriggerCampaign"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstagramContact" ADD CONSTRAINT "InstagramContact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "InstagramContact" ADD CONSTRAINT "InstagramContact_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerConversation" ADD CONSTRAINT "TriggerConversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerConversation" ADD CONSTRAINT "TriggerConversation_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerConversation" ADD CONSTRAINT "TriggerConversation_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "InstagramContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TriggerMessage" ADD CONSTRAINT "TriggerMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "TriggerConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

