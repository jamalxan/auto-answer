-- CreateTable
CREATE TABLE "AdAccount" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "adAccountId" TEXT NOT NULL,
    "name" TEXT,
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "pageId" TEXT,
    "igUserId" TEXT,
    "datasetId" TEXT,
    "encryptedPayload" TEXT NOT NULL,
    "dekEncrypted" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "dailyCapMinor" INTEGER,
    "monthlyCapMinor" INTEGER,
    "cplMaxMinor" INTEGER,
    "defaultDailyBudgetMinor" INTEGER,
    "saleValueMinor" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdAccount_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdProposal" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "kind" TEXT NOT NULL DEFAULT 'BOOST',
    "objective" TEXT NOT NULL DEFAULT 'MESSAGES',
    "statId" TEXT,
    "igMediaId" TEXT NOT NULL,
    "permalink" TEXT,
    "reason" TEXT NOT NULL,
    "dailyBudgetMinor" INTEGER NOT NULL,
    "durationDays" INTEGER NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'PROPOSED',
    "approvedById" TEXT,
    "approvedAt" TIMESTAMP(3),
    "startAt" TIMESTAMP(3),
    "endAt" TIMESTAMP(3),
    "campaignId" TEXT,
    "adSetId" TEXT,
    "creativeId" TEXT,
    "adId" TEXT,
    "pauseReason" TEXT,
    "spendMinor" INTEGER NOT NULL DEFAULT 0,
    "results" INTEGER NOT NULL DEFAULT 0,
    "insightsAt" TIMESTAMP(3),
    "error" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdProposal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdSpendDay" (
    "id" TEXT NOT NULL,
    "proposalId" TEXT NOT NULL,
    "date" TEXT NOT NULL,
    "spendMinor" INTEGER NOT NULL DEFAULT 0,
    "results" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AdSpendDay_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AdReferral" (
    "id" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "igUserId" TEXT NOT NULL,
    "adId" TEXT NOT NULL,
    "adTitle" TEXT,
    "postId" TEXT,
    "productId" TEXT,
    "source" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AdReferral_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CapiEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "accountId" TEXT NOT NULL,
    "dealId" TEXT NOT NULL,
    "eventName" TEXT NOT NULL DEFAULT 'Purchase',
    "status" TEXT NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "error" TEXT,
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "CapiEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "AdAccount_workspaceId_adAccountId_key" ON "AdAccount"("workspaceId", "adAccountId");

-- CreateIndex
CREATE INDEX "AdProposal_workspaceId_status_idx" ON "AdProposal"("workspaceId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "AdProposal_accountId_kind_igMediaId_key" ON "AdProposal"("accountId", "kind", "igMediaId");

-- CreateIndex
CREATE UNIQUE INDEX "AdSpendDay_proposalId_date_key" ON "AdSpendDay"("proposalId", "date");

-- CreateIndex
CREATE INDEX "AdReferral_instagramAccountId_igUserId_createdAt_idx" ON "AdReferral"("instagramAccountId", "igUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "AdReferral_instagramAccountId_igUserId_adId_key" ON "AdReferral"("instagramAccountId", "igUserId", "adId");

-- CreateIndex
CREATE INDEX "CapiEvent_status_idx" ON "CapiEvent"("status");

-- CreateIndex
CREATE UNIQUE INDEX "CapiEvent_dealId_eventName_key" ON "CapiEvent"("dealId", "eventName");

-- AddForeignKey
ALTER TABLE "AdAccount" ADD CONSTRAINT "AdAccount_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdProposal" ADD CONSTRAINT "AdProposal_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdProposal" ADD CONSTRAINT "AdProposal_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "AdAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AdSpendDay" ADD CONSTRAINT "AdSpendDay_proposalId_fkey" FOREIGN KEY ("proposalId") REFERENCES "AdProposal"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CapiEvent" ADD CONSTRAINT "CapiEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

