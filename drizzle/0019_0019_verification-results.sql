CREATE TYPE "public"."block_verification_status" AS ENUM('checking', 'verified', 'unverified', 'regenerated');--> statement-breakpoint
CREATE TABLE "verification_results" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"lesson_id" uuid NOT NULL,
	"block_id" text NOT NULL,
	"status" "block_verification_status" DEFAULT 'checking' NOT NULL,
	"claims_total" integer DEFAULT 0 NOT NULL,
	"claims_verified" integer DEFAULT 0 NOT NULL,
	"details" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "verification_results" ADD CONSTRAINT "verification_results_lesson_id_lessons_id_fk" FOREIGN KEY ("lesson_id") REFERENCES "public"."lessons"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "verification_results_lesson_block" ON "verification_results" USING btree ("lesson_id","block_id");