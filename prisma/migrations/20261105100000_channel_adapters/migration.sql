-- AlterTable
ALTER TABLE "ChannelCredential" ADD COLUMN "pollCursor" TIMESTAMP(3);

-- AlterTable
ALTER TABLE "ChannelPostTarget" ADD COLUMN "nextAttemptAt" TIMESTAMP(3),
ADD COLUMN "pollStartedAt" TIMESTAMP(3),
ADD COLUMN "pollToken" TEXT;

-- CreateTable
CREATE TABLE "ChannelPrivateReply" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "commentId" TEXT NOT NULL,
    "credentialId" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'SENDING',
    "externalId" TEXT,
    "error" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelPrivateReply_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelPrivateReply_workspaceId_idx" ON "ChannelPrivateReply"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelPrivateReply_channel_commentId_key" ON "ChannelPrivateReply"("channel", "commentId");

-- AddForeignKey
ALTER TABLE "ChannelPrivateReply" ADD CONSTRAINT "ChannelPrivateReply_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;
