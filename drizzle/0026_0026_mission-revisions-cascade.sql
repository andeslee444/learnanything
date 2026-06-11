ALTER TABLE "mission_revisions" DROP CONSTRAINT "mission_revisions_linked_learning_record_id_learning_records_id_fk";
--> statement-breakpoint
ALTER TABLE "mission_revisions" ADD CONSTRAINT "mission_revisions_linked_learning_record_id_learning_records_id_fk" FOREIGN KEY ("linked_learning_record_id") REFERENCES "public"."learning_records"("id") ON DELETE set null ON UPDATE no action;