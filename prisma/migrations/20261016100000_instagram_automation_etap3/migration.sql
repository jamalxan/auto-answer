-- ETAP 3 Instagram automation (developer area). Additive only: a new event
-- type value, two enums, nullable/defaulted columns, two indexes and one
-- nullable foreign key (InstagramEvent.claimedCampaignId → TriggerCampaign,
-- SET NULL on delete: the DM-trigger campaign the webhook decided will answer
-- the event).

-- CreateEnum
CREATE TYPE "TriggerAudience" AS ENUM ('ANY', 'NEW_CONTACT', 'RETURNING_CONTACT', 'REOPENED');

-- CreateEnum
CREATE TYPE "TriggerSourceFilter" AS ENUM ('ANY', 'ADS', 'LINK');

-- AlterEnum
ALTER TYPE "InstagramEventType" ADD VALUE 'MESSAGE_REACTION';

-- AlterTable
ALTER TABLE "InstagramEvent" ADD COLUMN     "adId" TEXT,
ADD COLUMN     "claimedCampaignId" TEXT,
ADD COLUMN     "reactedMid" TEXT,
ADD COLUMN     "reaction" TEXT,
ADD COLUMN     "ref" TEXT,
ADD COLUMN     "referralSource" TEXT;

-- AlterTable
ALTER TABLE "TriggerCampaign" ADD COLUMN     "adIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "audience" "TriggerAudience" NOT NULL DEFAULT 'ANY',
ADD COLUMN     "cooldownHours" INTEGER NOT NULL DEFAULT 24,
ADD COLUMN     "refs" TEXT[] DEFAULT ARRAY[]::TEXT[],
ADD COLUMN     "reopenAfterHours" INTEGER NOT NULL DEFAULT 72,
ADD COLUMN     "sourceFilter" "TriggerSourceFilter" NOT NULL DEFAULT 'ANY';

-- CreateIndex
CREATE INDEX "InstagramEvent_instagramAccountId_senderId_timestamp_idx" ON "InstagramEvent"("instagramAccountId", "senderId", "timestamp");

-- CreateIndex
CREATE INDEX "InstagramEvent_claimedCampaignId_idx" ON "InstagramEvent"("claimedCampaignId");

-- AddForeignKey
ALTER TABLE "InstagramEvent" ADD CONSTRAINT "InstagramEvent_claimedCampaignId_fkey" FOREIGN KEY ("claimedCampaignId") REFERENCES "TriggerCampaign"("id") ON DELETE SET NULL ON UPDATE CASCADE;
