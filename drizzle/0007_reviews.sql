CREATE TABLE "concept_ability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learner_id" uuid NOT NULL,
	"concept_key" text NOT NULL,
	"rating" real DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "item_difficulty" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"item_key" text NOT NULL,
	"difficulty" real DEFAULT 0 NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "item_difficulty_item_key_unique" UNIQUE("item_key")
);
--> statement-breakpoint
CREATE TABLE "review_cards" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"learner_id" uuid NOT NULL,
	"glossary_term_id" uuid,
	"learning_record_id" uuid,
	"due" timestamp with time zone NOT NULL,
	"stability" real DEFAULT 0 NOT NULL,
	"difficulty" real DEFAULT 0 NOT NULL,
	"elapsed_days" integer DEFAULT 0 NOT NULL,
	"scheduled_days" integer DEFAULT 0 NOT NULL,
	"learning_steps" integer DEFAULT 0 NOT NULL,
	"reps" integer DEFAULT 0 NOT NULL,
	"lapses" integer DEFAULT 0 NOT NULL,
	"state" smallint DEFAULT 0 NOT NULL,
	"last_review" timestamp with time zone,
	CONSTRAINT "review_cards_one_source" CHECK (("review_cards"."glossary_term_id" IS NOT NULL) <> ("review_cards"."learning_record_id" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "review_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"card_id" uuid NOT NULL,
	"rating" smallint NOT NULL,
	"state" smallint NOT NULL,
	"due" timestamp with time zone NOT NULL,
	"stability" real NOT NULL,
	"difficulty" real NOT NULL,
	"elapsed_days" integer NOT NULL,
	"scheduled_days" integer NOT NULL,
	"reviewed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "concept_ability" ADD CONSTRAINT "concept_ability_learner_id_learners_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cards" ADD CONSTRAINT "review_cards_learner_id_learners_id_fk" FOREIGN KEY ("learner_id") REFERENCES "public"."learners"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cards" ADD CONSTRAINT "review_cards_glossary_term_id_glossary_terms_id_fk" FOREIGN KEY ("glossary_term_id") REFERENCES "public"."glossary_terms"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_cards" ADD CONSTRAINT "review_cards_learning_record_id_learning_records_id_fk" FOREIGN KEY ("learning_record_id") REFERENCES "public"."learning_records"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_log" ADD CONSTRAINT "review_log_card_id_review_cards_id_fk" FOREIGN KEY ("card_id") REFERENCES "public"."review_cards"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_cards_learner_due" ON "review_cards" USING btree ("learner_id","due");