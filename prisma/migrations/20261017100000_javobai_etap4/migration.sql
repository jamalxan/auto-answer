-- ETAP 4 JavobAI (developer area). Additive only: new enums, new tables and
-- one new TriggerQuickReplyAction value. Production tables are not altered.

-- CreateEnum
CREATE TYPE "JavobAiMode" AS ENUM ('OFF', 'SHADOW', 'LIVE');

-- CreateEnum
CREATE TYPE "AiHandoffState" AS ENUM ('AI_ACTIVE', 'HANDOFF_PENDING', 'OPERATOR_ACTIVE', 'CLOSED');

-- CreateEnum
CREATE TYPE "AiTemperature" AS ENUM ('COLD', 'WARM', 'HOT', 'CUSTOMER', 'LOST');

-- CreateEnum
CREATE TYPE "AiHandoffStatus" AS ENUM ('OPEN', 'ACCEPTED', 'CLOSED');

-- CreateEnum
CREATE TYPE "AiHandoffRuleKind" AS ENUM ('KEYWORD', 'INTENT', 'SCORE', 'UNKNOWN_COUNT', 'OFF_HOURS');

-- CreateEnum
CREATE TYPE "AiKnowledgeKind" AS ENUM ('DISCOUNT', 'CONTACT', 'TERMS', 'BRANCH', 'POLICY', 'OTHER');

-- AlterEnum
ALTER TYPE "TriggerQuickReplyAction" ADD VALUE 'AI';

-- CreateTable
CREATE TABLE "JavobAiAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "mode" "JavobAiMode" NOT NULL DEFAULT 'OFF',
    "config" JSONB NOT NULL DEFAULT '{}',
    "enabledBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "JavobAiAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiConversationState" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "handoffState" "AiHandoffState" NOT NULL DEFAULT 'AI_ACTIVE',
    "score" INTEGER NOT NULL DEFAULT 0,
    "temperature" "AiTemperature" NOT NULL DEFAULT 'COLD',
    "summary" TEXT NOT NULL DEFAULT '',
    "summaryUpToMessageId" TEXT,
    "extracted" JSONB NOT NULL DEFAULT '{}',
    "context" JSONB NOT NULL DEFAULT '{}',
    "unknownStreak" INTEGER NOT NULL DEFAULT 0,
    "turns" INTEGER NOT NULL DEFAULT 0,
    "leadCycle" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiConversationState_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiScoreEvent" (
    "id" TEXT NOT NULL,
    "stateId" TEXT NOT NULL,
    "leadCycle" INTEGER NOT NULL,
    "signal" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "messageId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiScoreEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiScoringConfig" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT,
    "rules" JSONB NOT NULL,
    "thresholds" JSONB NOT NULL,
    "handoffAtScore" INTEGER,
    "lostAfterDays" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiScoringConfig_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiHandoff" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "reason" TEXT NOT NULL,
    "status" "AiHandoffStatus" NOT NULL DEFAULT 'OPEN',
    "openedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "acceptedAt" TIMESTAMP(3),
    "acceptedBy" TEXT,
    "closedAt" TIMESTAMP(3),
    "closedBy" TEXT,
    "resumeAi" BOOLEAN NOT NULL DEFAULT true,

    CONSTRAINT "AiHandoff_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiHandoffRule" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "kind" "AiHandoffRuleKind" NOT NULL,
    "value" JSONB NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiHandoffRule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiContactMemory" (
    "id" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "igUserId" TEXT NOT NULL,
    "facts" JSONB NOT NULL DEFAULT '{}',
    "lastSummary" TEXT NOT NULL DEFAULT '',
    "leadIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiContactMemory_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiKnowledgeEntry" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "kind" "AiKnowledgeKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "verifiedAt" TIMESTAMP(3),
    "active" BOOLEAN NOT NULL DEFAULT true,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiKnowledgeEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiLeadInsight" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "score" INTEGER NOT NULL,
    "temperature" "AiTemperature" NOT NULL,
    "email" TEXT,
    "budget" TEXT,
    "location" TEXT,
    "signals" JSONB NOT NULL DEFAULT '[]',
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiLeadInsight_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiShadowTurn" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT,
    "customerText" TEXT NOT NULL,
    "productionReply" TEXT,
    "aiReply" TEXT,
    "intent" TEXT,
    "confidence" DOUBLE PRECISION,
    "score" INTEGER,
    "handoff" TEXT,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AiShadowTurn_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiBudget" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "monthlyUsdSoft" DECIMAL(12,2) NOT NULL,
    "monthlyUsdHard" DECIMAL(12,2),
    "alerted50At" TIMESTAMP(3),
    "alerted80At" TIMESTAMP(3),
    "alerted100At" TIMESTAMP(3),
    "periodStart" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiBudget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "JavobAiAccount_instagramAccountId_key" ON "JavobAiAccount"("instagramAccountId");

-- CreateIndex
CREATE INDEX "JavobAiAccount_workspaceId_idx" ON "JavobAiAccount"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AiConversationState_conversationId_key" ON "AiConversationState"("conversationId");

-- CreateIndex
CREATE UNIQUE INDEX "AiScoreEvent_stateId_leadCycle_signal_key" ON "AiScoreEvent"("stateId", "leadCycle", "signal");

-- CreateIndex
CREATE UNIQUE INDEX "AiScoringConfig_workspaceId_instagramAccountId_key" ON "AiScoringConfig"("workspaceId", "instagramAccountId");

-- CreateIndex
CREATE INDEX "AiHandoff_conversationId_openedAt_idx" ON "AiHandoff"("conversationId", "openedAt");

-- CreateIndex
CREATE INDEX "AiHandoff_status_openedAt_idx" ON "AiHandoff"("status", "openedAt");

-- CreateIndex
CREATE INDEX "AiHandoffRule_workspaceId_active_idx" ON "AiHandoffRule"("workspaceId", "active");

-- CreateIndex
CREATE UNIQUE INDEX "AiContactMemory_instagramAccountId_igUserId_key" ON "AiContactMemory"("instagramAccountId", "igUserId");

-- CreateIndex
CREATE INDEX "AiKnowledgeEntry_profileId_active_sort_idx" ON "AiKnowledgeEntry"("profileId", "active", "sort");

-- CreateIndex
CREATE UNIQUE INDEX "AiLeadInsight_leadId_key" ON "AiLeadInsight"("leadId");

-- CreateIndex
CREATE INDEX "AiShadowTurn_workspaceId_createdAt_idx" ON "AiShadowTurn"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AiBudget_workspaceId_key" ON "AiBudget"("workspaceId");

-- AddForeignKey
ALTER TABLE "JavobAiAccount" ADD CONSTRAINT "JavobAiAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "JavobAiAccount" ADD CONSTRAINT "JavobAiAccount_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiConversationState" ADD CONSTRAINT "AiConversationState_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiScoreEvent" ADD CONSTRAINT "AiScoreEvent_stateId_fkey" FOREIGN KEY ("stateId") REFERENCES "AiConversationState"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiScoringConfig" ADD CONSTRAINT "AiScoringConfig_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiHandoff" ADD CONSTRAINT "AiHandoff_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiHandoffRule" ADD CONSTRAINT "AiHandoffRule_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiLeadInsight" ADD CONSTRAINT "AiLeadInsight_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiShadowTurn" ADD CONSTRAINT "AiShadowTurn_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiBudget" ADD CONSTRAINT "AiBudget_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

