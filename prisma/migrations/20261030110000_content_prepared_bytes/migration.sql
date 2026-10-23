-- AlterTable: the size of the Instagram-ready copy (validation applies Instagram's limits to it)
ALTER TABLE "MediaAsset" ADD COLUMN "preparedBytes" INTEGER;
