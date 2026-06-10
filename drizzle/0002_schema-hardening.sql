CREATE UNIQUE INDEX "learning_records_id_track" ON "learning_records" USING btree ("id","track_id");
--> statement-breakpoint
CREATE INDEX "tracks_learner_id" ON "tracks" USING btree ("learner_id");
--> statement-breakpoint
CREATE INDEX "learning_records_track_status" ON "learning_records" USING btree ("track_id","status");
--> statement-breakpoint
ALTER TABLE "glossary_terms" DROP CONSTRAINT "glossary_terms_promotion_evidence_record_id_learning_records_id_fk";
--> statement-breakpoint
ALTER TABLE "glossary_terms" ADD CONSTRAINT "glossary_terms_evidence_same_track_fk" FOREIGN KEY ("promotion_evidence_record_id","track_id") REFERENCES "public"."learning_records"("id","track_id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "resources" ADD CONSTRAINT "resources_exa_requires_url" CHECK ("resources"."origin" <> 'exa' OR "resources"."url" IS NOT NULL);
--> statement-breakpoint
ALTER TABLE "skill_node_edges" ADD CONSTRAINT "skill_node_edges_no_self_loop" CHECK ("skill_node_edges"."node_id" <> "skill_node_edges"."prereq_id");