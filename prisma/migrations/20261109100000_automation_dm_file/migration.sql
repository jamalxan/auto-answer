-- Comment-to-DM campaigns can attach a file (PDF, image, video, audio) to the DM.
ALTER TABLE "Automation" ADD COLUMN "dmFileKey" TEXT,
ADD COLUMN "dmFileName" TEXT,
ADD COLUMN "dmFileMime" TEXT,
ADD COLUMN "dmFileSize" INTEGER;
