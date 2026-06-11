ALTER TABLE "shared_lessons" ADD COLUMN "vertical" text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_lessons" ADD COLUMN "badge_snapshot" jsonb DEFAULT '{}' NOT NULL;