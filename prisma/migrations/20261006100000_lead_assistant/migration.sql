-- CreateEnum
CREATE TYPE "TokenStatus" AS ENUM ('ACTIVE', 'BROKEN');

-- CreateEnum
CREATE TYPE "IntegrationType" AS ENUM ('TELEGRAM', 'AMOCRM', 'BITRIX24');

-- CreateEnum
CREATE TYPE "IntegrationStatus" AS ENUM ('ACTIVE', 'BROKEN', 'DISABLED');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'SENT', 'FAILED', 'DEAD');

-- CreateEnum
CREATE TYPE "LeadStatus" AS ENUM ('NEW', 'SENT', 'PARTIAL', 'FAILED');

-- CreateEnum
CREATE TYPE "LeadSource" AS ENUM ('CAMPAIGN', 'INBOUND_DM');

-- CreateEnum
CREATE TYPE "AssistantState" AS ENUM ('NEW', 'NEED', 'CONTACT', 'CAPTURED', 'FALLBACK', 'HANDED_OFF');

-- CreateEnum
CREATE TYPE "MessageAuthor" AS ENUM ('CUSTOMER', 'ASSISTANT', 'OPERATOR', 'SYSTEM');

-- CreateEnum
CREATE TYPE "PricePolicy" AS ENUM ('NEVER', 'FROM_ONLY', 'EXACT');

-- CreateEnum
CREATE TYPE "AssistantTone" AS ENUM ('FRIENDLY', 'FORMAL');

-- CreateEnum
CREATE TYPE "ProfileSource" AS ENUM ('PANEL', 'TELEGRAM');

-- CreateEnum
CREATE TYPE "OnboardingStatus" AS ENUM ('ACTIVE', 'PAUSED', 'COMPLETED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "UploadKind" AS ENUM ('VOICE', 'PHOTO', 'XLSX', 'CSV', 'PDF');

-- CreateEnum
CREATE TYPE "GapStatus" AS ENUM ('OPEN', 'ANSWERED', 'IGNORED');

-- CreateEnum
CREATE TYPE "FaqSource" AS ENUM ('OWNER', 'KNOWLEDGE_GAP');

-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "aiConversationsLimit" INTEGER,
ADD COLUMN     "aiConversationsThisPeriod" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "assistantTemplateOnlyUntil" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "InstagramAccount" ADD COLUMN     "tokenAlertedAt" TIMESTAMP(3),
ADD COLUMN     "tokenBrokenAt" TIMESTAMP(3),
ADD COLUMN     "tokenCheckedAt" TIMESTAMP(3),
ADD COLUMN     "tokenLastError" TEXT,
ADD COLUMN     "tokenStatus" "TokenStatus" NOT NULL DEFAULT 'ACTIVE';

-- AlterTable
ALTER TABLE "Automation" ADD COLUMN     "handoffToAssistant" BOOLEAN NOT NULL DEFAULT false;

-- CreateTable
CREATE TABLE "Integration" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "type" "IntegrationType" NOT NULL,
    "name" TEXT NOT NULL,
    "status" "IntegrationStatus" NOT NULL DEFAULT 'ACTIVE',
    "credentialsEncrypted" TEXT,
    "config" JSONB NOT NULL DEFAULT '{}',
    "igAccountFilter" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "tokenExpiresAt" TIMESTAMP(3),
    "tokenWarnedAt" TIMESTAMP(3),
    "lastCheckedAt" TIMESTAMP(3),
    "lastError" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Integration_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramChat" (
    "id" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "title" TEXT,
    "type" TEXT NOT NULL DEFAULT 'private',
    "active" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramChat_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramLinkCode" (
    "code" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "purpose" TEXT NOT NULL DEFAULT 'link',
    "userId" TEXT,
    "igAccountId" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TelegramLinkCode_pkey" PRIMARY KEY ("code")
);

