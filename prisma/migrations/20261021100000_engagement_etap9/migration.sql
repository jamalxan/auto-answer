-- ETAP 9 Engagement (developer area). Additive only: new enums and tables.

-- CreateEnum
CREATE TYPE "GiveawayStatus" AS ENUM ('DRAFT', 'ACTIVE', 'CLOSED', 'DRAWN', 'ARCHIVED');

-- CreateEnum
CREATE TYPE "GiveawayEntryStatus" AS ENUM ('ELIGIBLE', 'INELIGIBLE', 'PENDING_CHECK', 'WINNER', 'DISQUALIFIED');

-- CreateEnum
CREATE TYPE "GiveawayDrawStatus" AS ENUM ('DRAWN', 'CONFIRMED', 'VOIDED');

-- CreateEnum
CREATE TYPE "FollowCheckResult" AS ENUM ('FOLLOWER', 'NOT_FOLLOWER', 'UNVERIFIABLE', 'NOT_CHECKED');

-- CreateEnum
CREATE TYPE "ReferralEventStatus" AS ENUM ('PENDING', 'QUALIFIED', 'REWARDED', 'REJECTED');

-- CreateEnum
CREATE TYPE "ReferralQualifier" AS ENUM ('FIRST_MESSAGE', 'LEAD', 'PURCHASE');

