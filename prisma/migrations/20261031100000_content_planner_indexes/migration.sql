-- Content planner goes to production: indexes for the queries the main dashboard runs.

-- Sweeper: abandoned uploads and stalled processing.
CREATE INDEX IF NOT EXISTS "MediaAsset_status_createdAt_idx" ON "MediaAsset"("status", "createdAt");
CREATE INDEX IF NOT EXISTS "MediaAsset_status_updatedAt_idx" ON "MediaAsset"("status", "updatedAt");

-- Queue stats (groupBy status per workspace), review and failed lists.
CREATE INDEX IF NOT EXISTS "ScheduledPost_workspaceId_status_idx" ON "ScheduledPost"("workspaceId", "status");

-- Story series / recurrence siblings.
CREATE INDEX IF NOT EXISTS "ScheduledPost_seriesId_idx" ON "ScheduledPost"("seriesId");

-- External reviewer link lookup by token hash.
CREATE INDEX IF NOT EXISTS "PostReview_tokenHash_idx" ON "PostReview"("tokenHash");
