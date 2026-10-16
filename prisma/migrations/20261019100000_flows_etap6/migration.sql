-- ETAP 6/7 Flow Builder (developer area). Additive only: new enums and tables,
-- one defaulted column on TriggerCampaign (kind).

-- CreateEnum
CREATE TYPE "TriggerCampaignKind" AS ENUM ('CAMPAIGN', 'FLOW');

-- CreateEnum
CREATE TYPE "FlowStatus" AS ENUM ('DRAFT', 'REVIEW', 'PUBLISHED', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "FlowMode" AS ENUM ('SIMPLE', 'ADVANCED');

-- CreateEnum
CREATE TYPE "FlowVersionSource" AS ENUM ('MANUAL', 'AI', 'TEMPLATE', 'IMPORT');

-- CreateEnum
CREATE TYPE "FlowRunStatus" AS ENUM ('ACTIVE', 'WAITING_TAP', 'WAITING_INBOUND', 'WAITING_DELAY', 'DONE', 'FAILED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "FlowStepStatus" AS ENUM ('DONE', 'SKIPPED', 'FAILED', 'WAITING');

-- AlterTable
ALTER TABLE "TriggerCampaign" ADD COLUMN     "kind" "TriggerCampaignKind" NOT NULL DEFAULT 'CAMPAIGN';

-- CreateTable
CREATE TABLE "Flow" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "mode" "FlowMode" NOT NULL DEFAULT 'SIMPLE',
    "status" "FlowStatus" NOT NULL DEFAULT 'DRAFT',
    "triggerType" "InstagramEventType" NOT NULL,
    "draftVersionId" TEXT,
    "publishedVersionId" TEXT,
    "proxyCampaignId" TEXT,
    "createdByUserId" TEXT,
    "archivedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Flow_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlowVersion" (
    "id" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "graph" JSONB NOT NULL,
    "hash" TEXT NOT NULL,
    "source" "FlowVersionSource" NOT NULL DEFAULT 'MANUAL',
    "prompt" TEXT,
    "changeNote" TEXT,
    "auditResult" JSONB,
    "policyResult" JSONB,
    "testedAt" TIMESTAMP(3),
    "approvedAt" TIMESTAMP(3),
    "approvedByUserId" TEXT,
    "publishedAt" TIMESTAMP(3),
    "publishedByUserId" TEXT,
    "retiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FlowVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlowRun" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "flowId" TEXT NOT NULL,
    "versionId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "igUserId" TEXT NOT NULL,
    "contactId" TEXT,
    "conversationId" TEXT,
    "eventId" TEXT NOT NULL,
    "executionId" TEXT,
    "status" "FlowRunStatus" NOT NULL DEFAULT 'ACTIVE',
    "currentNodeId" TEXT,
    "seq" INTEGER NOT NULL DEFAULT 0,
    "variables" JSONB NOT NULL DEFAULT '{}',
    "waitNodeId" TEXT,
    "waitUntil" TIMESTAMP(3),
    "waitKind" TEXT,
    "sendsSinceInbound" INTEGER NOT NULL DEFAULT 0,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "endReason" TEXT,
    "lastError" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "FlowRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlowRunStep" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "seq" INTEGER NOT NULL,
    "nodeId" TEXT NOT NULL,
    "nodeType" TEXT NOT NULL,
    "status" "FlowStepStatus" NOT NULL,
    "input" JSONB,
    "output" JSONB,
    "reason" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "FlowRunStep_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FlowTemplate" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT,
    "key" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "category" TEXT NOT NULL,
    "locale" TEXT NOT NULL DEFAULT 'uz',
    "graph" JSONB NOT NULL,
    "schemaVersion" INTEGER NOT NULL DEFAULT 1,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FlowTemplate_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "Flow_draftVersionId_key" ON "Flow"("draftVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "Flow_publishedVersionId_key" ON "Flow"("publishedVersionId");

-- CreateIndex
CREATE UNIQUE INDEX "Flow_proxyCampaignId_key" ON "Flow"("proxyCampaignId");

-- CreateIndex
CREATE INDEX "Flow_workspaceId_status_idx" ON "Flow"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Flow_instagramAccountId_status_triggerType_idx" ON "Flow"("instagramAccountId", "status", "triggerType");

-- CreateIndex
CREATE UNIQUE INDEX "FlowVersion_flowId_version_key" ON "FlowVersion"("flowId", "version");

-- CreateIndex
CREATE UNIQUE INDEX "FlowRun_executionId_key" ON "FlowRun"("executionId");

-- CreateIndex
CREATE INDEX "FlowRun_instagramAccountId_igUserId_status_idx" ON "FlowRun"("instagramAccountId", "igUserId", "status");

-- CreateIndex
CREATE INDEX "FlowRun_status_waitUntil_idx" ON "FlowRun"("status", "waitUntil");

-- CreateIndex
CREATE INDEX "FlowRun_flowId_startedAt_idx" ON "FlowRun"("flowId", "startedAt");

-- CreateIndex
CREATE INDEX "FlowRun_workspaceId_startedAt_idx" ON "FlowRun"("workspaceId", "startedAt");

-- CreateIndex
CREATE INDEX "FlowRunStep_runId_startedAt_idx" ON "FlowRunStep"("runId", "startedAt");

-- CreateIndex
CREATE UNIQUE INDEX "FlowRunStep_runId_seq_key" ON "FlowRunStep"("runId", "seq");

-- CreateIndex
CREATE UNIQUE INDEX "FlowTemplate_key_key" ON "FlowTemplate"("key");

-- AddForeignKey
ALTER TABLE "Flow" ADD CONSTRAINT "Flow_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flow" ADD CONSTRAINT "Flow_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Flow" ADD CONSTRAINT "Flow_proxyCampaignId_fkey" FOREIGN KEY ("proxyCampaignId") REFERENCES "TriggerCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowVersion" ADD CONSTRAINT "FlowVersion_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowRun" ADD CONSTRAINT "FlowRun_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowRun" ADD CONSTRAINT "FlowRun_flowId_fkey" FOREIGN KEY ("flowId") REFERENCES "Flow"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowRun" ADD CONSTRAINT "FlowRun_versionId_fkey" FOREIGN KEY ("versionId") REFERENCES "FlowVersion"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowRunStep" ADD CONSTRAINT "FlowRunStep_runId_fkey" FOREIGN KEY ("runId") REFERENCES "FlowRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FlowTemplate" ADD CONSTRAINT "FlowTemplate_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

