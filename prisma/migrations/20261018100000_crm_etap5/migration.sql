-- ETAP 5 CRM (developer area). Additive only: three WorkspaceRole values, new
-- enums and tables, one index on Conversation. Production columns untouched.

-- CreateEnum
CREATE TYPE "CrmContactStatus" AS ENUM ('NEW', 'ACTIVE', 'CUSTOMER', 'LOST', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "CrmContactSource" AS ENUM ('COMMENT', 'STORY', 'DM', 'AD', 'LINK', 'BROADCAST', 'IMPORT', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "CrmTagOrigin" AS ENUM ('MANUAL', 'AI', 'AUTOMATION', 'SYSTEM');

-- CreateEnum
CREATE TYPE "CrmStageKind" AS ENUM ('OPEN', 'WON', 'LOST');

-- CreateEnum
CREATE TYPE "CrmAssignmentStrategy" AS ENUM ('ROUND_ROBIN', 'TEAM', 'SPECIALIST');

-- CreateEnum
CREATE TYPE "CrmAssignmentTrigger" AS ENUM ('ON_HOT', 'ON_LEAD', 'ON_HANDOFF', 'ON_STAGE', 'MANUAL');

-- CreateEnum
CREATE TYPE "CrmActivityType" AS ENUM ('INBOUND_MESSAGE', 'AUTOMATION_REPLY', 'AI_REPLY', 'OPERATOR_REPLY', 'FOLLOW_UP_SENT', 'LEAD_CREATED', 'LEAD_DELIVERED', 'SCORE_CHANGED', 'TEMPERATURE_CHANGED', 'HANDOFF_OPENED', 'HANDOFF_ACCEPTED', 'HANDOFF_CLOSED', 'TAG_ADDED', 'TAG_REMOVED', 'STAGE_CHANGED', 'DEAL_CREATED', 'ASSIGNED', 'UNASSIGNED', 'FIELD_CHANGED', 'NOTE', 'BROADCAST_SENT', 'BROADCAST_SKIPPED', 'BROADCAST_REPLIED', 'BROADCAST_CONVERTED', 'OPT_OUT');

-- CreateEnum
CREATE TYPE "CrmActorKind" AS ENUM ('SYSTEM', 'AI', 'AUTOMATION', 'OPERATOR');

-- CreateEnum
CREATE TYPE "CrmBroadcastStatus" AS ENUM ('DRAFT', 'SCHEDULED', 'RUNNING', 'PAUSED', 'COMPLETED', 'CANCELLED', 'FAILED');

-- CreateEnum
CREATE TYPE "CrmRecipientStatus" AS ENUM ('PENDING', 'SENDING', 'SENT', 'SKIPPED', 'FAILED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "WorkspaceRole" ADD VALUE 'MANAGER';
ALTER TYPE "WorkspaceRole" ADD VALUE 'OPERATOR';
ALTER TYPE "WorkspaceRole" ADD VALUE 'VIEWER';

-- CreateTable
CREATE TABLE "CrmContact" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "igUserId" TEXT NOT NULL,
    "username" TEXT,
    "name" TEXT,
    "phoneE164" TEXT,
    "email" TEXT,
    "language" TEXT,
    "source" "CrmContactSource" NOT NULL DEFAULT 'UNKNOWN',
    "status" "CrmContactStatus" NOT NULL DEFAULT 'NEW',
    "score" INTEGER NOT NULL DEFAULT 0,
    "temperature" "AiTemperature" NOT NULL DEFAULT 'COLD',
    "hasAiState" BOOLEAN NOT NULL DEFAULT false,
    "firstInteractionAt" TIMESTAMP(3),
    "lastInteractionAt" TIMESTAMP(3),
    "lastInboundAt" TIMESTAMP(3),
    "lastOutboundAt" TIMESTAMP(3),
    "interactionCount" INTEGER NOT NULL DEFAULT 0,
    "assignedMemberId" TEXT,
    "assignedAt" TIMESTAMP(3),
    "conversationId" TEXT,
    "instagramContactId" TEXT,
    "optedOutAt" TIMESTAMP(3),
    "optOutReason" TEXT,
    "mergedIntoId" TEXT,
    "customFields" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmContact_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmTag" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "color" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmContactTag" (
    "id" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "tagId" TEXT NOT NULL,
    "origin" "CrmTagOrigin" NOT NULL,
    "sourceRef" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmContactTag_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmSegment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "filter" JSONB NOT NULL,
    "lastCount" INTEGER,
    "lastCountedAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmSegment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmPipeline" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmPipeline_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmStage" (
    "id" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "sort" INTEGER NOT NULL,
    "kind" "CrmStageKind" NOT NULL DEFAULT 'OPEN',
    "color" TEXT,
    "isEntry" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmStage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmDeal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "pipelineId" TEXT NOT NULL,
    "stageId" TEXT NOT NULL,
    "leadId" TEXT,
    "title" TEXT NOT NULL,
    "stageEnteredAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "wonAt" TIMESTAMP(3),
    "lostAt" TIMESTAMP(3),
    "lostReason" TEXT,
    "assignedMemberId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmDeal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmAssignmentRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "trigger" "CrmAssignmentTrigger" NOT NULL,
    "stageId" TEXT,
    "strategy" "CrmAssignmentStrategy" NOT NULL,
    "memberIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "productKeywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "rrCursor" INTEGER NOT NULL DEFAULT 0,
    "onlyUnassigned" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmAssignmentRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmAssignment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "dealId" TEXT,
    "memberId" TEXT NOT NULL,
    "ruleId" TEXT,
    "reason" TEXT NOT NULL,
    "assignedByUserId" TEXT,
    "assignedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "unassignedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "CrmAssignment_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmActivity" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "dealId" TEXT,
    "type" "CrmActivityType" NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "actorKind" "CrmActorKind" NOT NULL,
    "actorMemberId" TEXT,
    "title" TEXT NOT NULL,
    "body" TEXT,
    "payload" JSONB,
    "sourceTable" TEXT,
    "sourceId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CrmActivity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmSyncCursor" (
    "source" TEXT NOT NULL,
    "cursorAt" TIMESTAMP(3) NOT NULL,
    "cursorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmSyncCursor_pkey" PRIMARY KEY ("source")
);

-- CreateTable
CREATE TABLE "CrmBroadcast" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "segmentId" TEXT,
    "audienceFilter" JSONB NOT NULL,
    "message" TEXT NOT NULL,
    "quickReplies" JSONB,
    "status" "CrmBroadcastStatus" NOT NULL DEFAULT 'DRAFT',
    "scheduledAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "throttlePerHour" INTEGER NOT NULL DEFAULT 100,
    "frequencyCapHours" INTEGER NOT NULL DEFAULT 24,
    "replyWindowHours" INTEGER NOT NULL DEFAULT 48,
    "conversionWindowDays" INTEGER NOT NULL DEFAULT 7,
    "totalCount" INTEGER NOT NULL DEFAULT 0,
    "eligibleCount" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "skippedCount" INTEGER NOT NULL DEFAULT 0,
    "failedCount" INTEGER NOT NULL DEFAULT 0,
    "repliedCount" INTEGER NOT NULL DEFAULT 0,
    "convertedCount" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "tickSeq" INTEGER NOT NULL DEFAULT 0,
    "nextTickAt" TIMESTAMP(3),
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmBroadcast_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CrmBroadcastRecipient" (
    "id" TEXT NOT NULL,
    "broadcastId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "eligible" BOOLEAN NOT NULL,
    "ineligibleReason" TEXT,
    "eligibilitySnapshot" JSONB NOT NULL,
    "status" "CrmRecipientStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "sentMessageId" TEXT,
    "sentAt" TIMESTAMP(3),
    "error" TEXT,
    "repliedAt" TIMESTAMP(3),
    "replyMessageId" TEXT,
    "convertedAt" TIMESTAMP(3),
    "conversionDealId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CrmBroadcastRecipient_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "CrmContact_conversationId_key" ON "CrmContact"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmContact_instagramContactId_key" ON "CrmContact"("instagramContactId");

-- CreateIndex
CREATE INDEX "CrmContact_workspaceId_lastInteractionAt_idx" ON "CrmContact"("workspaceId", "lastInteractionAt");

-- CreateIndex
CREATE INDEX "CrmContact_workspaceId_status_score_idx" ON "CrmContact"("workspaceId", "status", "score");

-- CreateIndex
CREATE INDEX "CrmContact_workspaceId_assignedMemberId_idx" ON "CrmContact"("workspaceId", "assignedMemberId");

-- CreateIndex
CREATE INDEX "CrmContact_workspaceId_phoneE164_idx" ON "CrmContact"("workspaceId", "phoneE164");

-- CreateIndex
CREATE INDEX "CrmContact_workspaceId_lastInboundAt_idx" ON "CrmContact"("workspaceId", "lastInboundAt");

-- CreateIndex
CREATE INDEX "CrmContact_workspaceId_temperature_idx" ON "CrmContact"("workspaceId", "temperature");

-- CreateIndex
CREATE UNIQUE INDEX "CrmContact_instagramAccountId_igUserId_key" ON "CrmContact"("instagramAccountId", "igUserId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmTag_workspaceId_slug_key" ON "CrmTag"("workspaceId", "slug");

-- CreateIndex
CREATE INDEX "CrmContactTag_tagId_idx" ON "CrmContactTag"("tagId");

-- CreateIndex
CREATE UNIQUE INDEX "CrmContactTag_contactId_tagId_key" ON "CrmContactTag"("contactId", "tagId");

-- CreateIndex
CREATE INDEX "CrmSegment_workspaceId_idx" ON "CrmSegment"("workspaceId");

-- CreateIndex
CREATE INDEX "CrmPipeline_workspaceId_isDefault_idx" ON "CrmPipeline"("workspaceId", "isDefault");

-- CreateIndex
CREATE UNIQUE INDEX "CrmPipeline_workspaceId_name_key" ON "CrmPipeline"("workspaceId", "name");

-- CreateIndex
CREATE INDEX "CrmStage_pipelineId_sort_idx" ON "CrmStage"("pipelineId", "sort");

-- CreateIndex
CREATE UNIQUE INDEX "CrmStage_pipelineId_name_key" ON "CrmStage"("pipelineId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "CrmDeal_leadId_key" ON "CrmDeal"("leadId");

-- CreateIndex
CREATE INDEX "CrmDeal_workspaceId_pipelineId_stageId_idx" ON "CrmDeal"("workspaceId", "pipelineId", "stageId");

-- CreateIndex
CREATE INDEX "CrmDeal_contactId_idx" ON "CrmDeal"("contactId");

-- CreateIndex
CREATE INDEX "CrmAssignmentRule_workspaceId_active_priority_idx" ON "CrmAssignmentRule"("workspaceId", "active", "priority");

-- CreateIndex
CREATE INDEX "CrmAssignment_contactId_active_idx" ON "CrmAssignment"("contactId", "active");

-- CreateIndex
CREATE INDEX "CrmAssignment_workspaceId_memberId_active_idx" ON "CrmAssignment"("workspaceId", "memberId", "active");

-- CreateIndex
CREATE INDEX "CrmActivity_contactId_occurredAt_idx" ON "CrmActivity"("contactId", "occurredAt");

-- CreateIndex
CREATE INDEX "CrmActivity_workspaceId_occurredAt_idx" ON "CrmActivity"("workspaceId", "occurredAt");

-- CreateIndex
CREATE INDEX "CrmActivity_workspaceId_type_occurredAt_idx" ON "CrmActivity"("workspaceId", "type", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmActivity_sourceTable_sourceId_type_key" ON "CrmActivity"("sourceTable", "sourceId", "type");

-- CreateIndex
CREATE INDEX "CrmBroadcast_workspaceId_status_idx" ON "CrmBroadcast"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "CrmBroadcast_status_scheduledAt_idx" ON "CrmBroadcast"("status", "scheduledAt");

-- CreateIndex
CREATE INDEX "CrmBroadcastRecipient_broadcastId_status_idx" ON "CrmBroadcastRecipient"("broadcastId", "status");

-- CreateIndex
CREATE INDEX "CrmBroadcastRecipient_contactId_sentAt_idx" ON "CrmBroadcastRecipient"("contactId", "sentAt");

-- CreateIndex
CREATE UNIQUE INDEX "CrmBroadcastRecipient_broadcastId_contactId_key" ON "CrmBroadcastRecipient"("broadcastId", "contactId");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_updatedAt_idx" ON "Conversation"("workspaceId", "updatedAt");

-- CreateIndex (reconciler keyset scans: (cursor column, id) per source, lib/crm/sync.ts)
CREATE INDEX "Conversation_updatedAt_id_idx" ON "Conversation"("updatedAt", "id");

-- CreateIndex
CREATE INDEX "InstagramEvent_createdAt_id_idx" ON "InstagramEvent"("createdAt", "id");

-- CreateIndex
CREATE INDEX "Lead_createdAt_id_idx" ON "Lead"("createdAt", "id");

-- CreateIndex
CREATE INDEX "TriggerExecution_updatedAt_id_idx" ON "TriggerExecution"("updatedAt", "id");

-- CreateIndex
CREATE INDEX "DmLog_createdAt_id_idx" ON "DmLog"("createdAt", "id");

-- CreateIndex
CREATE INDEX "AiConversationState_updatedAt_id_idx" ON "AiConversationState"("updatedAt", "id");

-- CreateIndex
CREATE INDEX "AiHandoff_openedAt_id_idx" ON "AiHandoff"("openedAt", "id");

-- AddForeignKey
ALTER TABLE "CrmContact" ADD CONSTRAINT "CrmContact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmTag" ADD CONSTRAINT "CrmTag_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmContactTag" ADD CONSTRAINT "CrmContactTag_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CrmContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmContactTag" ADD CONSTRAINT "CrmContactTag_tagId_fkey" FOREIGN KEY ("tagId") REFERENCES "CrmTag"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmSegment" ADD CONSTRAINT "CrmSegment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmPipeline" ADD CONSTRAINT "CrmPipeline_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmStage" ADD CONSTRAINT "CrmStage_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "CrmPipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CrmContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_pipelineId_fkey" FOREIGN KEY ("pipelineId") REFERENCES "CrmPipeline"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmDeal" ADD CONSTRAINT "CrmDeal_stageId_fkey" FOREIGN KEY ("stageId") REFERENCES "CrmStage"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmAssignmentRule" ADD CONSTRAINT "CrmAssignmentRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmAssignment" ADD CONSTRAINT "CrmAssignment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmAssignment" ADD CONSTRAINT "CrmAssignment_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CrmContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmAssignment" ADD CONSTRAINT "CrmAssignment_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "CrmAssignmentRule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmActivity" ADD CONSTRAINT "CrmActivity_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CrmContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmBroadcast" ADD CONSTRAINT "CrmBroadcast_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmBroadcast" ADD CONSTRAINT "CrmBroadcast_segmentId_fkey" FOREIGN KEY ("segmentId") REFERENCES "CrmSegment"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmBroadcastRecipient" ADD CONSTRAINT "CrmBroadcastRecipient_broadcastId_fkey" FOREIGN KEY ("broadcastId") REFERENCES "CrmBroadcast"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CrmBroadcastRecipient" ADD CONSTRAINT "CrmBroadcastRecipient_contactId_fkey" FOREIGN KEY ("contactId") REFERENCES "CrmContact"("id") ON DELETE CASCADE ON UPDATE CASCADE;