-- CreateTable
CREATE TABLE "Giveaway" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "mediaId" TEXT NOT NULL,
    "mediaMeta" JSONB,
    "rules" JSONB NOT NULL,
    "windowStart" TIMESTAMP(3) NOT NULL,
    "windowEnd" TIMESTAMP(3) NOT NULL,
    "status" "GiveawayStatus" NOT NULL DEFAULT 'DRAFT',
    "winnersCount" INTEGER NOT NULL DEFAULT 1,
    "backupCount" INTEGER NOT NULL DEFAULT 0,
    "seedCommitment" TEXT,
    "seedEncrypted" TEXT,
    "committedAt" TIMESTAMP(3),
    "confirmCampaignId" TEXT,
    "collectCursorAt" TIMESTAMP(3),
    "collectCursorId" TEXT,
    "backfillStatus" TEXT,
    "backfillScanned" INTEGER NOT NULL DEFAULT 0,
    "backfillError" TEXT,
    "entriesCount" INTEGER NOT NULL DEFAULT 0,
    "eligibleCount" INTEGER NOT NULL DEFAULT 0,
    "createdByUserId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Giveaway_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiveawayEntry" (
    "id" TEXT NOT NULL,
    "giveawayId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "igUserId" TEXT NOT NULL,
    "username" TEXT,
    "contactId" TEXT,
    "firstCommentId" TEXT NOT NULL,
    "firstCommentText" TEXT NOT NULL,
    "firstCommentAt" TIMESTAMP(3) NOT NULL,
    "commentCount" INTEGER NOT NULL DEFAULT 1,
    "sourceEventIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "mentionEventId" TEXT,
    "mentionedAt" TIMESTAMP(3),
    "taggedUsernames" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "followResult" "FollowCheckResult" NOT NULL DEFAULT 'NOT_CHECKED',
    "followCheckedAt" TIMESTAMP(3),
    "checks" JSONB NOT NULL DEFAULT '{}',
    "status" "GiveawayEntryStatus" NOT NULL DEFAULT 'PENDING_CHECK',
    "ineligibleReason" TEXT,
    "disqualifiedAt" TIMESTAMP(3),
    "disqualifiedBy" TEXT,
    "disqualifyReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiveawayEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiveawayDraw" (
    "id" TEXT NOT NULL,
    "giveawayId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "sequence" INTEGER NOT NULL,
    "algorithm" TEXT NOT NULL,
    "seedCommitment" TEXT NOT NULL,
    "seedRevealed" TEXT NOT NULL,
    "entrantsHash" TEXT NOT NULL,
    "entrantsCount" INTEGER NOT NULL,
    "winnersCount" INTEGER NOT NULL,
    "winnerEntryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "backupEntryIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "verification" TEXT NOT NULL,
    "status" "GiveawayDrawStatus" NOT NULL DEFAULT 'DRAWN',
    "drawnAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "confirmedAt" TIMESTAMP(3),
    "confirmedByUserId" TEXT,
    "voidedAt" TIMESTAMP(3),
    "voidReason" TEXT,

    CONSTRAINT "GiveawayDraw_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "GiveawayNotification" (
    "id" TEXT NOT NULL,
    "giveawayId" TEXT NOT NULL,
    "entryId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "status" TEXT NOT NULL,
    "reason" TEXT,
    "sentMessageId" TEXT,
    "snapshot" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "GiveawayNotification_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralProgram" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT false,
    "qualifier" "ReferralQualifier" NOT NULL DEFAULT 'FIRST_MESSAGE',
    "rewardRules" JSONB NOT NULL DEFAULT '{}',
    "burstLimitPerDay" INTEGER NOT NULL DEFAULT 10,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ReferralProgram_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralCode" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "contactId" TEXT,
    "igUserId" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastSharedAt" TIMESTAMP(3),

    CONSTRAINT "ReferralCode_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReferralEvent" (
    "id" TEXT NOT NULL,
    "programId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "codeId" TEXT NOT NULL,
    "referrerIgUserId" TEXT NOT NULL,
    "referrerContactId" TEXT,
    "refereeIgUserId" TEXT NOT NULL,
    "refereeContactId" TEXT,
    "sourceEventId" TEXT NOT NULL,
    "status" "ReferralEventStatus" NOT NULL DEFAULT 'PENDING',
    "qualifiedAt" TIMESTAMP(3),
    "qualifiedBy" "ReferralQualifier",
    "rewardedAt" TIMESTAMP(3),
    "rewardSnapshot" JSONB,
    "fraudFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewedAt" TIMESTAMP(3),
    "reviewedByUserId" TEXT,
    "rejectReason" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReferralEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngagementSettings" (
    "workspaceId" TEXT NOT NULL,
    "pointsRules" JSONB NOT NULL DEFAULT '{}',
    "badgeRules" JSONB NOT NULL DEFAULT '[]',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "EngagementSettings_pkey" PRIMARY KEY ("workspaceId")
);

-- CreateTable
CREATE TABLE "EngagementPoint" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "points" INTEGER NOT NULL,
    "reason" TEXT NOT NULL,
    "sourceTable" TEXT NOT NULL,
    "sourceId" TEXT NOT NULL,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngagementPoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "EngagementBadge" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "contactId" TEXT NOT NULL,
    "badgeKey" TEXT NOT NULL,
    "awardedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "EngagementBadge_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Giveaway_workspaceId_status_idx" ON "Giveaway"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "Giveaway_instagramAccountId_mediaId_status_idx" ON "Giveaway"("instagramAccountId", "mediaId", "status");

-- CreateIndex
CREATE INDEX "GiveawayEntry_giveawayId_status_idx" ON "GiveawayEntry"("giveawayId", "status");

-- CreateIndex
CREATE INDEX "GiveawayEntry_contactId_idx" ON "GiveawayEntry"("contactId");

-- CreateIndex
CREATE UNIQUE INDEX "GiveawayEntry_giveawayId_igUserId_key" ON "GiveawayEntry"("giveawayId", "igUserId");

-- CreateIndex
CREATE UNIQUE INDEX "GiveawayDraw_giveawayId_sequence_key" ON "GiveawayDraw"("giveawayId", "sequence");

-- CreateIndex
CREATE UNIQUE INDEX "GiveawayNotification_giveawayId_entryId_channel_key" ON "GiveawayNotification"("giveawayId", "entryId", "channel");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralProgram_instagramAccountId_key" ON "ReferralProgram"("instagramAccountId");

-- CreateIndex
CREATE INDEX "ReferralProgram_workspaceId_idx" ON "ReferralProgram"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCode_instagramAccountId_code_key" ON "ReferralCode"("instagramAccountId", "code");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralCode_programId_igUserId_key" ON "ReferralCode"("programId", "igUserId");

-- CreateIndex
CREATE INDEX "ReferralEvent_programId_status_idx" ON "ReferralEvent"("programId", "status");

-- CreateIndex
CREATE INDEX "ReferralEvent_referrerIgUserId_createdAt_idx" ON "ReferralEvent"("referrerIgUserId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ReferralEvent_programId_refereeIgUserId_key" ON "ReferralEvent"("programId", "refereeIgUserId");

-- CreateIndex
CREATE INDEX "EngagementPoint_workspaceId_contactId_idx" ON "EngagementPoint"("workspaceId", "contactId");

-- CreateIndex
CREATE INDEX "EngagementPoint_workspaceId_occurredAt_idx" ON "EngagementPoint"("workspaceId", "occurredAt");

-- CreateIndex
CREATE UNIQUE INDEX "EngagementPoint_sourceTable_sourceId_reason_key" ON "EngagementPoint"("sourceTable", "sourceId", "reason");

-- CreateIndex
CREATE INDEX "EngagementBadge_workspaceId_idx" ON "EngagementBadge"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "EngagementBadge_contactId_badgeKey_key" ON "EngagementBadge"("contactId", "badgeKey");

-- AddForeignKey
ALTER TABLE "Giveaway" ADD CONSTRAINT "Giveaway_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Giveaway" ADD CONSTRAINT "Giveaway_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiveawayEntry" ADD CONSTRAINT "GiveawayEntry_giveawayId_fkey" FOREIGN KEY ("giveawayId") REFERENCES "Giveaway"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiveawayDraw" ADD CONSTRAINT "GiveawayDraw_giveawayId_fkey" FOREIGN KEY ("giveawayId") REFERENCES "Giveaway"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "GiveawayNotification" ADD CONSTRAINT "GiveawayNotification_giveawayId_fkey" FOREIGN KEY ("giveawayId") REFERENCES "Giveaway"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralProgram" ADD CONSTRAINT "ReferralProgram_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralProgram" ADD CONSTRAINT "ReferralProgram_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralCode" ADD CONSTRAINT "ReferralCode_programId_fkey" FOREIGN KEY ("programId") REFERENCES "ReferralProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralEvent" ADD CONSTRAINT "ReferralEvent_programId_fkey" FOREIGN KEY ("programId") REFERENCES "ReferralProgram"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReferralEvent" ADD CONSTRAINT "ReferralEvent_codeId_fkey" FOREIGN KEY ("codeId") REFERENCES "ReferralCode"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngagementSettings" ADD CONSTRAINT "EngagementSettings_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngagementPoint" ADD CONSTRAINT "EngagementPoint_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "EngagementBadge" ADD CONSTRAINT "EngagementBadge_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

