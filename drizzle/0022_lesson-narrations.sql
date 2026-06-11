CREATE TABLE "lesson_narrations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lesson_id" uuid NOT NULL,
	"mime_type" text NOT NULL,
	"audio" "bytea" NOT NULL,
	"transcript" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "lesson_narrations_lesson_id_unique" UNIQUE("lesson_id")
);
--> statement-breakpoint
ALTER TABLE "lesson_narrations" ADD CONSTRAINT "lesson_narrations_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;