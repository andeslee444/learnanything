-- Add vertical (from the source track) and badge_snapshot (verification summary snapshot)
-- to shared_lessons.  Both are non-nullable in new rows; existing rows (none in prod yet,
-- only Phase-1 schema stub) get safe defaults so the migration is replay-safe.

ALTER TABLE "shared_lessons"
  ADD COLUMN IF NOT EXISTS "vertical" text NOT NULL DEFAULT '',
  ADD COLUMN IF NOT EXISTS "badge_snapshot" jsonb NOT NULL DEFAULT '{}';
