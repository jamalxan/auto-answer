-- CreateEnum
CREATE TYPE "AiLadderMode" AS ENUM ('OBSERVE', 'COPILOT', 'AUTO');

-- CreateEnum
CREATE TYPE "AiDraftStatus" AS ENUM ('PENDING', 'SENT', 'EDITED', 'DISCARDED', 'SUPERSEDED', 'EXPIRED', 'FAILED');

-- CreateEnum
CREATE TYPE "AiFactStatus" AS ENUM ('PENDING', 'APPROVED', 'REJECTED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AiKnowledgeKind" ADD VALUE 'PRICE';
ALTER TYPE "AiKnowledgeKind" ADD VALUE 'HOURS';
ALTER TYPE "AiKnowledgeKind" ADD VALUE 'DELIVERY';

-- AlterTable
ALTER TABLE "AiHandoff" ADD COLUMN     "escalatedAt" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "AiKnowledgeEntry" ADD COLUMN     "expiresAt" TIMESTAMP(3),
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'owner';

-- AlterTable
ALTER TABLE "AiShadowTurn" ADD COLUMN     "critical" TEXT,
ADD COLUMN     "customerMessageId" TEXT,
ADD COLUMN     "factsExtractedAt" TIMESTAMP(3),
ADD COLUMN     "instagramAccountId" TEXT,
ADD COLUMN     "judgeMatch" BOOLEAN,
ADD COLUMN     "judgeNotes" TEXT,
ADD COLUMN     "judgeScore" DOUBLE PRECISION,
ADD COLUMN     "judgedAt" TIMESTAMP(3),
ADD COLUMN     "operatorRepliedAt" TIMESTAMP(3),
ADD COLUMN     "operatorReply" TEXT,
ADD COLUMN     "source" TEXT NOT NULL DEFAULT 'shadow';

-- CreateTable
CREATE TABLE "AiIntentPolicy" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "intent" TEXT NOT NULL,
    "mode" "AiLadderMode" NOT NULL DEFAULT 'OBSERVE',
    "changedBy" TEXT,
    "changedAt" TIMESTAMP(3),
    "demotedAt" TIMESTAMP(3),
    "demoteReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiIntentPolicy_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiDraft" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "shadowTurnId" TEXT,
    "text" TEXT NOT NULL,
    "intent" TEXT,
    "confidence" DOUBLE PRECISION,
    "status" "AiDraftStatus" NOT NULL DEFAULT 'PENDING',
    "finalText" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiDraft_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiFactCandidate" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "kind" "AiKnowledgeKind" NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "source" TEXT NOT NULL DEFAULT 'observed',
    "shadowTurnId" TEXT,
    "evidence" TEXT,
    "confidence" DOUBLE PRECISION,
    "status" "AiFactStatus" NOT NULL DEFAULT 'PENDING',
    "validUntil" TIMESTAMP(3),
    "knowledgeEntryId" TEXT,
    "decidedBy" TEXT,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiFactCandidate_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiEvalCase" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "expectedIntent" TEXT,
    "mustContain" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mustNotContain" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "referenceAnswer" TEXT,
    "source" TEXT NOT NULL DEFAULT 'manual',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AiEvalCase_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AiEvalRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "model" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "total" INTEGER NOT NULL DEFAULT 0,
    "passed" INTEGER NOT NULL DEFAULT 0,
    "failed" INTEGER NOT NULL DEFAULT 0,
    "results" JSONB NOT NULL DEFAULT '[]',
    "triggeredBy" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AiEvalRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CommentModeration" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "mediaId" TEXT,
    "text" TEXT NOT NULL,
    "verdict" TEXT NOT NULL,
    "action" TEXT NOT NULL,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CommentModeration_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "AiIntentPolicy_workspaceId_idx" ON "AiIntentPolicy"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "AiIntentPolicy_instagramAccountId_intent_key" ON "AiIntentPolicy"("instagramAccountId", "intent");

-- CreateIndex
CREATE UNIQUE INDEX "AiDraft_shadowTurnId_key" ON "AiDraft"("shadowTurnId");

-- CreateIndex
CREATE INDEX "AiDraft_workspaceId_status_createdAt_idx" ON "AiDraft"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AiDraft_conversationId_status_idx" ON "AiDraft"("conversationId", "status");

-- CreateIndex
CREATE INDEX "AiFactCandidate_workspaceId_status_createdAt_idx" ON "AiFactCandidate"("workspaceId", "status", "createdAt");

-- CreateIndex
CREATE INDEX "AiEvalCase_instagramAccountId_active_idx" ON "AiEvalCase"("instagramAccountId", "active");

-- CreateIndex
CREATE INDEX "AiEvalRun_instagramAccountId_startedAt_idx" ON "AiEvalRun"("instagramAccountId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "CommentModeration_commentId_key" ON "CommentModeration"("commentId");

-- CreateIndex
CREATE INDEX "CommentModeration_workspaceId_createdAt_idx" ON "CommentModeration"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AiShadowTurn_instagramAccountId_intent_createdAt_idx" ON "AiShadowTurn"("instagramAccountId", "intent", "createdAt");

-- CreateIndex
CREATE INDEX "AiShadowTurn_conversationId_createdAt_idx" ON "AiShadowTurn"("conversationId", "createdAt");

-- AddForeignKey
ALTER TABLE "AiIntentPolicy" ADD CONSTRAINT "AiIntentPolicy_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiDraft" ADD CONSTRAINT "AiDraft_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiFactCandidate" ADD CONSTRAINT "AiFactCandidate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiEvalCase" ADD CONSTRAINT "AiEvalCase_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AiEvalRun" ADD CONSTRAINT "AiEvalRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CommentModeration" ADD CONSTRAINT "CommentModeration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

