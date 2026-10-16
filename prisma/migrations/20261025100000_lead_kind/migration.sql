-- Lead quality (B-31): distinguish real leads from bare contacts. Additive.
ALTER TABLE "Lead" ADD COLUMN "kind" TEXT NOT NULL DEFAULT 'LEAD';
