-- B-28: every webhook item is logged as an InstagramEvent (status IGNORED when no automation matches).
ALTER TYPE "InstagramEventType" ADD VALUE IF NOT EXISTS 'ECHO';
ALTER TYPE "InstagramEventType" ADD VALUE IF NOT EXISTS 'POSTBACK';
ALTER TYPE "InstagramEventType" ADD VALUE IF NOT EXISTS 'OTHER';
