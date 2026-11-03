-- Facebook / Threads auto-reply rules can carry a file (Messenger attachment or Threads reply image).
ALTER TABLE "ChannelAutoReply" ADD COLUMN "fileKey" TEXT,
ADD COLUMN "fileName" TEXT,
ADD COLUMN "fileMime" TEXT,
ADD COLUMN "fileSize" INTEGER;
