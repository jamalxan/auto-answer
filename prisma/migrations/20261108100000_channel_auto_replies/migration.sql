-- Auto-replies for Facebook, Threads and YouTube.

CREATE TABLE "ChannelAutoReply" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "credentialId" TEXT,
    "name" TEXT NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "appliesTo" TEXT NOT NULL DEFAULT 'comment',
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "wholeWord" BOOLEAN NOT NULL DEFAULT true,
    "doPublic" BOOLEAN NOT NULL DEFAULT true,
    "doPrivate" BOOLEAN NOT NULL DEFAULT false,
    "publicReplies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "privateReplies" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "useAi" BOOLEAN NOT NULL DEFAULT false,
    "aiInstruction" TEXT,
    "priority" INTEGER NOT NULL DEFAULT 0,
    "sentCount" INTEGER NOT NULL DEFAULT 0,
    "lastFiredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelAutoReply_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "ChannelAutoReplyLog" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "messageId" TEXT NOT NULL,
    "ruleId" TEXT,
    "status" TEXT NOT NULL,
    "actions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "usedAi" BOOLEAN NOT NULL DEFAULT false,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ChannelAutoReplyLog_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ChannelAutoReply_workspaceId_channel_enabled_idx" ON "ChannelAutoReply"("workspaceId", "channel", "enabled");
CREATE UNIQUE INDEX "ChannelAutoReplyLog_messageId_key" ON "ChannelAutoReplyLog"("messageId");
CREATE INDEX "ChannelAutoReplyLog_workspaceId_createdAt_idx" ON "ChannelAutoReplyLog"("workspaceId", "createdAt");
CREATE INDEX "ChannelAutoReplyLog_credentialId_createdAt_idx" ON "ChannelAutoReplyLog"("credentialId", "createdAt");

ALTER TABLE "ChannelAutoReply" ADD CONSTRAINT "ChannelAutoReply_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "ChannelAutoReplyLog" ADD CONSTRAINT "ChannelAutoReplyLog_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
