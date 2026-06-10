ALTER TABLE "lessons" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
ALTER TABLE "shared_lessons" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;--> statement-breakpoint
CREATE INDEX "attempt_events_learner_lesson" ON "attempt_events" USING btree ("learner_id","lesson_id");--> statement-breakpoint
CREATE INDEX "lessons_track_status" ON "lessons" USING btree ("track_id","status");