ALTER TABLE "learners" DROP CONSTRAINT "learners_parent_user_id_user_id_fk";
--> statement-breakpoint
ALTER TABLE "learners" ADD CONSTRAINT "learners_parent_user_id_user_id_fk" FOREIGN KEY ("parent_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;