-- AlterTable
ALTER TABLE "Integration" ADD COLUMN     "brokenAlertedAt" TIMESTAMP(3),
ADD COLUMN     "healthOkStreak" INTEGER NOT NULL DEFAULT 0;

