-- CreateEnum
CREATE TYPE "ChannelCredentialStatus" AS ENUM ('ACTIVE', 'EXPIRING', 'REVOKED', 'ERROR');

-- CreateTable
CREATE TABLE "ChannelCredential" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "channel" TEXT NOT NULL,
    "externalAccountId" TEXT NOT NULL,
    "label" TEXT,
    "encryptedPayload" TEXT NOT NULL,
    "dekEncrypted" TEXT NOT NULL,
    "keyVersion" INTEGER NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "expiresAt" TIMESTAMP(3),
    "refreshedAt" TIMESTAMP(3),
    "checkedAt" TIMESTAMP(3),
    "status" "ChannelCredentialStatus" NOT NULL DEFAULT 'ACTIVE',
    "lastErrorCode" TEXT,
    "lastErrorAt" TIMESTAMP(3),
    "alertedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "ChannelCredential_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "ChannelCredential_status_expiresAt_idx" ON "ChannelCredential"("status", "expiresAt");

-- CreateIndex
CREATE UNIQUE INDEX "ChannelCredential_workspaceId_channel_externalAccountId_key" ON "ChannelCredential"("workspaceId", "channel", "externalAccountId");

-- AddForeignKey
ALTER TABLE "ChannelCredential" ADD CONSTRAINT "ChannelCredential_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

