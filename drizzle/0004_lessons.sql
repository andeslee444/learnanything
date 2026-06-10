CREATE TYPE "public"."lesson_status" AS ENUM('generating', 'queued', 'ready', 'failed', 'needs_review');--> statement-breakpoint
CREATE TYPE "public"."moderation_status" AS ENUM('pending', 'approved', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('pending', 'verified', 'issues');--> statement-breakpoint
CREATE TABLE "attempt_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learner_id" uuid NOT NULL,
	"lesson_id" uuid,
	"block_id" text,
	"event_type" text NOT NULL,
	"correct" boolean,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"spec" jsonb NOT NULL,
	"content" jsonb,
	"citations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" "lesson_status" DEFAULT 'generating' NOT NULL,
	"verification_status" "verification_status" DEFAULT 'pending' NOT NULL,
	"faithfulness_score" real,
	"zpd_snapshot" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"model_version" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "shared_lessons" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lesson_id" uuid NOT NULL,
	"sanitized_content" jsonb NOT NULL,
	"slug" text NOT NULL,
	"moderation_status" "moderation_status" DEFAULT 'pending' NOT NULL,
	"verification_status" "verification_status" DEFAULT 'pending' NOT NULL,
	"published_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shared_lessons_lesson_id_unique" UNIQUE("lesson_id"),
	CONSTRAINT "shared_lessons_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_learner_id_learners_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempt_events" ADD CONSTRAINT "attempt_events_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "lessons" ADD CONSTRAINT "lessons_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "shared_lessons" ADD CONSTRAINT "shared_lessons_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "lessons_track_seq" ON "lessons" USING btree ("track_id","seq");