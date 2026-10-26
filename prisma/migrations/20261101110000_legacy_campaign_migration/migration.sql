-- CreateEnum
CREATE TYPE "LegacyMigrationStatus" AS ENUM ('SHADOW', 'CUTOVER', 'ROLLED_BACK');

-- CreateTable
CREATE TABLE "LegacyCampaignMigration" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "automationId" TEXT NOT NULL,
    "triggerCampaignId" TEXT NOT NULL,
    "status" "LegacyMigrationStatus" NOT NULL DEFAULT 'SHADOW',
    "notes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "shadowStartedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cutoverAt" TIMESTAMP(3),
    "rolledBackAt" TIMESTAMP(3),
    "forcedReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LegacyCampaignMigration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LegacyMigrationSample" (
    "id" TEXT NOT NULL,
    "migrationId" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "commentText" TEXT NOT NULL,
    "mediaId" TEXT,
    "legacyMatched" BOOLEAN NOT NULL,
    "newMatched" BOOLEAN NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LegacyMigrationSample_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "LegacyCampaignMigration_automationId_key" ON "LegacyCampaignMigration"("automationId");

-- CreateIndex
CREATE INDEX "LegacyCampaignMigration_workspaceId_status_idx" ON "LegacyCampaignMigration"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "LegacyMigrationSample_migrationId_createdAt_idx" ON "LegacyMigrationSample"("migrationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "LegacyMigrationSample_migrationId_commentId_key" ON "LegacyMigrationSample"("migrationId", "commentId");

-- AddForeignKey
ALTER TABLE "LegacyCampaignMigration" ADD CONSTRAINT "LegacyCampaignMigration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyCampaignMigration" ADD CONSTRAINT "LegacyCampaignMigration_automationId_fkey" FOREIGN KEY ("automationId") REFERENCES "Automation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LegacyMigrationSample" ADD CONSTRAINT "LegacyMigrationSample_migrationId_fkey" FOREIGN KEY ("migrationId") REFERENCES "LegacyCampaignMigration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

