-- CreateTable
CREATE TABLE "ContentPostStat" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "igMediaId" TEXT NOT NULL,
    "scheduledPostId" TEXT,
    "mediaType" TEXT NOT NULL,
    "productType" TEXT,
    "permalink" TEXT,
    "caption" TEXT,
    "publishedAt" TIMESTAMP(3) NOT NULL,
    "views" INTEGER,
    "reach" INTEGER,
    "likes" INTEGER,
    "comments" INTEGER,
    "saves" INTEGER,
    "shares" INTEGER,
    "follows" INTEGER,
    "totalInteractions" INTEGER,
    "avgWatchMs" INTEGER,
    "skipRate" DOUBLE PRECISION,
    "bizComments" INTEGER NOT NULL DEFAULT 0,
    "bizDms" INTEGER NOT NULL DEFAULT 0,
    "bizLeads" INTEGER NOT NULL DEFAULT 0,
    "bizSales" INTEGER NOT NULL DEFAULT 0,
    "score" DOUBLE PRECISION,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentPostStat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentAnalysis" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "statId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "tags" JSONB NOT NULL DEFAULT '{}',
    "transcript" TEXT,
    "issues" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "model" TEXT,
    "costUsd" DOUBLE PRECISION,
    "error" TEXT,
    "analyzedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentAnalysis_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentReport" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "weekStart" TIMESTAMP(3) NOT NULL,
    "body" JSONB NOT NULL,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ContentReport_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ContentPlan" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "startsOn" TIMESTAMP(3) NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'DRAFT',
    "items" JSONB NOT NULL DEFAULT '[]',
    "model" TEXT,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ContentPlan_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "HookExperiment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "variants" JSONB NOT NULL DEFAULT '[]',
    "status" TEXT NOT NULL DEFAULT 'RUNNING',
    "winnerIndex" INTEGER,
    "decidedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "HookExperiment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ContentPostStat_workspaceId_publishedAt_idx" ON "ContentPostStat"("workspaceId", "publishedAt");

-- CreateIndex
CREATE UNIQUE INDEX "ContentPostStat_instagramAccountId_igMediaId_key" ON "ContentPostStat"("instagramAccountId", "igMediaId");

-- CreateIndex
CREATE UNIQUE INDEX "ContentAnalysis_statId_key" ON "ContentAnalysis"("statId");

-- CreateIndex
CREATE INDEX "ContentAnalysis_workspaceId_createdAt_idx" ON "ContentAnalysis"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ContentAnalysis_status_idx" ON "ContentAnalysis"("status");

-- CreateIndex
CREATE INDEX "ContentReport_workspaceId_weekStart_idx" ON "ContentReport"("workspaceId", "weekStart");

-- CreateIndex
CREATE UNIQUE INDEX "ContentReport_instagramAccountId_weekStart_key" ON "ContentReport"("instagramAccountId", "weekStart");

-- CreateIndex
CREATE INDEX "ContentPlan_workspaceId_createdAt_idx" ON "ContentPlan"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "HookExperiment_workspaceId_status_idx" ON "HookExperiment"("workspaceId", "status");

-- AddForeignKey
ALTER TABLE "ContentPostStat" ADD CONSTRAINT "ContentPostStat_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentAnalysis" ADD CONSTRAINT "ContentAnalysis_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentAnalysis" ADD CONSTRAINT "ContentAnalysis_statId_fkey" FOREIGN KEY ("statId") REFERENCES "ContentPostStat"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentReport" ADD CONSTRAINT "ContentReport_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ContentPlan" ADD CONSTRAINT "ContentPlan_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "HookExperiment" ADD CONSTRAINT "HookExperiment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

