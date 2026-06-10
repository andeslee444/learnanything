CREATE TYPE "public"."trust_tier" AS ENUM('tier1', 'tier2', 'tier3', 'blocked');--> statement-breakpoint
CREATE TABLE "topic_dossiers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vertical" text NOT NULL,
	"topic" text NOT NULL,
	"level_band" "expertise_band" NOT NULL,
	"embedding" vector(1536) NOT NULL,
	"sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"claims" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"glossary_seeds" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"misconceptions" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"model_version" text,
	"ttl_expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "trust_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"vertical" text,
	"domain" text NOT NULL,
	"tier" "trust_tier" NOT NULL,
	"note" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "trust_domains_vertical_domain" UNIQUE NULLS NOT DISTINCT("vertical","domain")
);
--> statement-breakpoint
CREATE INDEX "topic_dossiers_embedding" ON "topic_dossiers" USING hnsw ("embedding" vector_cosine_ops);