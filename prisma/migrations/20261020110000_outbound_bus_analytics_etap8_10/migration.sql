-- ETAP 8 outbound event bus and ETAP 10 analytics rollups (developer area).
-- Additive only: new enum/tables and one nullable column on TriggerExecution.

-- CreateEnum
CREATE TYPE "OutboundDeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'DEAD', 'SKIPPED');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.



-- AlterTable
ALTER TABLE "TriggerExecution" ADD COLUMN     "firstInboundAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "OutboundEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "subjectType" TEXT NOT NULL,
    "subjectId" TEXT NOT NULL,
    "instagramAccountId" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "payload" JSONB,
    "materializedAt" TIMESTAMP(3),
    "dedupeKey" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OutboundEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OutboundDelivery" (
    "id" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "subscriptionId" TEXT,
    "status" "OutboundDeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "responseCode" INTEGER,
    "responseSnippet" TEXT,
    "signature" TEXT,
    "externalId" TEXT,
    "externalUrl" TEXT,
    "durationMs" INTEGER,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OutboundDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IntegrationSubscription" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "eventType" TEXT NOT NULL,
    "filter" JSONB NOT NULL DEFAULT '{}',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IntegrationSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsDaily" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL DEFAULT '',
    "day" DATE NOT NULL,
    "metric" TEXT NOT NULL,
    "dimKind" TEXT NOT NULL DEFAULT '',
    "dimId" TEXT NOT NULL DEFAULT '',
    "value" DECIMAL(18,6) NOT NULL DEFAULT 0,
    "computedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AnalyticsDaily_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AnalyticsAlertState" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "rule" TEXT NOT NULL,
    "lastAlertedAt" TIMESTAMP(3) NOT NULL,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AnalyticsAlertState_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "OutboundEvent_workspaceId_createdAt_idx" ON "OutboundEvent"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "OutboundEvent_workspaceId_type_createdAt_idx" ON "OutboundEvent"("workspaceId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "OutboundEvent_materializedAt_idx" ON "OutboundEvent"("materializedAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundEvent_workspaceId_dedupeKey_key" ON "OutboundEvent"("workspaceId", "dedupeKey");

-- CreateIndex
CREATE INDEX "OutboundDelivery_status_nextAttemptAt_idx" ON "OutboundDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "OutboundDelivery_integrationId_status_createdAt_idx" ON "OutboundDelivery"("integrationId", "status", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "OutboundDelivery_eventId_integrationId_key" ON "OutboundDelivery"("eventId", "integrationId");

-- CreateIndex
CREATE UNIQUE INDEX "IntegrationSubscription_integrationId_eventType_key" ON "IntegrationSubscription"("integrationId", "eventType");

-- CreateIndex
CREATE INDEX "AnalyticsDaily_workspaceId_metric_day_idx" ON "AnalyticsDaily"("workspaceId", "metric", "day");

-- CreateIndex
CREATE INDEX "AnalyticsDaily_workspaceId_day_idx" ON "AnalyticsDaily"("workspaceId", "day");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsDaily_workspaceId_instagramAccountId_day_metric_di_key" ON "AnalyticsDaily"("workspaceId", "instagramAccountId", "day", "metric", "dimKind", "dimId");

-- CreateIndex
CREATE UNIQUE INDEX "AnalyticsAlertState_workspaceId_rule_key" ON "AnalyticsAlertState"("workspaceId", "rule");

-- AddForeignKey
ALTER TABLE "OutboundEvent" ADD CONSTRAINT "OutboundEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundDelivery" ADD CONSTRAINT "OutboundDelivery_eventId_fkey" FOREIGN KEY ("eventId") REFERENCES "OutboundEvent"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OutboundDelivery" ADD CONSTRAINT "OutboundDelivery_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "IntegrationSubscription" ADD CONSTRAINT "IntegrationSubscription_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsDaily" ADD CONSTRAINT "AnalyticsDaily_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AnalyticsAlertState" ADD CONSTRAINT "AnalyticsAlertState_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

