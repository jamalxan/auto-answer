-- CreateEnum
CREATE TYPE "TelegramChannelStatus" AS ENUM ('ACTIVE', 'MISSING_RIGHTS', 'REMOVED');

-- CreateEnum
CREATE TYPE "ChannelPostTargetStatus" AS ENUM ('PENDING', 'PUBLISHING', 'PUBLISHED', 'FAILED', 'SKIPPED', 'DELETED');

-- CreateTable
CREATE TABLE "TelegramChannel" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "title" TEXT,
    "username" TEXT,
    "linkedChatId" TEXT,
    "discussionReady" BOOLEAN NOT NULL DEFAULT false,
    "dmChatId" TEXT,
    "addedByTgUserId" TEXT NOT NULL,
    "status" "TelegramChannelStatus" NOT NULL DEFAULT 'ACTIVE',
    "rights" JSONB NOT NULL DEFAULT '{}',
    "missingRights" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramChannel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TelegramBusinessConnection" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "connectionId" TEXT NOT NULL,
    "tgUserId" TEXT NOT NULL,
    "userChatId" TEXT NOT NULL,
    "canReply" BOOLEAN NOT NULL DEFAULT false,
    "isEnabled" BOOLEAN NOT NULL DEFAULT true,
    "rights" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "TelegramBusinessConnection_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelMessage" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "accountRef" TEXT NOT NULL,
    "kind" TEXT NOT NULL,
    "chatId" TEXT NOT NULL,
    "threadRef" TEXT NOT NULL,
    "externalId" TEXT NOT NULL,
    "direction" TEXT NOT NULL DEFAULT 'IN',
    "authorRef" TEXT,
    "authorName" TEXT,
    "text" TEXT NOT NULL DEFAULT '',
    "replyToExternalId" TEXT,
    "sentByUserId" TEXT,
    "editedAt" TIMESTAMP(3),
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ChannelPostTarget" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "postId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "accountRef" TEXT NOT NULL,
    "status" "ChannelPostTargetStatus" NOT NULL DEFAULT 'PENDING',
    "externalIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "attempts" INTEGER NOT NULL DEFAULT 0,
    "lastError" TEXT,
    "publishedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelPostTarget_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "TelegramChannel_chatId_key" ON "TelegramChannel"("chatId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramChannel_dmChatId_key" ON "TelegramChannel"("dmChatId");

-- CreateIndex
CREATE INDEX "TelegramChannel_workspaceId_idx" ON "TelegramChannel"("workspaceId");

-- CreateIndex
CREATE INDEX "TelegramChannel_linkedChatId_idx" ON "TelegramChannel"("linkedChatId");

-- CreateIndex
CREATE UNIQUE INDEX "TelegramBusinessConnection_connectionId_key" ON "TelegramBusinessConnection"("connectionId");

-- CreateIndex
CREATE INDEX "TelegramBusinessConnection_workspaceId_idx" ON "TelegramBusinessConnection"("workspaceId");

-- CreateIndex
CREATE INDEX "ChannelMessage_workspaceId_createdAt_idx" ON "ChannelMessage"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "ChannelMessage_workspaceId_accountRef_threadRef_idx" ON "ChannelMessage"("workspaceId", "accountRef", "threadRef");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelMessage_channel_chatId_externalId_key" ON "ChannelMessage"("channel", "chatId", "externalId");

-- CreateIndex
CREATE INDEX "ChannelPostTarget_status_updatedAt_idx" ON "ChannelPostTarget"("status", "updatedAt");

-- CreateIndex
CREATE INDEX "ChannelPostTarget_workspaceId_idx" ON "ChannelPostTarget"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelPostTarget_postId_channel_accountRef_key" ON "ChannelPostTarget"("postId", "channel", "accountRef");

-- AddForeignKey
ALTER TABLE "TelegramChannel" ADD CONSTRAINT "TelegramChannel_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TelegramBusinessConnection" ADD CONSTRAINT "TelegramBusinessConnection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelMessage" ADD CONSTRAINT "ChannelMessage_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelPostTarget" ADD CONSTRAINT "ChannelPostTarget_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ChannelPostTarget" ADD CONSTRAINT "ChannelPostTarget_postId_fkey" FOREIGN KEY ("postId") REFERENCES "ScheduledPost"("id") ON DELETE CASCADE ON UPDATE CASCADE;

