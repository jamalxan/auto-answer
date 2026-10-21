-- ETAP 12 MCP: OAuth 2.1 (dynamic client registration + authorization code with PKCE)
-- so Claude.ai / Claude Desktop / ChatGPT connectors can connect directly. Additive only.

-- AlterTable
ALTER TABLE "McpToken" ADD COLUMN     "oauthClientId" TEXT,
ADD COLUMN     "refreshTokenHash" TEXT,
ADD COLUMN     "refreshExpiresAt" TIMESTAMP(3);

-- CreateTable
CREATE TABLE "McpOAuthClient" (
    "id" TEXT NOT NULL,
    "clientName" TEXT NOT NULL,
    "redirectUris" TEXT[],
    "tokenEndpointAuthMethod" TEXT NOT NULL DEFAULT 'none',
    "clientSecretHash" TEXT,
    "clientUri" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "lastUsedAt" TIMESTAMP(3),

    CONSTRAINT "McpOAuthClient_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "McpAuthCode" (
    "id" TEXT NOT NULL,
    "codeHash" TEXT NOT NULL,
    "clientId" TEXT NOT NULL,
    "redirectUri" TEXT NOT NULL,
    "codeChallenge" TEXT NOT NULL,
    "codeChallengeMethod" TEXT NOT NULL DEFAULT 'S256',
    "scope" "McpScope" NOT NULL DEFAULT 'READ',
    "requireHumanApproval" BOOLEAN NOT NULL DEFAULT true,
    "workspaceId" TEXT NOT NULL,
    "userId" TEXT NOT NULL,
    "resource" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "usedAt" TIMESTAMP(3),
    "issuedTokenId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "McpAuthCode_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "McpToken_refreshTokenHash_key" ON "McpToken"("refreshTokenHash");

-- CreateIndex
CREATE INDEX "McpOAuthClient_createdAt_idx" ON "McpOAuthClient"("createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "McpAuthCode_codeHash_key" ON "McpAuthCode"("codeHash");

-- CreateIndex
CREATE INDEX "McpAuthCode_clientId_createdAt_idx" ON "McpAuthCode"("clientId", "createdAt");

-- CreateIndex
CREATE INDEX "McpAuthCode_expiresAt_idx" ON "McpAuthCode"("expiresAt");

-- AddForeignKey
ALTER TABLE "McpToken" ADD CONSTRAINT "McpToken_oauthClientId_fkey" FOREIGN KEY ("oauthClientId") REFERENCES "McpOAuthClient"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "McpAuthCode" ADD CONSTRAINT "McpAuthCode_clientId_fkey" FOREIGN KEY ("clientId") REFERENCES "McpOAuthClient"("id") ON DELETE CASCADE ON UPDATE CASCADE;
