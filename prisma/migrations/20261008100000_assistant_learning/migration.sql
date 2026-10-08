-- AlterTable
ALTER TABLE "AssistantProfile" ADD COLUMN     "learnedAt" TIMESTAMP(3),
ADD COLUMN     "learnedDialogues" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN     "learnedExamples" JSONB NOT NULL DEFAULT '[]',
ADD COLUMN     "learnedStyle" TEXT,
ADD COLUMN     "learningEnabled" BOOLEAN NOT NULL DEFAULT false;

