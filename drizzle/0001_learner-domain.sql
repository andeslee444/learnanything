CREATE TYPE "public"."age_band" AS ENUM('13_15', '16_17', '18_plus');--> statement-breakpoint
CREATE TYPE "public"."expertise_band" AS ENUM('novice', 'developing', 'competent');--> statement-breakpoint
CREATE TYPE "public"."provenance" AS ENUM('consumer', 'school');--> statement-breakpoint
CREATE TYPE "public"."track_status" AS ENUM('active', 'paused', 'completed', 'archived');--> statement-breakpoint
CREATE TYPE "public"."record_status" AS ENUM('active', 'superseded');--> statement-breakpoint
CREATE TYPE "public"."record_type" AS ENUM('demonstrated_understanding', 'prior_knowledge', 'corrected_misconception', 'mission_shift');--> statement-breakpoint
CREATE TYPE "public"."mission_status" AS ENUM('active', 'archived');--> statement-breakpoint
CREATE TYPE "public"."gap_status" AS ENUM('open', 'resolved');--> statement-breakpoint
CREATE TYPE "public"."node_mastery" AS ENUM('not_started', 'in_progress', 'demonstrated', 'mastered');--> statement-breakpoint
CREATE TYPE "public"."ref_doc_type" AS ENUM('cheat_sheet', 'algorithm_flowchart', 'syntax_reference', 'routine', 'sequence', 'glossary_export');--> statement-breakpoint
CREATE TYPE "public"."resource_kind" AS ENUM('knowledge', 'wisdom');--> statement-breakpoint
CREATE TYPE "public"."resource_origin" AS ENUM('exa', 'manual', 'user_upload');--> statement-breakpoint
CREATE TYPE "public"."resource_status" AS ENUM('active', 'pruned');--> statement-breakpoint
CREATE TYPE "public"."resource_type" AS ENUM('book', 'article', 'video', 'docs', 'paper', 'community', 'local');--> statement-breakpoint
CREATE TABLE "learners" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"display_name" text NOT NULL,
	"age_band" "age_band" NOT NULL,
	"provenance" "provenance" DEFAULT 'consumer' NOT NULL,
	"parent_user_id" text,
	"profile" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fsrs_params" real[],
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "learners_user_id_unique" UNIQUE("user_id")
);
--> statement-breakpoint
CREATE TABLE "tracks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learner_id" uuid NOT NULL,
	"topic" text NOT NULL,
	"vertical" text NOT NULL,
	"status" "track_status" DEFAULT 'active' NOT NULL,
	"expertise_band" "expertise_band" DEFAULT 'novice' NOT NULL,
	"community_opt_out" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "glossary_terms" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"term" text NOT NULL,
	"definition" text NOT NULL,
	"avoid_aliases" text[] DEFAULT '{}' NOT NULL,
	"cluster" text,
	"ambiguity_note" text,
	"promotion_evidence_record_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "learning_records" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"seq" integer NOT NULL,
	"record_type" "record_type" NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"evidence" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"implications" text,
	"status" "record_status" DEFAULT 'active' NOT NULL,
	"superseded_by_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "mission_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"prior_snapshot" jsonb NOT NULL,
	"reason" text NOT NULL,
	"linked_learning_record_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "missions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"why_text" text NOT NULL,
	"success_criteria" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"constraints" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"out_of_scope" text[] DEFAULT '{}' NOT NULL,
	"status" "mission_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "missions_track_id_unique" UNIQUE("track_id")
);
--> statement-breakpoint
CREATE TABLE "reference_docs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"title" text NOT NULL,
	"doc_type" "ref_doc_type" NOT NULL,
	"content" jsonb NOT NULL,
	"linked_lesson_ids" uuid[] DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resource_gaps" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"description" text NOT NULL,
	"status" "gap_status" DEFAULT 'open' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "resources" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"url" text,
	"title" text NOT NULL,
	"resource_type" "resource_type" NOT NULL,
	"kind" "resource_kind" NOT NULL,
	"annotation" text NOT NULL,
	"trust_rationale" text,
	"status" "resource_status" DEFAULT 'active' NOT NULL,
	"pruned_reason" text,
	"origin" "resource_origin" NOT NULL,
	"last_verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skill_node_edges" (
	"node_id" uuid NOT NULL,
	"prereq_id" uuid NOT NULL,
	CONSTRAINT "skill_node_edges_node_id_prereq_id_pk" PRIMARY KEY("node_id","prereq_id")
);
--> statement-breakpoint
CREATE TABLE "skill_nodes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"track_id" uuid NOT NULL,
	"name" text NOT NULL,
	"summary" text,
	"mission_relevance" real DEFAULT 0.5 NOT NULL,
	"mastery" "node_mastery" DEFAULT 'not_started' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "learners" ADD CONSTRAINT "learners_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learners" ADD CONSTRAINT "learners_parent_user_id_user_id_fk" FOREIGN KEY ("parent_user_id") REFERENCES "public"."user"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tracks" ADD CONSTRAINT "tracks_learner_id_learners_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glossary_terms" ADD CONSTRAINT "glossary_terms_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "glossary_terms" ADD CONSTRAINT "glossary_terms_promotion_evidence_record_id_learning_records_id_fk" FOREIGN KEY ("promotion_evidence_record_id") REFERENCES "public"."learning_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_records" ADD CONSTRAINT "learning_records_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "learning_records" ADD CONSTRAINT "learning_records_superseded_by_id_learning_records_id_fk" FOREIGN KEY ("superseded_by_id") REFERENCES "public"."learning_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_revisions" ADD CONSTRAINT "mission_revisions_mission_id_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "mission_revisions" ADD CONSTRAINT "mission_revisions_linked_learning_record_id_learning_records_id_fk" FOREIGN KEY ("linked_learning_record_id") REFERENCES "public"."learning_records"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "missions" ADD CONSTRAINT "missions_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "reference_docs" ADD CONSTRAINT "reference_docs_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resource_gaps" ADD CONSTRAINT "resource_gaps_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_node_edges" ADD CONSTRAINT "skill_node_edges_node_id_skill_nodes_id_fk" FOREIGN KEY ("node_id") REFERENCES "public"."skill_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_node_edges" ADD CONSTRAINT "skill_node_edges_prereq_id_skill_nodes_id_fk" FOREIGN KEY ("prereq_id") REFERENCES "public"."skill_nodes"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_nodes" ADD CONSTRAINT "skill_nodes_track_id_tracks_id_fk" FOREIGN KEY ("track_id") REFERENCES "public"."tracks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "glossary_terms_track_term" ON "glossary_terms" USING btree ("track_id","term");--> statement-breakpoint
CREATE UNIQUE INDEX "learning_records_track_seq" ON "learning_records" USING btree ("track_id","seq");