-- CreateTable
CREATE TABLE "TelegramUser" (
    "id" TEXT NOT NULL,
    "tgUserId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "language" TEXT NOT NULL DEFAULT 'uz',
    "linkedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramUser_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Conversation" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "igUserId" TEXT NOT NULL,
    "igUsername" TEXT,
    "igName" TEXT,
    "assistantState" "AssistantState" NOT NULL DEFAULT 'NEW',
    "botMessageCount" INTEGER NOT NULL DEFAULT 0,
    "phoneAskCount" INTEGER NOT NULL DEFAULT 0,
    "spamStreak" INTEGER NOT NULL DEFAULT 0,
    "leadCycle" INTEGER NOT NULL DEFAULT 0,
    "operatorActiveUntil" TIMESTAMP(3),
    "botPaused" BOOLEAN NOT NULL DEFAULT false,
    "campaignId" TEXT,
    "source" "LeadSource" NOT NULL DEFAULT 'INBOUND_DM',
    "collected" JSONB NOT NULL DEFAULT '{}',
    "lastCustomerMessageAt" TIMESTAMP(3),
    "lastBotMessageAt" TIMESTAMP(3),
    "lastNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Conversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ConversationMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "mid" TEXT,
    "author" "MessageAuthor" NOT NULL,
    "text" TEXT NOT NULL,
    "llmMeta" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ConversationMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Lead" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT NOT NULL,
    "conversationId" TEXT,
    "igUserId" TEXT NOT NULL,
    "igUsername" TEXT,
    "name" TEXT,
    "phoneE164" TEXT,
    "phoneRaw" TEXT,
    "productInterest" TEXT,
    "extraField" TEXT,
    "language" TEXT,
    "status" "LeadStatus" NOT NULL DEFAULT 'NEW',
    "source" "LeadSource" NOT NULL DEFAULT 'INBOUND_DM',
    "campaignId" TEXT,
    "campaignName" TEXT,
    "triggerKeyword" TEXT,
    "postUrl" TEXT,
    "summary" TEXT,
    "transcript" TEXT,
    "flag" TEXT,
    "isTest" BOOLEAN NOT NULL DEFAULT false,
    "idempotencyKey" TEXT NOT NULL,
    "isRepeat" BOOLEAN NOT NULL DEFAULT false,
    "repeatOfId" TEXT,
    "repeatCount" INTEGER NOT NULL DEFAULT 0,
    "trackedLinkClicked" BOOLEAN NOT NULL DEFAULT false,
    "contactedByUserId" TEXT,
    "contactedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Lead_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LeadDelivery" (
    "id" TEXT NOT NULL,
    "leadId" TEXT NOT NULL,
    "integrationId" TEXT NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "nextAttemptAt" TIMESTAMP(3),
    "lastError" TEXT,
    "externalId" TEXT,
    "externalUrl" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'new',
    "sentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "LeadDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantProfile" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "instagramAccountId" TEXT,
    "enabled" BOOLEAN NOT NULL DEFAULT false,
    "approvedAt" TIMESTAMP(3),
    "companyName" TEXT NOT NULL DEFAULT '',
    "description" TEXT NOT NULL DEFAULT '',
    "pricePolicy" "PricePolicy" NOT NULL DEFAULT 'NEVER',
    "tone" "AssistantTone" NOT NULL DEFAULT 'FRIENDLY',
    "personaName" TEXT,
    "extraFieldLabel" TEXT,
    "finalMessageTemplate" TEXT,
    "handleCampaignReplies" BOOLEAN NOT NULL DEFAULT true,
    "handleInboundDm" BOOLEAN NOT NULL DEFAULT false,
    "operatorPauseHours" INTEGER NOT NULL DEFAULT 24,
    "maxBotMessages" INTEGER NOT NULL DEFAULT 6,
    "fallbackLeadWithoutPhone" BOOLEAN NOT NULL DEFAULT true,
    "postHandoffReply" BOOLEAN NOT NULL DEFAULT false,
    "workingHours" JSONB,
    "offHoursMessage" TEXT,
    "address" TEXT,
    "branches" JSONB,
    "delivery" TEXT,
    "paymentMethods" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "categories" JSONB NOT NULL DEFAULT '[]',
    "source" "ProfileSource" NOT NULL DEFAULT 'PANEL',
    "languageDefault" TEXT NOT NULL DEFAULT 'uz_latn',
    "priceReminderEnabled" BOOLEAN NOT NULL DEFAULT true,
    "priceReminderSentAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantProfile_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantProduct" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "note" TEXT,
    "price" DECIMAL(14,2),
    "priceIsFrom" BOOLEAN NOT NULL DEFAULT false,
    "currency" TEXT NOT NULL DEFAULT 'UZS',
    "unit" TEXT,
    "priceUpdatedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantProduct_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantFaq" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "question" TEXT NOT NULL,
    "answer" TEXT NOT NULL,
    "source" "FaqSource" NOT NULL DEFAULT 'OWNER',
    "sort" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "AssistantFaq_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingSession" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tgUserId" TEXT NOT NULL,
    "igAccountId" TEXT,
    "step" INTEGER NOT NULL DEFAULT 0,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "status" "OnboardingStatus" NOT NULL DEFAULT 'ACTIVE',
    "language" TEXT NOT NULL DEFAULT 'uz',
    "fsm" JSONB NOT NULL DEFAULT '{}',
    "reminderSentAt" TIMESTAMP(3),
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "OnboardingSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OnboardingUpload" (
    "id" TEXT NOT NULL,
    "sessionId" TEXT NOT NULL,
    "kind" "UploadKind" NOT NULL,
    "tgFileId" TEXT NOT NULL,
    "parsed" JSONB,
    "confirmed" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OnboardingUpload_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ProfileChangeLog" (
    "id" TEXT NOT NULL,
    "profileId" TEXT NOT NULL,
    "source" "ProfileSource" NOT NULL,
    "actorUserId" TEXT,
    "field" TEXT NOT NULL,
    "oldValue" JSONB,
    "newValue" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ProfileChangeLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeGap" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "questionNormalized" TEXT NOT NULL,
    "examples" JSONB NOT NULL DEFAULT '[]',
    "hits" INTEGER NOT NULL DEFAULT 1,
    "status" "GapStatus" NOT NULL DEFAULT 'OPEN',
    "answer" TEXT,
    "answeredAt" TIMESTAMP(3),
    "lastNotifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "KnowledgeGap_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "LlmUsage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT,
    "kind" TEXT NOT NULL DEFAULT 'reply',
    "model" TEXT NOT NULL,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6) NOT NULL DEFAULT 0,
    "latencyMs" INTEGER NOT NULL DEFAULT 0,
    "ok" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "LlmUsage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AssistantEvent" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "conversationId" TEXT,
    "type" TEXT NOT NULL,
    "payload" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AssistantEvent_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Integration_workspaceId_type_idx" ON "Integration"("workspaceId", "type");

-- CreateIndex
CREATE INDEX "TelegramChat_chatId_idx" ON "TelegramChat"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramChat_integrationId_chatId_key" ON "TelegramChat"("integrationId", "chatId");

-- CreateIndex
CREATE INDEX "TelegramLinkCode_workspaceId_idx" ON "TelegramLinkCode"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramUser_tgUserId_key" ON "TelegramUser"("tgUserId");

-- CreateIndex
CREATE INDEX "TelegramUser_workspaceId_idx" ON "TelegramUser"("workspaceId");

-- CreateIndex
CREATE INDEX "Conversation_workspaceId_assistantState_idx" ON "Conversation"("workspaceId", "assistantState");

-- CreateIndex
CREATE UNIQUE INDEX "Conversation_instagramAccountId_igUserId_key" ON "Conversation"("instagramAccountId", "igUserId");

-- CreateIndex
CREATE INDEX "ConversationMessage_conversationId_createdAt_idx" ON "ConversationMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "ConversationMessage_conversationId_mid_key" ON "ConversationMessage"("conversationId", "mid");

-- CreateIndex
CREATE UNIQUE INDEX "Lead_idempotencyKey_key" ON "Lead"("idempotencyKey");

-- CreateIndex
CREATE INDEX "Lead_conversationId_idx" ON "Lead"("conversationId");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_phoneE164_createdAt_idx" ON "Lead"("workspaceId", "phoneE164", "createdAt");

-- CreateIndex
CREATE INDEX "Lead_workspaceId_createdAt_idx" ON "Lead"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "LeadDelivery_status_nextAttemptAt_idx" ON "LeadDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "LeadDelivery_integrationId_status_idx" ON "LeadDelivery"("integrationId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "LeadDelivery_leadId_integrationId_kind_key" ON "LeadDelivery"("leadId", "integrationId", "kind");

-- CreateIndex
CREATE INDEX "AssistantProfile_workspaceId_idx" ON "AssistantProfile"("workspaceId");

-- CreateIndex
CREATE INDEX "AssistantProduct_profileId_sort_idx" ON "AssistantProduct"("profileId", "sort");

-- CreateIndex
CREATE INDEX "AssistantFaq_profileId_sort_idx" ON "AssistantFaq"("profileId", "sort");

-- CreateIndex
CREATE INDEX "OnboardingSession_workspaceId_status_idx" ON "OnboardingSession"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "OnboardingSession_tgUserId_status_idx" ON "OnboardingSession"("tgUserId", "status");

-- CreateIndex
CREATE INDEX "OnboardingUpload_sessionId_idx" ON "OnboardingUpload"("sessionId");

-- CreateIndex
CREATE INDEX "ProfileChangeLog_profileId_createdAt_idx" ON "ProfileChangeLog"("profileId", "createdAt");

-- CreateIndex
CREATE INDEX "KnowledgeGap_workspaceId_status_idx" ON "KnowledgeGap"("workspaceId", "status");

-- CreateIndex
CREATE INDEX "LlmUsage_workspaceId_createdAt_idx" ON "LlmUsage"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "AssistantEvent_workspaceId_type_createdAt_idx" ON "AssistantEvent"("workspaceId", "type", "createdAt");

-- AddForeignKey
ALTER TABLE "Integration" ADD CONSTRAINT "Integration_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramChat" ADD CONSTRAINT "TelegramChat_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramLinkCode" ADD CONSTRAINT "TelegramLinkCode_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramUser" ADD CONSTRAINT "TelegramUser_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramUser" ADD CONSTRAINT "TelegramUser_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Conversation" ADD CONSTRAINT "Conversation_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ConversationMessage" ADD CONSTRAINT "ConversationMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Lead" ADD CONSTRAINT "Lead_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "Conversation"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadDelivery" ADD CONSTRAINT "LeadDelivery_leadId_fkey" FOREIGN KEY ("leadId") REFERENCES "Lead"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LeadDelivery" ADD CONSTRAINT "LeadDelivery_integrationId_fkey" FOREIGN KEY ("integrationId") REFERENCES "Integration"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantProfile" ADD CONSTRAINT "AssistantProfile_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantProfile" ADD CONSTRAINT "AssistantProfile_instagramAccountId_fkey" FOREIGN KEY ("instagramAccountId") REFERENCES "InstagramAccount"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantProduct" ADD CONSTRAINT "AssistantProduct_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "AssistantProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantFaq" ADD CONSTRAINT "AssistantFaq_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "AssistantProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingSession" ADD CONSTRAINT "OnboardingSession_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OnboardingUpload" ADD CONSTRAINT "OnboardingUpload_sessionId_fkey" FOREIGN KEY ("sessionId") REFERENCES "OnboardingSession"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ProfileChangeLog" ADD CONSTRAINT "ProfileChangeLog_profileId_fkey" FOREIGN KEY ("profileId") REFERENCES "AssistantProfile"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeGap" ADD CONSTRAINT "KnowledgeGap_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "LlmUsage" ADD CONSTRAINT "LlmUsage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AssistantEvent" ADD CONSTRAINT "AssistantEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

