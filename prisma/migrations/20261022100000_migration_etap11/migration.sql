-- ETAP 11 migration projects (developer area). Additive only: new enums and tables.

-- CreateEnum
CREATE TYPE "MigrationSource" AS ENUM ('MANYCHAT');

-- CreateEnum
CREATE TYPE "MigrationStatus" AS ENUM ('CONNECTED', 'ANALYZED', 'IMPORTING', 'DONE', 'FAILED');

-- CreateEnum
CREATE TYPE "MigrationItemKind" AS ENUM ('TAG', 'CUSTOM_FIELD', 'BOT_FIELD', 'FLOW', 'GROWTH_TOOL');

-- CreateEnum
CREATE TYPE "MigrationItemStatus" AS ENUM ('PENDING', 'MAPPED', 'CONVERTED', 'IMPORTED', 'SKIPPED', 'UNSUPPORTED', 'FAILED');

-- CreateTable
CREATE TABLE "MigrationProject" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT,
    "source" "MigrationSource" NOT NULL DEFAULT 'MANYCHAT',
    "name" TEXT NOT NULL,
    "status" "MigrationStatus" NOT NULL DEFAULT 'CONNECTED',
    "apiKeyEncrypted" TEXT,
    "apiKeyHint" TEXT,
    "pageSnapshot" JSONB,
    "lastAnalyzedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationProject_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MigrationItem" (
    "id" TEXT NOT NULL,
    "projectId" TEXT NOT NULL,
    "kind" "MigrationItemKind" NOT NULL,
    "sourceId" TEXT,
    "name" TEXT NOT NULL,
    "folder" TEXT,
    "status" "MigrationItemStatus" NOT NULL DEFAULT 'PENDING',
    "mapping" JSONB NOT NULL DEFAULT '{}',
    "sourceText" TEXT,
    "warnings" JSONB NOT NULL DEFAULT '[]',
    "flowId" TEXT,
    "note" TEXT,
    "importClaimedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "MigrationItem_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "MigrationProject_workspaceId_createdAt_idx" ON "MigrationProject"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "MigrationItem_projectId_kind_status_idx" ON "MigrationItem"("projectId", "kind", "status");

-- CreateIndex
CREATE UNIQUE INDEX "MigrationItem_projectId_kind_sourceId_key" ON "MigrationItem"("projectId", "kind", "sourceId");

-- AddForeignKey
ALTER TABLE "MigrationProject" ADD CONSTRAINT "MigrationProject_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MigrationItem" ADD CONSTRAINT "MigrationItem_projectId_fkey" FOREIGN KEY ("projectId") REFERENCES "MigrationProject"("id") ON DELETE CASCADE ON UPDATE CASCADE;

