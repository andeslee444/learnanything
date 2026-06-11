-- Add workflow_run_id column to lessons for direct lookup (stream route reads column ?? snapshot).
-- Nullable: existing rows keep working via the zpd_snapshot fallback.
ALTER TABLE "lessons" ADD COLUMN IF NOT EXISTS "workflow_run_id" text;
