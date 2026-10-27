-- Audit 2026-10-26: why a failed LLM call failed (LlmErrorKind, "bad_json" or "internal").
ALTER TABLE "LlmUsage" ADD COLUMN IF NOT EXISTS "errorKind" TEXT;
