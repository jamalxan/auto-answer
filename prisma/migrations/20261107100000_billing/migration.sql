-- AlterTable
ALTER TABLE "Workspace" ADD COLUMN     "planExpiresAt" TIMESTAMP(3),
ADD COLUMN     "planSlug" TEXT NOT NULL DEFAULT 'start';

-- CreateTable
CREATE TABLE "Payment" (
    "id" TEXT NOT NULL,
    "workspaceId" TEXT NOT NULL,
    "plan" TEXT NOT NULL,
    "months" INTEGER NOT NULL,
    "amountTiyin" INTEGER NOT NULL,
    "provider" TEXT NOT NULL,
    "status" TEXT NOT NULL DEFAULT 'CREATED',
    "providerTransId" TEXT,
    "state" INTEGER NOT NULL DEFAULT 0,
    "providerTime" TIMESTAMP(3),
    "performedAt" TIMESTAMP(3),
    "canceledAt" TIMESTAMP(3),
    "cancelReason" INTEGER,
    "createdById" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Payment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "Payment_workspaceId_createdAt_idx" ON "Payment"("workspaceId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Payment_provider_providerTransId_key" ON "Payment"("provider", "providerTransId");

-- AddForeignKey
ALTER TABLE "Payment" ADD CONSTRAINT "Payment_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

