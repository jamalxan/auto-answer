-- ETAP 12 MCP / AI control layer (developer area). Additive only: new enums and tables.


-- CreateEnum
CREATE TYPE "McpScope" AS ENUM ('READ', 'WRITE');

-- CreateEnum
CREATE TYPE "McpActionStatus" AS ENUM ('PROPOSED', 'CONFIRMED', 'EXECUTED', 'REJECTED', 'EXPIRED', 'FAILED');

-- CreateTable
CREATE TABLE "McpToken" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "tokenHash" TEXT NOT NULL,
    "tokenHint" TEXT NOT NULL,
    "scope" "McpScope" NOT NULL DEFAULT 'READ',
    "requireHumanApproval" BOOLEAN NOT NULL DEFAULT true,
    "createdByUserId" TEXT,
    "lastUsedAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpAction" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "tokenId" TEXT NOT NULL,
    "tool" TEXT NOT NULL,
    "input" JSONB NOT NULL,
    "preview" JSONB NOT NULL,
    "status" "McpActionStatus" NOT NULL DEFAULT 'PROPOSED',
    "confirmCodeHash" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "result" JSONB,
    "error" TEXT,
    "failedAttempts" INTEGER NOT NULL DEFAULT 0,
    "approvedBy" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "resolvedAt" TIMESTAMP(3),

    CONSTRAINT "McpAction_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "McpToken_tokenHash_key" ON "McpToken"("tokenHash");

-- CreateIndex
CREATE INDEX "McpToken_workspaceId_createdAt_idx" ON "McpToken"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "McpAction_workspaceId_createdAt_idx" ON "McpAction"("workspaceId", "createdAt");

-- CreateIndex
CREATE INDEX "McpAction_tokenId_status_idx" ON "McpAction"("tokenId", "status");

-- AddForeignKey
ALTER TABLE "McpToken" ADD CONSTRAINT "McpToken_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpAction" ADD CONSTRAINT "McpAction_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpAction" ADD CONSTRAINT "McpAction_tokenId_fkey" FOREIGN KEY ("tokenId") REFERENCES "McpToken"("id") ON DELETE CASCADE ON UPDATE CASCADE;

