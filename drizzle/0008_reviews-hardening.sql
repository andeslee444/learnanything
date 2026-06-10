ALTER TABLE "review_log" ADD COLUMN "last_elapsed_days" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "review_log" ADD COLUMN "learning_steps" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "concept_ability_learner_concept" ON "concept_ability" USING btree ("learner_id","concept_key");